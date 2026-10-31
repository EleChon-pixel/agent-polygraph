export const AGENT_NAMES = { claude: "Claude Code", codex: "Codex" };

export function duration(ms) {
  if (!ms) return "0m";
  const m = ms / 60000;
  if (m < 1) return `${Math.round(ms / 1000)}s`;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  return h < 10 ? `${h.toFixed(1)}h` : `${Math.round(h)}h`;
}

export function pct(x) {
  return x == null ? "–" : `${Math.round(x * 100)}%`;
}

export function day(ts, opts = { month: "short", day: "numeric" }) {
  return ts ? new Date(ts).toLocaleDateString("en-US", opts) : "?";
}

export function range(g) {
  if (!g.start || !isFinite(g.start)) return "";
  const y = { month: "short", day: "numeric", year: "numeric" };
  return `${day(g.start)} – ${day(g.end, y)}`;
}

/** Columns to show: one per agent (or model) that has sessions, plus "All" when there are several. */
export function columns(groups, by = "agent") {
  const cols = Object.entries(groups)
    .filter(([k, g]) => k.startsWith(by + ":") && g.activeSessions > 0)
    .sort((a, b) => b[1].activeSessions - a[1].activeSessions)
    .map(([k, g]) => ({ key: k, label: by === "agent" ? AGENT_NAMES[k.slice(6)] || k.slice(6) : k.slice(6), g }));
  if (cols.length !== 1) cols.push({ key: "all", label: "All", g: groups.all });
  return cols;
}

export const ROWS = {
  claims: [
    ["Backed by a fresh passing run", (g) => g.claims.backed],
    ["No test run in the session", (g) => g.claims["no-run"]],
    ["Code edited after the last run", (g) => g.claims.stale],
    ["Last run had failed", (g) => g.claims.failed],
    ["Couldn't tell", (g) => g.claims.unknown],
  ],
  unclear: [
    ["…test result unreadable", (g) => g.unclear["test result unreadable"] || 0],
    ["…unresolved file change after the run", (g) => g.unclear["unresolved file change after the run"] || 0],
    ["…test still running", (g) => g.unclear["test still running"] || 0],
    ["…other", (g) => Object.entries(g.unclear).filter(([k]) => !/unreadable|unresolved|still running/.test(k)).reduce((a, [, v]) => a + v, 0)],
  ],
  integrity: [
    ['Failing test "fixed" by editing only tests', (g) => g.findingCounts["test-only-fix"] || 0],
    ["Edits that weakened an existing test", (g) => g.findingCounts["weakened-test"] || 0],
  ],
  time: [
    ["Test runs", (g) => g.testRuns],
    ["…that failed", (g) => g.failingRuns],
    ["Time spent in tests", (g) => duration(g.testMs)],
    ["Full-suite runs", (g) => g.fullSuiteRuns],
    ["Time in full-suite runs", (g) => duration(g.fullSuiteMs)],
    ["Same failing command retried 3+ times", (g) => g.findingCounts["retry-loop"] || 0],
  ],
  you: [
    ["Your messages", (g) => g.userMessages],
    ['Pushback ("no", "I told you", "revert"…)', (g) => g.corrections],
    ["Times you interrupted the agent", (g) => g.interrupts],
    ["Risky git commands", (g) => Object.values(g.risky).reduce((a, b) => a + b, 0)],
  ],
};

// Newest agent versions this release was checked against. Logs from newer versions are
// still read, but formats change: the report says so instead of failing quietly.
export const TESTED = { claude: "2.1.314", codex: "0.166.0" };

const parts = (v) => String(v).split(/[^\d]+/).filter(Boolean).map(Number);
export function compareVersions(a, b) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** "2.1.220–2.1.314" for the versions seen, and whether any is newer than tested. */
export function versionRange(agent, versions) {
  if (!versions?.length) return null;
  const sorted = [...versions].sort(compareVersions);
  const lo = sorted[0], hi = sorted[sorted.length - 1];
  return { text: lo === hi ? lo : `${lo}–${hi}`, newer: compareVersions(hi, TESTED[agent] || "0") > 0 };
}
