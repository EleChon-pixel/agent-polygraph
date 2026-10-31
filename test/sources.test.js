import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as claude from "../src/sources/claude.js";
import * as codex from "../src/sources/codex.js";
import { analyzeSession, aggregate } from "../src/analyze.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "polygraph-"));
const jsonl = (file, recs) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
};
const at = (s) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString();

test("Claude Code: stale claim after an edit, then a backed claim", async () => {
  const root = tmp();
  const cwd = "/work/app";
  const base = { cwd, sessionId: "s1", isSidechain: false };
  const asst = (s, content) => ({ ...base, type: "assistant", timestamp: at(s), message: { model: "claude-test", content } });
  const result = (s, id, text, isError = false) => ({
    ...base,
    type: "user",
    timestamp: at(s),
    message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] },
  });
  jsonl(path.join(root, "-work-app", "s1.jsonl"), [
    { ...base, type: "user", timestamp: at(0), origin: { kind: "human" }, message: { content: "fix the retry bug" } },
    asst(1, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pytest -q" } }]),
    result(5, "t1", "Exit code 1\n1 failed, 9 passed in 0.5s", true),
    asst(6, [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/work/app/src/retry.py", old_string: "a", new_string: "b" } }]),
    result(6, "t2", "The file /work/app/src/retry.py has been updated successfully."),
    asst(7, [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "pytest -q" } }]),
    result(9, "t3", "10 passed in 0.5s"),
    asst(10, [{ type: "tool_use", id: "t4", name: "Edit", input: { file_path: "/work/app/src/retry.py", old_string: "b", new_string: "c" } }]),
    result(10, "t4", "The file /work/app/src/retry.py has been updated successfully."),
    asst(11, [{ type: "text", text: "Fixed. All tests pass." }]),
    asst(12, [{ type: "tool_use", id: "t5", name: "Bash", input: { command: "pytest -q" } }]),
    result(14, "t5", "10 passed in 0.5s"),
    asst(15, [{ type: "text", text: "Re-ran it: all 10 tests pass." }]),
    { ...base, type: "user", timestamp: at(16), origin: { kind: "human" }, message: { content: "no, I told you not to touch retry.py" } },
  ]);

  const [entry] = claude.discover(root);
  const s = analyzeSession(await claude.parse(entry));
  assert.equal(s.claims.stale, 1);
  assert.equal(s.claims.backed, 1);
  assert.equal(s.testRuns, 3);
  assert.equal(s.failingRuns, 1);
  assert.equal(s.corrections, 1);
  const stale = s.findings.find((f) => f.type === "claim");
  assert.equal(stale.detail.editedAfter, "src/retry.py");
});

test("Claude Code: subagent test runs are merged into the parent session", async () => {
  const root = tmp();
  const base = { cwd: "/w", sessionId: "s2" };
  jsonl(path.join(root, "-w", "s2.jsonl"), [
    { ...base, type: "assistant", timestamp: at(0), message: { content: [{ type: "tool_use", id: "e", name: "Edit", input: { file_path: "/w/a.py", old_string: "x", new_string: "y" } }] } },
    { ...base, type: "user", timestamp: at(1), message: { content: [{ type: "tool_result", tool_use_id: "e", content: "The file /w/a.py has been updated successfully." }] } },
    { ...base, type: "assistant", timestamp: at(30), message: { content: [{ type: "text", text: "The subagent confirmed: tests pass." }] } },
  ]);
  jsonl(path.join(root, "-w", "s2", "subagents", "agent-1.jsonl"), [
    { ...base, isSidechain: true, type: "assistant", timestamp: at(10), message: { content: [{ type: "tool_use", id: "b", name: "Bash", input: { command: "pytest" } }] } },
    { ...base, isSidechain: true, type: "user", timestamp: at(20), message: { content: [{ type: "tool_result", tool_use_id: "b", content: "4 passed in 1.0s" }] } },
  ]);
  const [entry] = claude.discover(root);
  assert.equal(entry.files.length, 2);
  const s = analyzeSession(await claude.parse(entry));
  assert.equal(s.claims.backed, 1);
});

