// A self-contained, numbers-only report meant to be screenshotted or shared.
// Never put prompts, file paths, commands or claim text in here.

import { ROWS, columns, pct, range } from "./format.js";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function renderHtml({ groups, by = "agent", version, demo = false, skipped = 0, unrecognized = 0 }) {
  const cols = columns(groups, by);
  const all = groups.all;
  const head = cols.map((c) => `<th>${esc(c.label)}</th>`).join("");
  // "…" rows break down the row above them; like the terminal, hide them when all zero
  const table = (rows) =>
    rows
      .filter(([label, fn]) => !label.startsWith("…") || cols.some((c) => Number(fn(c.g)) > 0))
      .map(([label, fn]) => {
        const cls = label.startsWith("…") ? ' class="sub"' : "";
        return `<tr${cls}><td>${esc(label)}</td>${cols.map((c) => `<td>${esc(fn(c.g))}</td>`).join("")}</tr>`;
      })
      .join("");
  const rate = `<tr class="total"><td>Receipt rate</td>${cols.map((c) => `<td>${esc(pct(c.g.receiptRate))}</td>`).join("")}</tr>`;

  const tiles = cols
    .filter((c) => c.key !== "all" || cols.length === 1)
    .map((c) => {
      const r = c.g.receiptRate;
      const judged = c.g.claimsTotal - c.g.claims.unknown;
      const unclear = c.g.claims.unknown;
      const tone = r == null ? "" : r >= 0.95 ? "good" : r >= 0.8 ? "warn" : "bad";
      return `<div class="tile ${tone}">
  <div class="tile-label">${esc(c.label)}</div>
  <div class="tile-value">${esc(pct(r))}</div>
  <div class="tile-sub">${c.g.claims.backed} of ${judged} “tests pass” claims had a fresh passing run${unclear ? `; ${unclear} more couldn't be judged` : ""}</div>
  <div class="bar"><span style="width:${r == null ? 0 : Math.round(r * 100)}%"></span></div>
</div>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Polygraph Report</title>
<style>
:root{--bg:#f6f5f1;--card:#fff;--ink:#16181d;--muted:#6b6f78;--line:#e4e2dc;--good:#1f8a4c;--warn:#b7791f;--bad:#c0392b;--accent:#3949ab}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#111317;--card:#1a1d23;--ink:#eceef2;--muted:#9aa0ab;--line:#2a2e36;--good:#4cc38a;--warn:#e0a84a;--bad:#ef6b5e;--accent:#8c9eff}}
:root[data-theme=dark]{--bg:#111317;--card:#1a1d23;--ink:#eceef2;--muted:#9aa0ab;--line:#2a2e36;--good:#4cc38a;--warn:#e0a84a;--bad:#ef6b5e;--accent:#8c9eff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 16px 56px}
h1{font-size:28px;letter-spacing:-.02em;margin:0}
.meta{color:var(--muted);margin:4px 0 28px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:28px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 18px 16px}
.tile-label{color:var(--muted);font-size:13px;text-transform:uppercase;letter-spacing:.06em}
.tile-value{font-size:52px;font-weight:700;letter-spacing:-.03em;line-height:1.1;margin:6px 0 2px;font-variant-numeric:tabular-nums}
.tile.good .tile-value{color:var(--good)}.tile.warn .tile-value{color:var(--warn)}.tile.bad .tile-value{color:var(--bad)}
.tile-sub{color:var(--muted);font-size:13px}
.bar{height:6px;background:var(--line);border-radius:3px;margin-top:12px;overflow:hidden}
.bar span{display:block;height:100%;background:currentColor}
.tile.good .bar{color:var(--good)}.tile.warn .bar{color:var(--warn)}.tile.bad .bar{color:var(--bad)}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:6px 18px 10px;margin-bottom:14px;overflow-x:auto}
h2{font-size:15px;margin:14px 0 4px}
h2 small{color:var(--muted);font-weight:400}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{padding:7px 0;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th{color:var(--muted);font-weight:500;font-size:13px}
th:first-child,td:first-child{text-align:left;white-space:normal;padding-right:12px}
td+td,th+th{padding-left:16px}
tr:last-child td{border-bottom:0}
tr.sub td{color:var(--muted);font-size:13px;padding-top:4px;padding-bottom:4px}
tr.sub td:first-child{padding-left:14px}
tr.total td{font-weight:600}
.note{color:var(--warn);font-size:13px;margin:-16px 0 24px}
.demo{display:inline-block;margin:10px 0 0;padding:4px 10px;border-radius:999px;background:var(--warn);color:var(--card);font-size:13px;font-weight:600}
footer{color:var(--muted);font-size:13px;margin-top:22px}
footer a{color:var(--accent)}
</style>
</head>
<body>
<main>
<h1>Did my coding agents show their work?</h1>${demo ? '\n<p class="demo">Demo data: generated sessions with invented numbers, not a benchmark of any agent.</p>' : ""}
<p class="meta">${all.activeSessions} working sessions · ${esc(range(all))} · ${all.testRuns.toLocaleString("en-US")} test runs checked</p>${skipped ? `\n<p class="note">${skipped} session file${skipped === 1 ? "" : "s"} couldn't be read and ${skipped === 1 ? "is" : "are"} not included.</p>` : ""}${unrecognized ? `\n<p class="note">${unrecognized} session file${unrecognized === 1 ? " is" : "s are"} in a log format this version doesn't recognize and not included.</p>` : ""}
<div class="tiles">
${tiles}
</div>
<section><h2>“Tests pass” claims <small>was there a passing run after the last code edit?</small></h2>
<table><tr><th></th>${head}</tr>${table(ROWS.claims)}${table(ROWS.unclear)}${rate}</table></section>
<section><h2>Test integrity <small>worth a second look, not proof of cheating</small></h2>
<table><tr><th></th>${head}</tr>${table(ROWS.integrity)}</table></section>
<section><h2>Where the time went</h2>
<table><tr><th></th>${head}</tr>${table(ROWS.time)}</table></section>
<section><h2>You and the agent</h2>
<table><tr><th></th>${head}</tr>${table(ROWS.you)}</table></section>
<footer>Generated locally by <a href="https://github.com/EleChon-pixel/agent-polygraph">agent-polygraph</a>${version ? " " + esc(version) : ""} from Claude Code and Codex session logs. Numbers only: no prompts, code or file paths are included. Run your own: <code>npx agent-polygraph</code></footer>
</main>
</body>
</html>
`;
}
