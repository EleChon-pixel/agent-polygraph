import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { diagnose, renderDoctor } from "../src/doctor.js";
import { renderExplanations } from "../src/explain.js";

const cli = fileURLToPath(new URL("../bin/polygraph.js", import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "apg-diagnostics-"));

test("explain displays evidence, uncertainty and privacy warning without inventing a passing run", () => {
  const sessions = [{
    id: "session-123", agent: "claude", file: "/private/session.jsonl",
    findings: [
      { type: "claim", ts: Date.UTC(2026, 9, 1, 12, 5), detail: {
        verdict: "stale", claim: "All tests pass", editedAfter: "src/auth.js",
        lastTest: { cmd: "npm test", outcome: "pass", ago: 120000 },
      } },
      { type: "unclear", ts: Date.UTC(2026, 9, 1, 12, 6), detail: {
        why: "no full-suite test run observed", claim: "Full suite passes",
      } },
    ],
  }];
  const out = renderExplanations(sessions);
  assert.match(out, /Test result is stale/);
  assert.match(out, /Insufficient evidence/);
  assert.match(out, /Subsequent edit: src\/auth.js/);
  assert.match(out, /no full-suite test run observed/);
  assert.match(out, /Contains transcript excerpts and local file paths/);
  const filtered = renderExplanations(sessions, { limit: 1, sessionId: "session-1" });
  assert.match(filtered, /Showing 1 of 2/);
  assert.match(renderExplanations(sessions, { sessionId: "not-here" }), /No flagged\/uncertain claims found/);
});

test("doctor reports optional hooks and does not create or edit configuration files", async () => {
  const root = tmp(), project = path.join(root, "project");
  const claude = path.join(root, "claude"), codex = path.join(root, "codex");
  fs.mkdirSync(project);
  fs.mkdirSync(claude);
  fs.mkdirSync(codex);
  const old = process.env.AGENT_POLYGRAPH_HOME;
  process.env.AGENT_POLYGRAPH_HOME = path.join(root, "recorder");
  try {
    const checks = await diagnose({ cwd: project, roots: { claude, codex } });
    const result = renderDoctor(checks);
    assert.match(result, /read-only/);
    assert.match(result, /not installed/);
    assert.match(result, /Local recorder not initialized/);
    assert.ok(!fs.existsSync(path.join(project, ".claude")));
    assert.ok(!fs.existsSync(process.env.AGENT_POLYGRAPH_HOME));
  } finally {
    if (old === undefined) delete process.env.AGENT_POLYGRAPH_HOME;
    else process.env.AGENT_POLYGRAPH_HOME = old;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI exposes explain and doctor and rejects an invalid limit", () => {
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", timeout: 15000 });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /agent-polygraph explain/);
  assert.match(help.stdout, /agent-polygraph doctor/);
  const invalid = spawnSync(process.execPath, [cli, "explain", "--limit", "oops"], { encoding: "utf8", timeout: 15000 });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /--limit must be an integer/);
});
