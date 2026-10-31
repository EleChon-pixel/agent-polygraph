#!/usr/bin/env node
// Policy-cost comparison, not a claim of superior defect-detection accuracy.
// Usage:
//   node scripts/benchmark.mjs --demo
//   node scripts/benchmark.mjs --claude-dir ./eval-data/claude --codex-dir ./eval-data/codex
import fs from "node:fs";
import { parseArgs } from "node:util";
import { SOURCES } from "../src/scan.js";
import { analyzeSession } from "../src/analyze.js";
import { makeDemo } from "../src/demo.js";

const { values } = parseArgs({ options: {
  demo: { type: "boolean" },
  "claude-dir": { type: "string" },
  "codex-dir": { type: "string" },
  json: { type: "boolean" },
} });
if (!values.demo && !values["claude-dir"] && !values["codex-dir"]) {
  console.error("Supply --demo or an explicit --claude-dir / --codex-dir; no personal logs are read by default.");
  process.exit(2);
}
const demo = values.demo ? makeDemo() : null;
let sessions = 0, assistantMessages = 0, answeredUserTurns = 0, definiteFlags = 0, unknownClaims = 0, backedClaims = 0, totalClaimMessages = 0, skipped = 0;
try {
  for (const [agent, src] of Object.entries(SOURCES)) {
    const root = demo ? (agent === "claude" ? demo.claudeDir : demo.codexDir) :
      (agent === "claude" ? values["claude-dir"] : values["codex-dir"]);
    if (!root) continue;
    for (const entry of src.discover(root)) {
      try {
        const s = await src.parse(entry);
        if (s.unrecognized || !s.events.length) { skipped++; continue; }
        const analyzed = analyzeSession(s);
        sessions++;
        assistantMessages += s.events.filter((e) => e.kind === "say" && typeof e.text === "string" && e.text.trim()).length;
        // A transcript contains intermediate assistant messages; those are NOT Stop
        // events. Count user turns with an observed assistant reply as a conservative
        // policy comparison unit, without pretending to observe actual hook calls.
        let turnOpen = false, replied = false;
        for (const e of s.events) {
          if (e.kind === "user") {
            if (turnOpen && replied) answeredUserTurns++;
            turnOpen = true;
            replied = false;
          } else if (turnOpen && e.kind === "say" && !e.sub && e.text?.trim()) {
            replied = true;
          }
        }
        if (turnOpen && replied) answeredUserTurns++;
        definiteFlags += analyzed.claims["no-run"] + analyzed.claims.stale + analyzed.claims.failed;
        backedClaims += analyzed.claims.backed;
        unknownClaims += analyzed.claims.unknown;
        totalClaimMessages += Object.values(analyzed.claims).reduce((a, b) => a + b, 0);
      } catch {
        skipped++;
      }
    }
  }
} finally {
  if (demo) fs.rmSync(demo.root, { recursive: true, force: true });
}
if (!sessions || !answeredUserTurns) {
  console.error("No suitable sessions or assistant messages found. Cannot compare policies.");
  process.exit(2);
}
const avoided = Math.max(0, answeredUserTurns - definiteFlags);
const result = {
  dataset: demo ? "synthetic-generated-not-independent" : "supplied-session-logs-not-independent-validation",
  sessions,
  assistantMessages, // diagnostic only: NOT Stop events
  answeredUserTurns, // approximate policy comparison opportunities
  detectedClaims: totalClaimMessages,
  backedClaims,
  definiteUnbackedClaims: definiteFlags,
  unknownClaims,
  skippedSessions: skipped,
  policies: {
    alwaysRerunAfterEveryAssistantMessage: {
      hypotheticalTestInvocationsPerAnsweredUserTurn: answeredUserTurns,
      coverage: "Runs tests even without a claim, if a project-specific test command is configured",
    },
    polygraphClaimGuard: {
      // A retrospective finding isn't necessarily the final Stop-hook message.
      // This is an upper bound on actionable requests, not observed live runs.
      possibleExtraTestRequestsUpperBound: definiteFlags,
      hypotheticalTestInvocationsAvoidedLowerBound: avoided,
      possibleReductionPercentLowerBound: Number((100 * avoided / answeredUserTurns).toFixed(1)),
      coverage: "Only definite unbacked passing-test claims; leaves unknown and unclaimed breakage alone",
    },
  },
  limitations: [
    "Answered user turns are comparison units, not observed Stop-hook calls; unfinished turns are excluded",
    "Guard requests a verification rerun; it never executes tests or guarantees agent compliance",
    "Always-rerun may detect unclaimed breakage that guard misses; this benchmark does not measure correctness",
    "Existing classifications are not independently labeled; report is a workload/cost projection, not a comparative accuracy trial",
  ],
};
if (values.json) console.log(JSON.stringify(result, null, 2));
else {
  console.log("agent-polygraph policy-cost benchmark (" + result.dataset + ")");
  console.log("Sessions:", sessions, "answered user turns:", answeredUserTurns, "intermediate assistant messages:", assistantMessages, "claims:", totalClaimMessages);
  console.log("Backed:", backedClaims, "definite unbacked:", definiteFlags, "unknown:", unknownClaims);
  console.log("Always-rerun per answered user turn: " + answeredUserTurns + " hypothetical test invocations");
  console.log("Claim guard: at most " + definiteFlags + " additional test requests, at least " + avoided + " avoided (" +
    result.policies.polygraphClaimGuard.possibleReductionPercentLowerBound + "%) in this projection");
  for (const note of result.limitations) console.log("LIMITATION: " + note);
}
