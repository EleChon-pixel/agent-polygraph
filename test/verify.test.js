import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runHook, install } from "../src/guard.js";
import { guardStatus, verifyOptions } from "../src/verify.js";
import { snapshot } from "../src/record.js";

delete process.env.AGENT_POLYGRAPH_VERIFY; // generated projects exercise the verifier, including when this suite itself is guarded
process.env.AGENT_POLYGRAPH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "apg-verify-state-"));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "apg-verify-"));
const cli = fileURLToPath(new URL("../bin/polygraph.js", import.meta.url));
const node = JSON.stringify(process.execPath);
function project({ bad = false, command } = {}) {
  const cwd = temp();
  execFileSync("git", ["init", "-q", cwd]);
  fs.writeFileSync(path.join(cwd, ".gitignore"), "counter\nsession.jsonl\n");
  fs.writeFileSync(path.join(cwd, "value.txt"), bad ? "bad" : "good");
  fs.writeFileSync(path.join(cwd, "check.cjs"), "const fs=require('fs');const n=Number(fs.existsSync('counter')?fs.readFileSync('counter','utf8'):0);fs.writeFileSync('counter',String(n+1));process.exit(fs.readFileSync('value.txt','utf8')==='good'?0:1);\n");
  const file = path.join(cwd, "session.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "user", timestamp: "2026-11-03T12:00:00Z", cwd, message: { content: "Fix the code" } }) + "\n");
  const payload = { transcript_path: file, cwd, session_id: "session", last_assistant_message: "Done." };
  const opts = { mode: "verify", cwd, testCommand: command || `${node} check.cjs`, timeout: 5, maxAttempts: 2 };
  return { cwd, file, payload, opts, run: (p = {}) => runHook(JSON.stringify({ ...payload, ...p }), opts), count: () => Number(fs.readFileSync(path.join(cwd, "counter"), "utf8")) };
}

test("verification catches a real failing command without a passing-test claim", async () => {
  const p = project({ bad: true });
  const block = await p.run();
  assert.equal(block.decision, "block");
  assert.equal(p.count(), 1);
  assert.match(block.reason, /attempt 1\/2/);
  assert.equal(guardStatus(p.cwd).records[0].outcome, "fail");
  // Changing prose and stop_hook_active do not bypass the command or its budget.
  const exhausted = await p.run({ stop_hook_active: true, last_assistant_message: "I cannot confirm the tests." });
  assert.equal(exhausted.continue, false);
  assert.match(exhausted.stopReason, /Repair budget exhausted/);
  assert.equal(p.count(), 2);
  assert.equal((await p.run({ stop_hook_active: true })).continue, false);
  assert.equal(p.count(), 2, "no unlimited reruns on repeated stops");
});

test("repairs are actually retested and success permits stopping", async () => {
  const p = project({ bad: true });
  await p.run();
  fs.writeFileSync(path.join(p.cwd, "value.txt"), "good");
  assert.equal(await p.run({ stop_hook_active: true }), null);
  assert.equal(p.count(), 2);
  assert.equal(guardStatus(p.cwd).records[0].outcome, "pass");
});

test("new human turns reset repair budgets, generated continuations do not", async () => {
  const p = project({ bad: true });
  await p.run();
  fs.appendFileSync(p.file, JSON.stringify({ type: "user", timestamp: "2026-11-03T12:00:01Z", cwd: p.cwd, message: { content: "agent-polygraph: Fix the failure" } }) + "\n");
  assert.equal((await p.run()).continue, false);
  fs.appendFileSync(p.file, JSON.stringify({ type: "user", timestamp: "2026-11-03T12:00:02Z", cwd: p.cwd, message: { content: "Try a different repair" } }) + "\n");
  assert.equal((await p.run()).decision, "block");
  assert.equal(p.count(), 3);
});

test("cache is opt-in, content-bound, includes config and is not a claim parser", async () => {
  const p = project();
  assert.equal(await p.run(), null);
  assert.equal(await p.run(), null);
  assert.equal(p.count(), 2, "default always re-executes");
  p.opts.cacheSeconds = 60;
  assert.equal(await p.run(), null);
  assert.equal(p.count(), 2, "unchanged passing tree may be reused when enabled");
  fs.writeFileSync(path.join(p.cwd, "package.json"), '{"scripts":{"test":"false"}}');
  assert.equal(await p.run(), null);
  assert.equal(p.count(), 3, "configuration edits invalidate cached evidence");
  fs.writeFileSync(path.join(p.cwd, "value.txt"), "bad");
  assert.equal((await p.run()).decision, "block");
  assert.equal(p.count(), 4);
});

test("tests that mutate the working tree cannot certify a stable passing revision", async () => {
  const p = project({ command: `${node} -e "require('fs').writeFileSync('value.txt','changed')"` });
  const out = await p.run();
  assert.equal(out.decision, "block");
  assert.match(out.reason, /files changed while tests ran/);
  assert.equal(guardStatus(p.cwd).records[0].outcome, "unknown");
});

test("unreadable transcripts are not needed for real verification; wrong cwd is refused", async () => {
  const p = project();
  assert.equal(await p.run({ transcript_path: path.join(p.cwd, "missing.jsonl") }), null);
  const other = temp();
  const refused = await p.run({ cwd: other, test_command: "anything", last_assistant_message: "All tests pass." });
  assert.equal(refused.continue, false);
  assert.match(refused.stopReason, /cwd differs/);
  assert.equal(p.count(), 1);
});

test("incomplete snapshots and stale locks produce visible unresolved results", async () => {
  const p = project();
  fs.writeFileSync(path.join(p.cwd, "huge.bin"), Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.match((await p.run()).reason, /fingerprint is incomplete/);
  const status = guardStatus(p.cwd);
  const projectKey = (await import("node:crypto")).createHash("sha256").update(fs.realpathSync(p.cwd)).digest("hex");
  const lock = path.join(process.env.AGENT_POLYGRAPH_HOME, "guard", projectKey, "running.lock");
  fs.writeFileSync(lock, "");
  const locked = await p.run();
  assert.equal(locked.continue, false);
  assert.equal(p.count(), 1);
  assert.equal(guardStatus(p.cwd).lockPresent, true);
  assert.equal(status.records[0].outcome, "unknown");
});

test("timeouts terminate a test process group and never become passing evidence", async () => {
  const p = project({ command: `${node} -e "setTimeout(()=>{},10000)"` });
  p.opts.timeout = 1;
  const t = Date.now();
  const out = await p.run();
  assert.match(out.reason, /timed out/);
  assert.ok(Date.now() - t < 5000);
  assert.equal(guardStatus(p.cwd).records[0].outcome, "unknown");
});

test("verification receipts omit raw commands, output and source", async () => {
  const p = project({ command: `${node} -e "console.log('SECRET_OUTPUT')"` });
  assert.equal(await p.run(), null);
  const encoded = JSON.stringify(guardStatus(p.cwd));
  assert.ok(!encoded.includes("SECRET_OUTPUT") && !encoded.includes("console.log") && !encoded.includes(p.cwd));
  if (process.platform !== "win32") {
    const root = path.join(process.env.AGENT_POLYGRAPH_HOME, "guard");
    const folder = fs.readdirSync(root).find((d) => fs.readdirSync(path.join(root, d)).some((f) => f.includes(guardStatus(p.cwd).records[0].id)));
    const file = path.join(root, folder, guardStatus(p.cwd).records[0].id + ".json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test("strict transcript mode challenges ambiguous claims but keeps legacy behavior", async () => {
  const cwd = temp();
  const file = path.join(cwd, "s.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "user", timestamp: "2026-11-03T12:00:00Z", cwd, message: { content: "Discuss the project" } }));
  const payload = { cwd, transcript_path: file, last_assistant_message: "All tests pass." };
  assert.equal(await runHook(JSON.stringify(payload)), null);
  assert.equal((await runHook(JSON.stringify(payload), { mode: "strict" })).decision, "block");
  assert.equal((await runHook(JSON.stringify({ ...payload, stop_hook_active: true }), { mode: "strict" })).continue, false);
});

test("installed verification commands survive shell quoting and bind policy timeout", async () => {
  const p = project();
  // The configured command retains its shell's normal expansion rules. Put
  // metacharacters in a valid comment rather than JavaScript source into which
  // cmd.exe would expand PATH and inject invalid escape sequences.
  const command = `${node} check.cjs` + (process.platform === "win32" ? ' & rem "a quote, $HOME and %PATH%"' : ' # a quote, $HOME and %PATH%');
  const result = install({ cwd: p.cwd, agents: ["claude"], mode: "verify", testCommand: command, command: `${node} ${JSON.stringify(cli)} guard`, timeout: 5 });
  const configured = JSON.parse(fs.readFileSync(result[0].file, "utf8")).hooks.Stop[0].hooks[0];
  assert.equal(configured.timeout, 35);
  assert.ok(!configured.command.includes("%PATH%"));
  const encoded = /--verify-config ([A-Za-z0-9_-]+)/.exec(configured.command)[1];
  assert.equal(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")).testCommand, command);
  const child = spawnSync(configured.command, { shell: true, cwd: p.cwd, input: JSON.stringify(p.payload), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "");
  assert.equal(guardStatus(p.cwd).records[0].outcome, "pass");
  assert.throws(() => install({ cwd: p.cwd, agents: ["claude"], mode: "verify", testCommand: command, command: "polygraph guard", global: true }), /project-specific/);
});

test("snapshot represents deletion of a tracked file without treating it as unreadable", () => {
  const p = project();
  execFileSync("git", ["-C", p.cwd, "add", "value.txt"]);
  fs.unlinkSync(path.join(p.cwd, "value.txt"));
  assert.equal(snapshot(p.cwd, { allFiles: true }).complete, true);
});

test("verification rejects invalid policies before writing configuration", () => {
  const cwd = temp();
  for (const options of [{}, { testCommand: "x", cwd, timeout: 0 }, { testCommand: "x", cwd, maxAttempts: 6 }, { testCommand: "x", cwd, cacheSeconds: -1 }])
    assert.throws(() => verifyOptions(options));
});


test("an explicit warn policy surfaces unknown results without claiming a pass", async () => {
  const p = project();
  p.opts.onUnknown = "warn";
  fs.writeFileSync(path.join(p.cwd, "huge.bin"), Buffer.alloc(8 * 1024 * 1024 + 1));
  const out = await p.run();
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /verification is UNKNOWN/);
  assert.equal(guardStatus(p.cwd).records[0].outcome, "unknown");
});

test("invalid CLI hook policies return a visible unresolved result rather than a swallowed exit error", () => {
  const p = spawnSync(process.execPath, [cli, "guard", "--mode", "verify", "--cwd", path.join(temp(), "missing"), "--test-command", "node --test"], { input: "{}", encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr);
  assert.equal(JSON.parse(p.stdout).continue, false);
});

test("expired or environment-mismatched cache entries force real execution", async () => {
  const p = project();
  p.opts.cacheSeconds = 60;
  await p.run();
  const state = guardStatus(p.cwd).records[0];
  const crypto = await import("node:crypto");
  const dir = path.join(process.env.AGENT_POLYGRAPH_HOME, "guard", crypto.createHash("sha256").update(fs.realpathSync(p.cwd)).digest("hex"));
  const file = path.join(dir, state.id + ".json");
  fs.writeFileSync(file, JSON.stringify({ ...state, finished: Date.now() - 61000 }));
  assert.equal(await p.run(), null);
  assert.equal(p.count(), 2, "expired evidence cannot be reused");
  process.env.APG_FIXTURE_ENV = "changed";
  try {
    assert.equal(await p.run(), null);
    assert.equal(p.count(), 3, "test environment changes invalidate evidence");
  } finally { delete process.env.APG_FIXTURE_ENV; }
});

test("Codex continued stops cannot avoid a real repair verification", async () => {
  const p = project({ bad: true });
  const records = [
    { type: "session_meta", timestamp: "2026-11-03T12:00:00Z", payload: { id: "cx", cwd: p.cwd } },
    { type: "response_item", timestamp: "2026-11-03T12:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix this code" }] } },
  ];
  fs.writeFileSync(p.file, records.map(JSON.stringify).join("\n"));
  assert.equal((await p.run()).decision, "block");
  fs.writeFileSync(path.join(p.cwd, "value.txt"), "good");
  assert.equal(await p.run({ stop_hook_active: true, last_assistant_message: "No test claim." }), null);
  assert.equal(p.count(), 2);
});

test("a printed failure beats an exit-zero configured command", async () => {
  const p = project({ command: `${node} -e "console.log('1 failed in 0.1s')"` });
  assert.equal((await p.run()).decision, "block");
  const receipt = guardStatus(p.cwd).records[0];
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.outcome, "fail");
});


test("malformed Stop payloads are unresolved in stronger policies", async () => {
  const p = project();
  assert.equal((await runHook("not JSON", p.opts)).continue, false);
  assert.equal((await runHook("not JSON", { mode: "strict" })).continue, false);
  assert.equal(await runHook("not JSON"), null);
  assert.equal(fs.existsSync(path.join(p.cwd, "counter")), false);
});


test("an empty real Node test suite is inconclusive rather than a passing verification", async () => {
  const p = project({ command: `${node} --test` });
  assert.equal((await p.run()).decision, "block");
  assert.equal(guardStatus(p.cwd).records[0].outcome, "unknown");
});
