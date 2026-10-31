import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHtml } from "../src/report/html.js";
import { aggregate } from "../src/analyze.js";

const session = (agent, claims, unclear = {}, extra = {}) => ({
  agent,
  model: "m",
  claims: { backed: 0, "no-run": 0, stale: 0, failed: 0, unknown: 0, ...claims },
  unclear,
  testRuns: 5, failingRuns: 1, testMs: 60000, fullSuiteRuns: 1, fullSuiteMs: 30000, commands: 9, edits: 3,
  userMessages: 2, corrections: 0, interrupts: 0, risky: {}, start: 1, end: 2,
  findings: [{ type: "claim", detail: { claim: "secret claim text", lastTest: { cmd: "pytest /home/someone/x" } } }],
  ...extra,
});

test("the card matches the terminal report: receipt rate, unclear breakdown, skipped files", () => {
  const groups = aggregate([
    session("claude", { backed: 9, stale: 1, unknown: 2 }, { "test result unreadable": 2 }),
    session("codex", { backed: 4 }),
  ]);
  const html = renderHtml({ groups, skipped: 3 });
  assert.match(html, /<tr class="total"><td>Receipt rate<\/td><td>90%<\/td>/);
  assert.match(html, /…test result unreadable/);
  assert.doesNotMatch(html, /…test still running/); // all zero: hidden, as in the terminal
  assert.match(html, /2 more couldn't be judged/);
  assert.match(html, /3 session files couldn't be read/);
});

test("the card never contains claim text, commands or paths", () => {
  const html = renderHtml({ groups: aggregate([session("claude", { backed: 1, stale: 1 })]) });
  assert.doesNotMatch(html, /secret claim text|pytest|\/home\//);
});
