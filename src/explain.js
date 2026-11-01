import { AGENT_NAMES } from "./report/format.js";

const LABELS = {
  "no-run": "No recognized test run",
  stale: "Test result is stale",
  failed: "Latest relevant test failed",
  unknown: "Insufficient evidence",
};

const when = (ms) => Number.isFinite(ms) ? new Date(ms).toISOString() : "time unavailable";
const printable = (s, n = 240) => String(s ?? "").replace(/[\r\n\t]+/g, " ").slice(0, n);

/**
 * Human-readable, local-only explanation of existing verdict evidence.
 * No commands are executed and no raw transcripts are uploaded.
 * Only recorded findings can be explained; backed claims have no finding.
 */
export function renderExplanations(sessions, { limit = 10, sessionId = null } = {}) {
  const selected = sessions.filter((s) => !sessionId || s.id.startsWith(sessionId));
  const entries = selected.flatMap((s) => (s.findings || [])
    .filter((f) => f.type === "claim" || f.type === "unclear")
    .map((f) => ({ s, f })))
    .sort((a, b) => (b.f.ts || 0) - (a.f.ts || 0));
  const count = Math.max(0, Math.trunc(limit));
  const lines = ["agent-polygraph explain — local evidence, not proof that code is correct",
    `Sessions: ${selected.length}; flagged or uncertain claims: ${entries.length}`];
  if (!entries.length) {
    lines.push("No flagged/uncertain claims found. Backed claims are counted in the main report, not listed here.");
    return lines.join("\n");
  }
  for (const { s, f } of entries.slice(0, count)) {
    const d = f.detail || {};
    const verdict = f.type === "unclear" ? "unknown" : d.verdict;
    lines.push("", `[${LABELS[verdict] || verdict || "Unclassified"}] ${when(f.ts)} · ${AGENT_NAMES[s.agent] || s.agent} · session ${s.id}`);
    lines.push(`  Claim: ${printable(d.claim)}`);
    if (d.lastTest) {
      const lt = d.lastTest;
      const at = typeof lt.ago === "number" && Number.isFinite(f.ts) ? when(f.ts - lt.ago) : "time not recorded";
      lines.push(`  Test evidence: ${printable(lt.cmd, 200)} · ${lt.outcome || "outcome unknown"} · ${at}`);
    } else lines.push("  Test evidence: none identified");
    if (d.editedAfter) lines.push(`  Subsequent edit: ${printable(d.editedAfter, 180)}`);
    if (d.why) lines.push(`  Missing evidence: ${printable(d.why)}`);
    if (d.ci) lines.push("  Source: optional GitHub Actions evidence");
    if (s.file) lines.push(`  Transcript (private): ${s.file}`);
  }
  if (entries.length > count) lines.push("", `Showing ${count} of ${entries.length} claims; increase --limit to see more.`);
  lines.push("", "Contains transcript excerpts and local file paths. Review before sharing.");
  return lines.join("\n");
}
