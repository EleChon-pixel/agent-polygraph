#!/usr/bin/env node
// Actual executable policy comparison, using a fresh private temporary test project.
// Every oracle label is the exit status of a REAL node --test execution on final
// source files, not agent-polygraph's verdict or a simulated "test result".
// The agent transcript is generated from real pre/post test invocations.
// This evaluates policies, not autonomous agent compliance or independent human labels.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { runHook } from "../src/guard.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-polygraph-live-"));
const T = Date.UTC(2026, 9, 31, 12, 0, 0);
const stamp = (n) => new Date(T + n * 1000).toISOString();
const fixtureCases = [
  { name: "fresh-passing-claim", before: "good", after: "good", order: "edit-test", claim: true },
  { name: "fresh-passing-twice", before: "good", after: "good", order: "edit-test-twice", claim: true },
  { name: "stale-failing-claim", before: "good", after: "bad", order: "test-edit", claim: true },
  { name: "stale-passing-claim", before: "good", after: "good", order: "test-edit", claim: true },
  { name: "failed-latest-claim", before: "good", after: "bad", order: "test-edit-test", claim: true },
  { name: "no-run-failing-claim", before: "good", after: "bad", order: "edit", claim: true },
  { name: "no-run-passing-claim", before: "good", after: "good", order: "edit", claim: true },
  { name: "unclaimed-failure", before: "good", after: "bad", order: "test-edit", claim: false },
  { name: "unclaimed-pass", before: "good", after: "good", order: "edit", claim: false },
  { name: "unclaimed-fail-from-start", before: "bad", after: "bad", order: "test", claim: false },
  { name: "passing-focused-test-misses-bug", before: "good", after: "bad", order: "test-edit-focused", claim: true },
  { name: "focused-test-without-claim", before: "good", after: "bad", order: "test-edit-focused", claim: false },
];
const out = { dataset: "instrumented-local-projects", node: process.version, platform: process.platform,
  semantics: "Actual tests are executed. A guard block is followed by one forced test in this harness; no autonomous agent is running.",
  baselines: ["always-run-complete-suite", "claim-guard-then-complete-suite-if-blocked", "naive-any-prior-pass-then-complete-suite-if-blocked"],
  cases: [], totals: {} };
