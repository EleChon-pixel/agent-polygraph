import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { analyzeSession } from "../src/analyze.js";
import { runHook } from "../src/guard.js";
import { applyRecords, snapshot, treeDiff, installShell, shellScript, terminalFile } from "../src/record.js";

process.env.AGENT_POLYGRAPH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "apg-regressions-"));
const session = (events, cwd = "/repo") => ({ agent: "codex", id: "regression", models: [], cwd, start: 1000, end: 9000, events });
const cmd = (command, ts, workdir = "/repo") => ({ kind: "cmd", cmd: command, ts, workdir });
const result = (of, failed = false) => ({ kind: "result", of, ts: of.ts + 1, output: failed ? "1 failed in 0.1s" : "1 passed in 0.1s", exitCode: failed ? 1 : 0 });
const edit = (ts, p = "/repo/src/main.js") => ({ kind: "edit", ts, path: p });
const say = (text) => ({ kind: "say", ts: 8000, text });

test("each sentence gets its own verdict; the guard quotes the failing claim", async () => {
  const a = cmd("pytest tests/test_one.py", 2000), b = cmd("pytest tests/test_two.py", 3000);
  const final = say("test_one.py passes. test_two.py passes.");
  const s = analyzeSession(session([a, result(a), b, result(b, true), final]));
  assert.equal(s.claims.backed, 1);
  assert.equal(s.claims.failed, 1);
  assert.equal(final.verdict, "failed");
  const records = [];
  for (const [i, c, failed] of [[1, a, false], [3, b, true]]) {
    records.push({ type: "assistant", timestamp: new Date(i * 1000).toISOString(), cwd: "/repo", message: { content: [{ type: "tool_use", id: String(i), name: "Bash", input: { command: c.cmd } }] } },
      { type: "user", timestamp: new Date((i + 1) * 1000).toISOString(), cwd: "/repo", message: { content: [{ type: "tool_result", tool_use_id: String(i), content: result(c, failed).output }] } });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apg-multi-"));
  const file = path.join(dir, "s.jsonl");
  fs.writeFileSync(file, records.map(JSON.stringify).join("\n"));
  const block = await runHook(JSON.stringify({ transcript_path: file, last_assistant_message: final.text }));
  assert.equal(block?.decision, "block");
  assert.match(block.reason, /says "test_two.py passes\."/);
  // The inverse ordering must still block and must not quote the backed claim.
  const inverse = await runHook(JSON.stringify({ transcript_path: file, last_assistant_message: "test_two.py passes. test_one.py passes." }));
  assert.match(inverse.reason, /says "test_two.py passes\."/);
});

test("a different checkout's pass cannot back work in this checkout", () => {
  const unrelated = cmd("pytest", 3000, "/other-worktree");
  const s = analyzeSession(session([edit(2000), unrelated, result(unrelated), say("All tests pass.")]));
  assert.equal(s.claims.backed, 0);
  assert.equal(s.claims.unknown, 1);
  assert.equal(s.unclear["test ran outside the session checkout"], 1);
  const nested = cmd("pytest", 3000, "/workspace/other-project");
  assert.equal(analyzeSession(session([edit(2000, "/workspace/project/src/main.js"), nested, result(nested), say("All tests pass.")], "/workspace")).claims.unknown, 1);
  // Deliberate work outside the starting directory remains usable evidence.
  assert.equal(analyzeSession(session([edit(2000, "/other-worktree/src/main.js"), unrelated, result(unrelated), say("All tests pass.")])).claims.backed, 1);
});

test("terminal receipts with unknown scope never establish full-suite coverage", () => {
  const check = (scope, text = "The full suite passes.") => {
    const s = session([edit(2000), say(text)]);
    applyRecords(s, { terminal: [{ start: 3, end: 4, exit: 0, cwd: "/repo", runner: "pytest", scope }] });
    return analyzeSession(s);
  };
  assert.equal(check(undefined).claims.unknown, 1, "older category-only receipts have no scope evidence");
  assert.equal(check("unknown").claims.unknown, 1);
  assert.equal(check("full").claims.backed, 1);
  assert.equal(check("unknown", "Tests pass.").claims.backed, 1, "a generic claim may refer to the targeted run");
});

test("shell recording retains safe scope without storing command arguments", { skip: process.platform === "win32" }, () => {
  const previousHome = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "apg-shell-home-"));
  try {
  installShell();
  const script = 'source "$APG_SCRIPT"; __apg_pre "pytest tests/private_name.py -k secret"; true; __apg_post; __apg_pre "pytest -q"; true; __apg_post';
  const env = { ...process.env, APG_SCRIPT: shellScript() };
  for (const key of ["CLAUDECODE", "CODEX_SANDBOX", "CODEX_THREAD_ID", "CODEX_MANAGED_BY_NPM"]) delete env[key];
  const p = spawnSync("bash", ["--noprofile", "--norc", "-ic", script], { env, encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr);
  const text = fs.readFileSync(terminalFile(), "utf8");
  const rows = text.trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.map((r) => r.scope), ["unknown", "full"]);
  assert.ok(!text.includes("private_name") && !text.includes("secret"));
  } finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; }
});

