import os from "node:os";
import { AGENT_NAMES, ROWS, TESTED, columns, day, duration, pct, range, versionRange } from "./format.js";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint("1");
const dim = paint("2");
const red = paint("31");
const green = paint("32");
const yellow = paint("33");
const cyan = paint("36");

const VERDICT_LABEL = {
  "no-run": "no test run in the session",
  stale: "code edited after the last run",
  failed: "the last test run had failed",
};

export function renderTerminal({ sessions, groups, seconds, by = "agent", examples = 5, demo = false }) {
  const out = [];
  const cols = columns(groups, by);
  const all = groups.all;
  const W = 44;
  const CW = Math.max(12, ...cols.map((c) => c.label.length + 2));

  const header = (title, sub) => {
    out.push("");
    out.push(bold(title) + (sub ? dim("  " + sub) : ""));
    out.push(dim(" ".repeat(W) + cols.map((c) => c.label.padStart(CW)).join("")));
  };
  const row = (label, fn, colorize) => {
    const cells = cols.map((c) => {
      const v = fn(c.g);
      const s = String(v).padStart(CW);
      return colorize ? colorize(v, s) : s;
    });
    const padded = label.padEnd(W - 2);
    out.push("  " + (label.startsWith("…") ? dim(padded) : padded) + cells.join(""));
  };
  const warnIfPositive = (v, s) => (typeof v === "number" && v > 0 ? yellow(s) : s);

  out.push("");
  if (!all.activeSessions) {
    out.push(bold("agent-polygraph"));
    out.push("");
    out.push("No Claude Code or Codex sessions with commands or edits found.");
    out.push(dim("Looked in ~/.claude/projects and ~/.codex/sessions (override with --claude-dir / --codex-dir)."));
    return out.join("\n");
  }
  out.push(bold("agent-polygraph") + dim(`  ${all.activeSessions} working sessions · ${range(all)} · ${seconds.toFixed(1)}s`));
  if (demo) out.push(yellow("DEMO DATA: generated sessions, invented numbers. Run without --demo to check your own."));

  header('"Tests pass" claims', "was there a passing run after the last code edit?");
  ROWS.claims.forEach(([label, fn], i) => row(label, fn, i === 0 ? (v, s) => green(s) : i < 4 ? warnIfPositive : null));
  // say why, instead of hiding unclear claims behind the receipt rate
  ROWS.unclear.forEach(([label, fn]) => cols.some((c) => fn(c.g) > 0) && row(label, fn, (v, s) => dim(s)));
  row(
    bold("Receipt rate"),
    (g) => pct(g.receiptRate),
    (v, s) => bold(v === "–" ? s : parseInt(v) >= 95 ? green(s) : parseInt(v) >= 80 ? yellow(s) : red(s)),
  );
  // evidence that came from outside the agents' logs (record, --ci)
  const ev = all.evidence || {};
  const used = [
    [ev.snapshot, "settled by working-tree snapshots"],
    [ev.recorded, "read from recorded test output"],
    [ev.terminal, "judged by test runs in your terminal"],
    [ev.ci, "judged with GitHub Actions"],
  ].filter(([n]) => n > 0);
  if (used.length) out.push(dim("  Beyond the logs: " + used.map(([n, what]) => `${n} ${what}`).join(" · ")));

  header("Test integrity", "worth a second look, not proof of cheating");
  ROWS.integrity.forEach(([label, fn]) => row(label, fn, warnIfPositive));

  header("Where the time went");
  ROWS.time.forEach(([label, fn]) => row(label, fn));

  header("You and the agent");
  ROWS.you.forEach(([label, fn]) => row(label, fn));

  if (sessions.unrecognized?.length) {
    out.push("");
    out.push(yellow(`${sessions.unrecognized.length} session file(s) are in a log format this version doesn't recognize and are not included.`) + dim(" Please report it, with your agent's version."));
  }
  if (sessions.skipped?.length) {
    out.push("");
    out.push(yellow(`${sessions.skipped.length} session file(s) couldn't be read and are not included.`) + dim(" Set POLYGRAPH_DEBUG=1 to see why."));
  }

  if (examples > 0) {
    const all = sessions.flatMap((s) => s.findings);
    const pick = (type) => all.filter((f) => f.type === type).sort((a, b) => b.ts - a.ts).slice(0, examples);
    const claims = pick("claim");
    const fixes = pick("test-only-fix");
    const weak = pick("weakened-test");
    const loops = pick("retry-loop");
    const risky = pick("risky");
    if (claims.length + fixes.length + weak.length + loops.length + risky.length) {
      out.push("");
      out.push(bold("Most recent examples") + dim("  (stays on your machine; --html never includes these)"));
    }
    for (const f of claims) {
      out.push("");
      out.push(`  ${red("✗")} ${bold(VERDICT_LABEL[f.detail.verdict] + (f.detail.ci ? " (CI claim)" : ""))} ${where(f)}`);
      out.push(`    ${cyan("“" + f.detail.claim + "”")}`);
      const lt = f.detail.lastTest;
      if (lt) out.push(dim(`    last test: ${lt.cmd} → ${lt.outcome ?? "?"}, ${duration(lt.ago)} earlier`));
      if (f.detail.editedAfter) out.push(dim(`    then edited: ${f.detail.editedAfter}`));
      out.push(dim(`    ${tilde(f.file)}`));
    }
    for (const f of fixes) {
      out.push("");
      out.push(`  ${yellow("!")} ${bold("failing test made to pass by editing only tests")} ${where(f)}`);
      out.push(dim(`    edited: ${f.detail.tests.join(", ")}`));
      out.push(dim(`    then passed: ${f.detail.cmd}`));
      out.push(dim(`    ${tilde(f.file)}`));
    }
    for (const f of weak) {
      out.push("");
      out.push(`  ${yellow("!")} ${bold(f.detail.reasons.join(", "))}: ${f.detail.path} ${where(f)}`);
      if (f.detail.removed?.length) out.push(dim(`    - ${f.detail.removed.slice(0, 2).join("\n    - ")}`));
      out.push(dim(`    ${tilde(f.file)}`));
    }
    for (const f of loops) {
      out.push("");
      out.push(`  ${yellow("↻")} ${bold("same failing command, 3+ times, nothing changed in between")} ${where(f)}`);
      out.push(dim(`    ${f.detail.cmd}`));
    }
    for (const f of risky) {
      out.push("");
      out.push(`  ${yellow("!")} ${bold(f.detail.label)} ${where(f)}`);
      out.push(dim(`    ${f.detail.cmd}`));
    }
  }

  const seen = ["claude", "codex"].map((a) => [a, versionRange(a, groups[`agent:${a}`]?.versions)]).filter(([, r]) => r);
  if (seen.length) {
    out.push("");
    out.push(dim("Log versions: " + seen.map(([a, r]) => `${AGENT_NAMES[a]} ${r.text}`).join(" · ")));
    for (const [a, r] of seen) if (r.newer) out.push(yellow(`${AGENT_NAMES[a]} logs are newer than the versions this release was tested with (up to ${TESTED[a]}). If numbers look off, please report it.`));
  }
  out.push("");
  out.push(dim("How each number is measured: https://github.com/EleChon-pixel/agent-polygraph#how-it-decides"));
  out.push(dim("A verdict looks wrong? Report it (redacted): https://github.com/EleChon-pixel/agent-polygraph/issues/new/choose"));
  out.push(dim("Share a numbers-only card: npx agent-polygraph --html"));
  out.push(dim("Catch these as they happen: npx agent-polygraph guard --install"));
  if (!used.length) out.push(dim("See what the logs miss: npx agent-polygraph record --install (stays offline), or --ci (asks GitHub)"));
  out.push("");
  return out.join("\n");
}

function where(f) {
  const project = f.cwd ? f.cwd.split("/").filter(Boolean).pop() : "";
  return dim(`· ${AGENT_NAMES[f.agent]} · ${day(f.ts)}${project ? " · " + project : ""}`);
}

function tilde(p) {
  const home = os.homedir();
  return p && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}