let seq = 0;
function shell(dir, focused = false) {
  const args = ["--test", focused ? "test/smoke.test.mjs" : "test"];
  const start = performance.now();
  const result = spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8", timeout: 30000,
    maxBuffer: 1 << 20, env: { ...process.env, NODE_DISABLE_COLORS: "1" } });
  if (result.error || result.status == null) throw result.error || Error("test command timed out");
  return { cmd: "node " + args.join(" "), success: result.status === 0, exit: result.status,
    ms: performance.now() - start, output: (result.stdout || "") + "\n" + (result.stderr || "") };
}
function writeSource(dir, mode, label) {
  const p = path.join(dir, "src", "value.mjs");
  fs.writeFileSync(p, "export const value = " + (mode === "bad" ? 2 : 1) + "; // " + label + "\n");
}
function setup(dir, mode) {
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  writeSource(dir, mode, "start");
  fs.writeFileSync(path.join(dir, "test", "unit.test.mjs"),
    "import { test } from 'node:test'; import { strictEqual } from 'node:assert'; import { value } from '../src/value.mjs'; test('value must remain one', () => strictEqual(value, 1));\n");
  fs.writeFileSync(path.join(dir, "test", "smoke.test.mjs"),
    "import { test } from 'node:test'; import { strictEqual } from 'node:assert'; test('smoke works', () => strictEqual(2+2, 4));\n");
}
function claudeTranscript(cwd, steps, finalText) {
  const user = { type: "user", timestamp: stamp(0), cwd, origin: { kind: "human" }, message: { content: "Implement the task." } };
  const data = [user];
  for (const e of steps) {
    if (e.kind === "edit") {
      data.push({ type: "assistant", timestamp: stamp(e.time), cwd, message: { content: [{ type: "tool_use", id: e.id,
        name: "Edit", input: { file_path: path.join(cwd, "src/value.mjs"), old_string: "old", new_string: "new" } }] } });
      data.push({ type: "user", timestamp: stamp(e.time + 1), cwd, message: { content: [{ type: "tool_result", tool_use_id: e.id,
        content: "The file " + path.join(cwd, "src/value.mjs") + " has been updated successfully." }] } });
    } else {
      data.push({ type: "assistant", timestamp: stamp(e.time), cwd, message: { content: [{ type: "tool_use", id: e.id,
        name: "Bash", input: { command: e.result.cmd } }] } });
      data.push({ type: "user", timestamp: stamp(e.time + 1), cwd, message: { content: [{ type: "tool_result", tool_use_id: e.id,
        content: e.result.output, is_error: !e.result.success }] } });
    }
  }
  data.push({ type: "assistant", timestamp: stamp(40), cwd, message: { content: [{ type: "text", text: finalText }] } });
  return data;
}
function naiveShouldBlock(steps, claimed) {
  if (!claimed) return false;
  // Simplest historical baseline: any earlier full or focused successful test.
  return !steps.some((e) => e.kind === "test" && e.result.success);
}
function summarizePolicy(rows, name) {
  const x = rows.map((r) => r[name]);
  return {
    actualAdditionalTestExecutions: x.filter((r) => r.executed).length,
    measuredTestExecutionMs: Number(x.reduce((s, r) => s + (r.testMs || 0), 0).toFixed(1)),
    measuredPolicyDecisionMs: Number(x.reduce((s, r) => s + (r.decisionMs || 0), 0).toFixed(1)),
    detectedActualFailingFinalSuites: x.filter((r) => r.detected).length,
    missedActualFailingFinalSuites: rows.filter((r) => r.oracleFail).filter((r) => !r[name].detected).length,
    unnecessarySuccessfulFinalSuitesRerun: rows.filter((r) => !r.oracleFail && r[name].executed).length,
  };
}
try {
  for (const c of fixtureCases) {
    const dir = path.join(root, "project-" + ++seq);
    fs.mkdirSync(dir);
    setup(dir, c.before);
    const steps = [];
    let n = 1;
    const doTest = (focused = false) => steps.push({ kind: "test", time: n++ * 3, id: "cmd" + n, result: shell(dir, focused) });
    const doEdit = () => {
      writeSource(dir, c.after, "revision-" + seq);
      steps.push({ kind: "edit", time: n++ * 3, id: "edit" + n });
    };
    if (c.order === "edit-test") { doEdit(); doTest(); }
    else if (c.order === "edit-test-twice") { doEdit(); doTest(); doTest(); }
    else if (c.order === "test-edit") { doTest(); doEdit(); }
    else if (c.order === "test-edit-test") { doTest(); doEdit(); doTest(); }
    else if (c.order === "edit") doEdit();
    else if (c.order === "test") doTest();
    else if (c.order === "test-edit-focused") { doTest(); doEdit(); doTest(true); }
    const finalText = c.claim ? "Done. All tests pass." : "Work complete. I cannot confirm the tests.";
    const transcript = path.join(root, "session-" + seq + ".jsonl");
    fs.writeFileSync(transcript, claudeTranscript(dir, steps, finalText).map((x) => JSON.stringify(x)).join("\n") + "\n");
    // Oracle is a fresh, independent complete test suite on the *final* actual
    // files. Its cost is excluded from all policy timing totals.
    const oracle = shell(dir);
    const oracleFail = !oracle.success;
    const startGuard = performance.now();
    const guard = await runHook(JSON.stringify({ transcript_path: transcript, cwd: dir, last_assistant_message: finalText }));
    const guardMs = performance.now() - startGuard;
    const blocked = guard?.decision === "block";
    const naiveBlocked = naiveShouldBlock(steps, c.claim);
    const runIf = (need, decisionMs = 0) => {
      const test = need ? shell(dir) : null;
      return { executed: !!test, detected: test ? !test.success : false, testMs: test?.ms || 0, decisionMs };
    };
    const row = { scenario: c.name, oracleFail, guardBlocked: blocked, naiveBlocked,
      always: runIf(true), guard: runIf(blocked, guardMs), naive: runIf(naiveBlocked) };
    out.cases.push(row);
  }
  out.totals = {
    scenarios: out.cases.length,
    actualFailingFinalSuites: out.cases.filter((r) => r.oracleFail).length,
    always: summarizePolicy(out.cases, "always"),
    guard: summarizePolicy(out.cases, "guard"),
    naive: summarizePolicy(out.cases, "naive"),
  };
  console.log(JSON.stringify(out, null, 2));
  if (!out.cases.some((r) => r.oracleFail && !r.guard.detected)) throw Error("Missing guard limitation fixture");
  if (!out.cases.some((r) => r.oracleFail && !r.naive.detected && r.guard.detected)) throw Error("Missing freshness advantage fixture");
  if (out.totals.always.missedActualFailingFinalSuites !== 0) throw Error("Always-rerun must catch all deterministic failing suites");
  if (out.totals.guard.actualAdditionalTestExecutions >= out.totals.always.actualAdditionalTestExecutions)
    throw Error("Selective guard did not save test invocations");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