test("snapshots taken in subdirectories cover the same root-relative source files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apg-subdir-"));
  execFileSync("git", ["init", "-q", root]);
  fs.mkdirSync(path.join(root, "pkg"));
  fs.writeFileSync(path.join(root, "pkg", "app.js"), "const x = 1;\n");
  fs.writeFileSync(path.join(root, "other.js"), "const other = 1;\n");
  const before = snapshot(root);
  const nested = snapshot(path.join(root, "pkg"));
  assert.equal(nested.complete, true);
  assert.deepEqual(nested, before);
  fs.writeFileSync(path.join(root, "pkg", "app.js"), "const x = 2;\n");
  assert.deepEqual(treeDiff(before, snapshot(path.join(root, "pkg"))), ["pkg/app.js"]);
});

test("subagent runs retain their own checkout in both transcript formats", async () => {
  const { parse: claude } = await import("../src/sources/claude.js");
  const { parse: codex } = await import("../src/sources/codex.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apg-worktrees-"));
  const write = (name, records) => {
    const file = path.join(dir, name + ".jsonl");
    fs.writeFileSync(file, records.map(JSON.stringify).join("\n"));
    return file;
  };
  const ts = (n) => new Date(n * 1000).toISOString();
  const parent = write("claude-parent", [{ type: "user", timestamp: ts(1), cwd: "/repo", message: { content: "Fix code" } }]);
  const child = write("claude-child", [
    { type: "assistant", timestamp: ts(2), cwd: "/other-worktree", message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "pytest" } }] } },
    { type: "user", timestamp: ts(3), cwd: "/other-worktree", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "1 passed in 0.1s" }] } },
  ]);
  const cp = await claude({ id: "p", files: [parent, child] });
  assert.equal(cp.events.find((e) => e.kind === "cmd").workdir, "/other-worktree");
  cp.events.push(say("All tests pass."));
  assert.equal(analyzeSession(cp).claims.unknown, 1);
  const meta = (cwd) => ({ type: "session_meta", timestamp: ts(1), payload: { cwd, id: cwd } });
  const cxp = write("codex-parent", [meta("/repo")]);
  const cxc = write("codex-child", [meta("/other-worktree"),
    { type: "response_item", timestamp: ts(2), payload: { type: "function_call", name: "exec_command", call_id: "x", arguments: JSON.stringify({ cmd: "pytest" }) } },
    { type: "response_item", timestamp: ts(3), payload: { type: "function_call_output", call_id: "x", output: JSON.stringify({ exit_code: 0, output: "1 passed in 0.1s" }) } },
  ]);
  const cx = await codex({ id: "p", files: [cxp, cxc] });
  assert.equal(cx.events.find((e) => e.kind === "cmd").workdir, "/other-worktree");
  cx.events.push(say("All tests pass."));
  assert.equal(analyzeSession(cx).claims.unknown, 1);
});