test("Codex code mode: exec cells, apply_patch and exit codes", async () => {
  const root = tmp();
  const file = path.join(root, "2026", "10", "01", "rollout-x.jsonl");
  const item = (s, payload) => ({ timestamp: at(s), type: "response_item", payload });
  const patch = [
    "*** Begin Patch",
    "*** Update File: tests/test_api.py",
    "@@",
    "-    assert resp.status == 200",
    "-    assert resp.json() == {'ok': True}",
    "+    assert resp.status == 200",
    "*** End Patch",
  ].join("\n");
  jsonl(file, [
    { timestamp: at(0), type: "session_meta", payload: { id: "c1", cwd: "/repo" } },
    { timestamp: at(0), type: "turn_context", payload: { model: "gpt-test", cwd: "/repo" } },
    item(0, { type: "message", role: "user", content: [{ type: "input_text", text: "make the api tests green" }] }),
    item(1, { type: "custom_tool_call", name: "exec", call_id: "a", input: 'const r = await tools.exec_command({"cmd":"pytest -q tests/test_api.py"}); text(r.output);' }),
    item(4, { type: "custom_tool_call_output", call_id: "a", output: [{ type: "input_text", text: 'Script completed\nWall time 3.0 seconds\n{"exit_code":1,"output":"1 failed, 3 passed in 0.2s"}' }] }),
    item(5, { type: "custom_tool_call", name: "exec", call_id: "b", input: `const patch = \`${patch}\`;\nawait tools.apply_patch(patch);` }),
    item(6, { type: "custom_tool_call_output", call_id: "b", output: [{ type: "input_text", text: "Success" }] }),
    item(7, { type: "custom_tool_call", name: "exec", call_id: "c", input: 'await tools.exec_command({cmd:"pytest -q tests/test_api.py"})' }),
    item(9, { type: "custom_tool_call_output", call_id: "c", output: [{ type: "input_text", text: '{"exit_code":0,"output":"4 passed in 0.2s"}' }] }),
    item(10, { type: "message", role: "assistant", content: [{ type: "output_text", text: "All API tests pass now." }] }),
  ]);
  const [entry] = codex.discover(root);
  const s = analyzeSession(await codex.parse(entry));
  assert.equal(s.model, "gpt-test");
  assert.equal(s.testRuns, 2);
  assert.equal(s.failingRuns, 1);
  assert.equal(s.claims.backed, 1);
  const types = s.findings.map((f) => f.type).sort();
  assert.deepEqual(types, ["test-only-fix", "weakened-test"]);
  assert.deepEqual(s.findings.find((f) => f.type === "weakened-test").detail.reasons, ["removed 1 assertion"]);
});

test("Codex classic tool format", async () => {
  const root = tmp();
  const file = path.join(root, "r.jsonl");
  jsonl(file, [
    { timestamp: at(0), type: "session_meta", payload: { id: "c2", cwd: "/repo" } },
    { timestamp: at(1), type: "response_item", payload: { type: "function_call", name: "shell", call_id: "x", arguments: JSON.stringify({ command: ["bash", "-lc", "go test ./..."] }) } },
    { timestamp: at(3), type: "response_item", payload: { type: "function_call_output", call_id: "x", output: JSON.stringify({ output: "ok  \tpkg\t0.01s", metadata: { exit_code: 0 } }) } },
    { timestamp: at(4), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Tests pass." }] } },
  ]);
  const [entry] = codex.discover(root);
  const s = analyzeSession(await codex.parse(entry));
  assert.equal(s.testRuns, 1);
  assert.equal(s.fullSuiteRuns, 0);
  assert.equal(s.claims.backed, 1);
});

test("aggregate computes receipt rate without unknowns", () => {
  const mk = (agent, claims) => ({
    agent,
    model: "m",
    claims: { backed: 0, "no-run": 0, stale: 0, failed: 0, unknown: 0, ...claims },
    testRuns: 0, failingRuns: 0, testMs: 0, fullSuiteRuns: 0, fullSuiteMs: 0, commands: 1, edits: 0,
    userMessages: 0, corrections: 0, interrupts: 0, risky: {}, findings: [], start: 1, end: 2,
  });
  const g = aggregate([mk("claude", { backed: 3, stale: 1, unknown: 5 }), mk("codex", { backed: 1 })]);
  assert.equal(g["agent:claude"].receiptRate, 0.75);
  assert.equal(g.all.receiptRate, 0.8);
  assert.equal(g.all.claimsTotal, 10);
});

test("--demo data parses through the real pipeline", async () => {
  const { makeDemo } = await import("../src/demo.js");
  const d = makeDemo();
  try {
    const sessions = [];
    for (const e of [...claude.discover(d.claudeDir), ...codex.discover(d.codexDir)]) {
      sessions.push(analyzeSession(await (e.agent === "claude" ? claude : codex).parse(e)));
    }
    const g = aggregate(sessions);
    assert.equal(g.all.sessions, 120);
    assert.ok(g.all.claims.backed > 20 && g.all.claims.stale > 0 && g.all.claims.failed > 0);
    assert.ok(g.all.findingCounts["test-only-fix"] > 0 && g.all.findingCounts["weakened-test"] > 0);
  } finally {
    fs.rmSync(d.root, { recursive: true, force: true });
  }
});

test("--exclude skips sessions by id prefix or working directory", async () => {
  const { makeDemo } = await import("../src/demo.js");
  const { scan } = await import("../src/scan.js");
  const d = makeDemo();
  try {
    const roots = { claude: d.claudeDir, codex: d.codexDir };
    const all = await scan({ roots });
    const noShop = await scan({ roots, exclude: ["/work/shop-api"] });
    const noOne = await scan({ roots, exclude: ["demo-0"] });
    assert.ok(noShop.length < all.length && noShop.every((s) => !s.cwd.includes("shop-api")));
    assert.equal(noOne.length, all.length - 1);
  } finally {
    fs.rmSync(d.root, { recursive: true, force: true });
  }
});
