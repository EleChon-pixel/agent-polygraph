import os from "node:os";
import path from "node:path";
import {
  isTestCommand,
  mayWriteFiles,
  isFullSuite,
  isTestLogRead,
  outcomeFromOutput,
  testOutcome,
  findTestClaim,
  isTestPath,
  isCodePath,
  weakening,
  assertionLines,
  riskyIn,
  isCorrection,
  splitCommands,
  shellWrites,
  ECHOES,
  passedCount,
  claimedCounts,
  claimedTestFiles,
  expandVars,
  findCiClaim,
  claimsFullSuite,
} from "./classify.js";

export const VERDICTS = ["backed", "no-run", "stale", "failed", "unknown"];

/**
 * Walk one session's events in order and collect findings.
 *
 * Freshness is decided by event order, not timestamps (many events share one). A test
 * counts as evidence only once its `result` event has been observed, and it covers the
 * code as it was when the test *started*: an edit after the start makes it stale.
 */
export function analyzeSession(session) {
  const s = {
    agent: session.agent,
    id: session.id,
    file: session.file,
    cwd: session.cwd,
    model: session.models[0] || "unknown",
    versions: session.versions || [],
    start: session.start,
    end: session.end,
    claims: Object.fromEntries(VERDICTS.map((v) => [v, 0])),
    testRuns: 0,
    failingRuns: 0,
    testMs: 0,
    fullSuiteRuns: 0,
    fullSuiteMs: 0,
    commands: 0,
    edits: 0,
    userMessages: 0,
    corrections: 0,
    interrupts: 0,
    risky: {},
    unclear: {}, // reason -> count, for claims we couldn't judge
    evidence: {}, // outside evidence used: { recorded, terminal, ci, snapshot }
    findings: [],
  };

  let lastCodeEdit = null; // { i, path }
  let shellCwd = session.cwd; // Claude Code's persistent shell directory
  // $HOME only when the session ran on this machine's account
  const home = os.homedir();
  const homeEnv = session.cwd && norm(session.cwd).startsWith(norm(home)) ? { HOME: home } : {};
  const codeEdits = []; // { i, path, abs }: abs is the resolved location, when known
  let lastUncertain = -1; // index of the last change we couldn't pin down
  let lastSnap = null; // { i, tree }: the latest working-tree snapshot from `record`
  let lastTest = null; // evidence: { i (start index), ts, outcome, cmd, tail, sub }
  const runs = new Map(); // start index -> every observed test run, for claims about a subset
  let pendingTest = -1; // index of the latest test start still waiting for its result
  let sinceFail = null; // edits made since a failing test run
  let lastFailedCmd = null;
  let repeat = 0;
  let editsSinceLastCmd = 0;
  const started = new Map(); // cmd event -> { i, test, editsBefore, counted }
  const logs = new Map(); // log file basename -> cmd event of the test run writing it
  const created = new Set(); // files the agent created this session
  const touchedTests = new Set(); // test files the agent has edited so far

  const rel = (p) => relPath(p, session.cwd);
  const finding = (type, ev, detail) => s.findings.push({ type, ts: ev.ts, detail, agent: s.agent, file: s.file, cwd: s.cwd });

  const absOf = (p, dir) => {
    if (!p) return null;
    p = norm(p);
    if (isAbs(p)) return p;
    const base = norm(dir || session.cwd);
    return base ? path.posix.join(base, p) : null;
  };
  const codeEdit = (i, p, ev, abs) => {
    const test = isTestPath(p);
    // any non-test change (templates, styles, config) counts as working on the code
    if (sinceFail) test ? sinceFail.testEdits.add(p) : sinceFail.codeEdits++;
    if (test) touchedTests.add(p);
    if (!isCodePath(p)) return;
    s.edits++;
    editsSinceLastCmd++;
    lastCodeEdit = { i, path: p };
    codeEdits.push({ i, path: p, abs });
    if (!ev) return;
    const fresh = ev.op === "add" || created.has(p);
    if (ev.op === "add") created.add(p);
    // only tests that existed before the agent touched them can be weakened
    if (test && !fresh) {
      const reasons = ev.op === "delete" ? ["deleted the test file"] : ev.removed ? weakening(ev.removed, ev.added) : [];
      if (reasons.length) finding("weakened-test", ev, { path: p, reasons, removed: sample(assertionLines(ev.removed).length ? assertionLines(ev.removed) : ev.removed) });
    }
  };

  /** What a command's result tells us: test outcome, retry loops, test-only fixes. */
  const observe = (ev) => {
    const c = ev.of;
    const st = started.get(c);
    if (!st) return;
    const cmd = c.cmd;
    if (ev.denied) {
      // it never ran: not a test run, not evidence
      if (st.test && !c.external) {
        s.testRuns--;
        if (isFullSuite(cmd)) s.fullSuiteRuns--;
      }
      if (pendingTest === st.i) pendingTest = -1;
      started.delete(c);
      return;
    }
    const reset = /Shell cwd was reset to (\S+)/.exec(ev.output || "");
    if (reset) shellCwd = reset[1];
    // a program that prints a test-runner summary is a test run, whatever it's called
    // (`./build/frost_subsystems.exe` -> "135 passed, 0 failed"), unless it only prints
    // saved text (cat, git show) or reads a log
    if (!st.test && !ev.partial && !isLogRead(cmd) && !ECHOES.test(cmd) && outcomeFromOutput(ev.output)) {
      st.test = true;
      s.testRuns++;
    }

    if (!ev.partial && !c.external) {
      const failed = ev.exitCode != null ? ev.exitCode !== 0 : ev.isError === true;
      const key = cmd.trim().replace(/\s+/g, " ");
      if (failed && key === lastFailedCmd && st.editsBefore === 0) {
        repeat++;
        if (repeat === 3) finding("retry-loop", ev, { cmd: clip(cmd, 200) });
      } else {
        repeat = failed ? 1 : 0;
      }
      lastFailedCmd = failed ? key : null;
    }

    let run = c;
    let runStart = st;
    let outcome;
    if (st.test) {
      // merge what we know about this run (exit status, output seen so far)
      st.exitCode = ev.exitCode ?? st.exitCode;
      st.isError = ev.isError ?? st.isError;
      st.output = ((st.output || "") + "\n" + (ev.output || "")).slice(-6000);
      outcome = ev.outcome ?? testOutcome({ cmd, exitCode: st.exitCode, isError: st.isError, output: st.output });
      // the runner's summary `record` saved from the full output, when the log's copy has
      // none: printed results beat exit codes, as everywhere else
      if (!ev.outcome && c.recorded?.outcome && !outcomeFromOutput(st.output) && outcome !== c.recorded.outcome) {
        outcome = c.recorded.outcome;
        s.evidence.recorded = (s.evidence.recorded || 0) + 1;
      }
      if (ev.ms > 0 && !st.timed && !c.external) {
        st.timed = true;
        s.testMs += ev.ms;
        if (isFullSuite(cmd)) s.fullSuiteMs += ev.ms;
      }
    } else if (isLogRead(cmd)) {
      // reading a log is evidence about the run that wrote it, never a new run
      // the log's file name must appear as a path in the command, not just as a substring
      const words = cmd.split(/[\s;&|<>"'()]+/).map(basename);
      const writer = [...logs.entries()].find(([name]) => words.includes(name))?.[1];
      outcome = outcomeFromOutput(ev.output);
      if (!writer || !outcome) return;
      run = writer;
      runStart = started.get(writer);
    } else return;

    if (c.external) {
      // evidence only: no retry loops or test-only fixes for runs the agent didn't make
    } else if (outcome === "fail" && !runStart.countedFail) {
      runStart.countedFail = true;
      s.failingRuns++;
      if (!sinceFail) sinceFail = { testEdits: new Set(), codeEdits: 0, cmd: run.cmd, touchedBefore: new Set(touchedTests) };
    } else if (outcome === "pass" && sinceFail) {
      // fixing a test the agent itself wrote or edited earlier is normal; changing a
      // test it hadn't touched, and nothing else, is what deserves a look
      const preexisting = [...sinceFail.testEdits].filter((t) => !sinceFail.touchedBefore.has(t) && !created.has(t));
      if (preexisting.length && sinceFail.codeEdits === 0) {
        finding("test-only-fix", ev, { cmd: clip(run.cmd, 200), tests: preexisting.slice(0, 5) });
      }
      sinceFail = null;
    }
    // evidence about an older run never replaces evidence about a newer one
    if (!lastTest || runStart.i >= lastTest.i) {
      lastTest = { i: runStart.i, ts: run.ts, outcome, cmd: run.cmd, tail: tail(runStart.output || ev.output), sub: run.sub, dir: runStart.dir, tree: run.tree, external: run.external };
    }
    // every observed run, so a claim can be judged against the run it talks about
    if (outcome) {
      const prev = runs.get(runStart.i);
      const count = passedCount(runStart.output || ev.output) ?? run.recorded?.passed ?? prev?.count ?? null;
      runs.set(runStart.i, { i: runStart.i, ts: run.ts, outcome, cmd: run.cmd, tail: tail(runStart.output || ev.output), sub: run.sub, dir: runStart.dir, count, full: isFullSuite(run.cmd), tree: run.tree, external: run.external });
      if (lastTest.i === runStart.i) lastTest.count = count;
    }
  };

  /** Files that differ between two `record` snapshots of one checkout, or null if unknown. */
  const snapshotDiff = (a, b) => {
    if (!a || !b || !session.treeDiff || a.root !== b.root) return null;
    if (a.tree && b.tree && a.tree === b.tree) return [];
    try {
      const out = session.treeDiff(a, b);
      return Array.isArray(out) ? out : null;
    } catch {
      return null;
    }
  };

  /**
   * "CI is green": judged only with --ci, against the GitHub Actions runs for the commit
   * most recently pushed before the claim (or, without a push, the branch's latest).
   */
  const judgeCiClaim = (ev) => {
    const claim = findCiClaim(ev.text);
    if (!claim) return;
    const before = session.ci.runs.filter((r) => r.created <= ev.ts);
    let verdict, why;
    if (!before.length) [verdict, why] = ["unknown", "no CI run found"];
    else {
      const sha = before.reduce((a, b) => (b.created > a.created ? b : a)).sha;
      const forSha = before.filter((r) => r.sha === sha);
      if (forSha.some((r) => r.completed && r.completed <= ev.ts && r.conclusion === "failure")) verdict = "failed";
      else if (forSha.some((r) => !r.completed || r.completed > ev.ts)) [verdict, why] = ["unknown", "CI still running"];
      else if (forSha.every((r) => ["success", "skipped", "neutral"].includes(r.conclusion))) verdict = "backed";
      else [verdict, why] = ["unknown", "CI run didn't finish normally"];
    }
    s.claims[verdict]++;
    s.evidence.ci = (s.evidence.ci || 0) + 1;
    ev.verdict = verdict;
    const latest = before.length ? before.reduce((a, b) => (b.created > a.created ? b : a)) : null;
    const lastTestOf = latest && { cmd: `CI: ${latest.name} (${latest.sha.slice(0, 7)})`, outcome: latest.conclusion, ago: ev.ts - (latest.completed || latest.created), tail: latest.url };
    if (why) {
      s.unclear[why] = (s.unclear[why] || 0) + 1;
      finding("unclear", ev, { why, claim: clip(claim, 240), ci: true, lastTest: lastTestOf });
    } else if (verdict !== "backed") finding("claim", ev, { verdict, claim: clip(claim, 240), ci: true, lastTest: lastTestOf });
  };

  session.events.forEach((ev, i) => {
    switch (ev.kind) {
      case "edit": {
        const p = rel(ev.path);
        if (!p) break;
        // a brand-new throwaway program (Write of check3.cpp, m0_debug2.cpp) is treated like
        // one written through the shell; edits to existing files always count
        if (ev.op === "add") {
          const name = norm(ev.path).split("/").pop();
          if (SCRATCH_NAME.test(name)) break;
          if (DEBUG_AID.test(name) && isCodePath(name)) {
            lastUncertain = i;
            break;
          }
        }
        codeEdit(i, p, ev, absOf(ev.path));
        break;
      }
      case "uncertain":
        lastUncertain = i;
        break;
      case "cmd": {
        const cmd = ev.cmd;
        if (ev.tree) lastSnap = { i, tree: ev.tree };
        if (ev.external) {
          // a run outside the agent (your terminal, CI): evidence only, not the agent's work
          started.set(ev, { i, test: true, editsBefore: 0, dir: ev.workdir || session.cwd });
          break;
        }
        s.commands++;
        if (sinceFail && mayWriteFiles(cmd)) sinceFail.codeEdits++;
        for (const r of riskyIn(cmd)) {
          s.risky[r.id] = (s.risky[r.id] || 0) + 1;
          finding("risky", ev, { id: r.id, label: r.label, cmd: clip(cmd, 200) });
        }
        for (const p of createdBy(cmd)) created.add(rel(p) || p);
        for (const p of deletedTestFiles(cmd)) {
          if (!created.has(rel(p) || p)) finding("weakened-test", ev, { path: p, reasons: ["deleted the test file"], cmd: clip(cmd, 200) });
        }
        // files written through the shell are edits too; writes we can't name are doubt
        // variables assigned in the same command (S=/tmp/x; cat > $S/f.py) are expanded first
        const resolved = expandVars(cmd, homeEnv);
        const writes = shellWrites(resolved);
        // Where this command runs. Claude Code's shell keeps its directory between
        // commands (until it reports a reset); Codex gives each command its own workdir.
        const here = ev.workdir || shellCwd;
        const steps = cdSteps(resolved, here);
        const cdTo = steps.length ? steps[steps.length - 1].dir : undefined;
        const dir = cdTo === undefined ? here : cdTo;
        if (session.agent === "claude" && cdTo !== undefined) shellCwd = cdTo;
        for (const w of writes.paths) {
          // `cd /elsewhere && cat > x.py`: relative targets follow the cd in effect where
          // they appear (`cd /tmp && python3 - <<EOF … open('x.py','w') … EOF\ncd /repo`)
          const pos = resolved.indexOf(w);
          const step = pos < 0 ? steps[steps.length - 1] : steps.findLast((c) => c.index < pos);
          const wdir = step ? step.dir : here;
          if (!isAbs(norm(w)) && wdir === null) continue; // cd into a $variable: unknown
          // Throwaway programs written through the shell aren't the code under test: clearly
          // throwaway names (check3.cpp, tmp_x.py) are ignored; names that only look like a
          // debugging aid (m0_debug2.cpp) make the claim unjudgeable rather than stale
          const name = norm(w).split("/").pop();
          if (SCRATCH_NAME.test(name)) continue;
          if (DEBUG_AID.test(name) && isCodePath(name)) {
            lastUncertain = i;
            continue;
          }
          const abs = absOf(w, wdir);
          const p = rel(abs || w);
          if (p) codeEdit(i, p, null, abs);
        }
        if (writes.unresolved) lastUncertain = i;

        const test = isTestCommand(cmd);
        // where the test ran: an edit in another checkout or subproject can't make it stale
        started.set(ev, { i, test, editsBefore: editsSinceLastCmd, dir: dir === undefined ? session.cwd : dir });
        editsSinceLastCmd = 0;
        if (test) {
          s.testRuns++;
          if (isFullSuite(cmd)) s.fullSuiteRuns++;
          pendingTest = i;
          for (const log of redirectTargets(resolved)) logs.set(basename(log), ev);
        }
        // Older event format (and hand-built events): a command carrying its own result.
        // The parsers emit separate `result` events instead.
        if ("exitCode" in ev || "output" in ev || "isError" in ev) {
          observe({ kind: "result", of: ev, ts: ev.ts, exitCode: ev.exitCode ?? null, isError: ev.isError ?? null, output: ev.output ?? "", ms: ev.ms });
        }
        break;
      }
      case "result":
        observe(ev);
        break;
      case "say": {
        const claim = findTestClaim(ev.text);
        if (!claim) {
          if (session.ci) judgeCiClaim(ev);
          break;
        }
        let verdict;
        let why; // for "unknown": which piece of evidence is missing
        // Judge the claim against the run it talks about: "31/31 VM tests pass" refers to
        // the run that reported 31 passed, "test_api.py passes" to a run of that file,
        // "the full suite passes" to the latest run as large as the session's full runs.
        // Without such a hint, the latest run.
        const ref = referencedRun(claim, runs, lastTest) || lastTest;
        let staleEdit = ref && codeEdits.findLast((e) => e.i > ref.i && within(e.abs, ref.dir));
        // a change we couldn't follow, settled by comparing `record` snapshots of the
        // working tree after the run and after the change
        let uncertain = ref && lastUncertain > ref.i;
        if (ref && uncertain && !staleEdit) {
          const changed = snapshotDiff(ref.tree, lastSnap && lastSnap.i >= lastUncertain ? lastSnap.tree : null);
          if (changed) {
            uncertain = false;
            s.evidence.snapshot = (s.evidence.snapshot || 0) + 1;
            // the whole checkout is compared; only changes where the test ran count, as for edits
            const code = changed.filter((p) => isCodePath(p) && !SCRATCH_NAME.test(p.split("/").pop()) && within(path.posix.join(norm(ref.tree.root), p), ref.dir));
            if (code.length) staleEdit = { path: code[0], snapshot: true };
          }
        }
        if (!ref) {
          // a run still in progress, or no edits and no runs (the agent is talking about
          // something else, like a CV or a doc): nothing to judge
          verdict = pendingTest >= 0 || !lastCodeEdit ? "unknown" : "no-run";
          if (verdict === "unknown") why = pendingTest >= 0 ? "test still running" : "no code work in session";
        } else if (staleEdit) verdict = "stale";
        else if (uncertain) [verdict, why] = ["unknown", "unresolved file change after the run"];
        // a subagent's failing run in its own worktree says little about the main checkout
        else if (ref.outcome === "fail") [verdict, why] = ref.sub ? ["unknown", "subagent run failed"] : ["failed"];
        else if (ref.outcome == null) [verdict, why] = ["unknown", "test result unreadable"];
        else verdict = "backed";
        s.claims[verdict]++;
        ev.verdict = verdict;
        if (why) {
          s.unclear[why] = (s.unclear[why] || 0) + 1;
          finding("unclear", ev, { why, claim: clip(claim, 240), lastTest: ref && { cmd: clip(ref.cmd, 160), tail: ref.tail } });
        }
        if (ref?.external) s.evidence[ref.external] = (s.evidence[ref.external] || 0) + 1;
        if (verdict !== "backed" && verdict !== "unknown") {
          finding("claim", ev, {
            verdict,
            claim: clip(claim, 240),
            lastTest: ref && { cmd: clip(ref.cmd, 160), outcome: ref.outcome, ago: ev.ts - ref.ts, tail: ref.tail, matched: ref !== lastTest || undefined },
            editedAfter: verdict === "stale" ? staleEdit.path : undefined,
          });
        }
        break;
      }
      case "user":
        s.userMessages++;
        // runner output you pasted (from another terminal, CI) is evidence from that point on
        {
          const pasted = outcomeFromOutput(ev.text);
          if (pasted) {
            const run = { i, ts: ev.ts, outcome: pasted, cmd: "(test output you pasted)", tail: tail(ev.text), sub: false, dir: null, count: passedCount(ev.text), full: false };
            runs.set(i, run);
            lastTest = run;
          }
        }
        if (isCorrection(ev.text)) {
          s.corrections++;
          finding("correction", ev, { text: clip(ev.text, 160) });
        }
        break;
      case "interrupt":
        s.interrupts++;
        break;
    }
  });
  return s;
}

/**
 * Every `cd` in a command, in order, as { index, dir }: dir is where the shell is after it,
 * null when that can't be resolved (`cd "$W"`, or a relative cd after one).
 */
function cdSteps(cmd, base) {
  // cd, and PowerShell's Set-Location / Push-Location; the last one wins
  // a cd inside a quoted string (`ssh host 'cd /srv && make'`) moves some other shell
  const quoted = [...cmd.matchAll(/'[^']*'|"(?:[^"\\]|\\.)*"/g)].map((q) => [q.index, q.index + q[0].length]);
  const inQuotes = (k) => quoted.some(([a, b]) => k > a && k < b);
  const all = [...cmd.matchAll(/(?:^|[;&|\n]\s*)(?:cd|pushd|Set-Location|Push-Location|sl)\s+(?:-(?:Path|LiteralPath)\s+)?("[^"]*"|'[^']*'|[^\s;&|]+)/gi)].filter((m) => !inQuotes(m.index + m[0].search(/\S/)));
  const steps = [];
  let cur = base ? norm(base) : null;
  for (const m of all) {
    const d = m[1].replace(/^["']|["']$/g, "");
    if (/[$`]/.test(d)) cur = null;
    else if (d === "~" || d.startsWith("~/")) cur = path.posix.join(norm(os.homedir()), d.slice(1));
    else if (isAbs(norm(d))) cur = norm(d);
    // `cd web`: relative to where the shell already is, if we know
    else cur = cur ? path.posix.join(cur, norm(d)) : null;
    steps.push({ index: m.index, dir: cur });
  }
  return steps;
}

/** Is a file inside the directory a test ran in? Unknown locations count as inside. */
function within(abs, dir) {
  if (!abs || !dir) return true;
  abs = norm(abs);
  dir = norm(dir).replace(/\/$/, "");
  // Windows paths are case-insensitive
  if (/^[a-z]:\//.test(abs)) [abs, dir] = [abs.toLowerCase(), dir.toLowerCase()];
  return abs === dir || abs.startsWith(dir + "/");
}

// bare throwaway names only: check3.cpp, tmp.py, tmp_parse.js, repro2.c (not checkout.py)
const SCRATCH_NAME = /^(?:check|tmp|temp|scratch|repro|try|probe)\d*\.\w+$|^(?:tmp|temp|scratch|repro|check|try|probe)[_-]\w+\.\w+$/i;

const DEBUG_AID = /(?:^|[_.-])(?:debug|diag|dbg|probe|scratch|repro|check|try)(?:\d+|[_.-])/i;

/**
 * The run a claim names by its count or by a test file, when it clearly isn't the latest
 * run: the latest run's count is known and differs, or it didn't run the named file. When
 * the latest run could be the one meant (its count unknown, say), it stays the reference.
 */
function referencedRun(claim, runs, latest) {
  const counts = claimedCounts(claim);
  const files = claimedTestFiles(claim);
  if (!counts.size && !files.length && claimsFullSuite(claim)) return fullSuiteRun(runs, latest);
  // Only precise hints (a pass count, a test file). Words like "full suite" were tried and
  // dropped: telling a full run from a focused one is too unreliable to accuse an agent with.
  if (!counts.size && !files.length) return null;
  if (latest) {
    const latestFits = (latest.count == null || counts.has(latest.count) || !counts.size) && (!files.length || files.some((f) => latest.cmd.includes(f)));
    const latestCount = runs.get(latest.i)?.count;
    if (latestFits && (latestCount == null || counts.has(latestCount) || !counts.size)) return null;
  }
  let best = null;
  for (const r of runs.values()) {
    const byCount = r.count != null && counts.has(r.count);
    const byFile = files.some((f) => r.cmd.includes(f));
    if ((byCount || byFile) && (!best || r.i > best.i)) best = r;
  }
  return best;
}

/**
 * "The full suite passes": when the latest run in that checkout clearly ran far fewer
 * tests than the session's largest run, the claim is about the latest run that was full
 * size. Judged by the counts runners printed, never by the command (too unreliable).
 */
function fullSuiteRun(runs, latest) {
  if (!latest || latest.count == null) return null;
  const same = [...runs.values()].filter((r) => r.count != null && !r.external && sameDir(r.dir, latest.dir));
  const max = Math.max(...same.map((r) => r.count));
  // a different command, and under half the size: a focused run, not the suite shrinking
  if (!(latest.count < max / 2)) return null;
  const big = same.filter((r) => r.count >= max * 0.9 && r.cmd !== latest.cmd);
  return big.length ? big.reduce((a, b) => (b.i > a.i ? b : a)) : null;
}

const sameDir = (a, b) => (a && b ? norm(a).replace(/\/$/, "") === norm(b).replace(/\/$/, "") : a === b);

/** Files a test command sends its output to (`> out.log`, `tee run.txt`). */
function redirectTargets(cmd) {
  return shellWrites(cmd).paths.filter((p) => !isCodePath(p));
}

const isLogRead = (cmd) => /(?:^|[\s;&|])(?:tail|cat|head|less|more|grep|rg)\s/.test(cmd) || isTestLogRead(cmd);
const basename = (p) => p.split("/").pop();

function createdBy(cmd) {
  const out = [];
  for (const m of cmd.matchAll(/(?:cat|tee)\s*(?:-a\s*)?>?\s*([^\s<>|;&]+\.\w+)\s*<<|(?:^|[\s;&])>\s*([^\s<>|;&]+\.\w+)/g)) out.push(m[1] || m[2]);
  return out;
}

function deletedTestFiles(cmd) {
  const out = [];
  for (const part of splitCommands(cmd)) {
    const m = /^\s*(?:git\s+rm|rm)\s+(.+)$/.exec(part);
    if (!m) continue;
    for (const tok of m[1].split(/\s+/)) {
      if (!tok.startsWith("-") && isCodePath(tok) && isTestPath(tok) && !/tmp|dbg|debug|scratch|repro/i.test(tok)) out.push(tok);
    }
  }
  return out;
}

function relPath(p, cwd) {
  if (!p) return "";
  p = norm(p);
  cwd = norm(cwd);
  if (cwd && isAbs(p)) {
    const r = path.posix.relative(cwd, p);
    if (!r.startsWith("..")) return r;
    if (/^\/(?:tmp|var\/tmp|private\/tmp)\/|^[a-z]:\/users\/[^/]+\/appdata\/local\/temp\//i.test(p)) return ""; // scratch files
    return p.replace(/^\/(?:home|Users)\/[^/]+\/|^[a-z]:\/users\/[^/]+\//i, "~/");
  }
  return p.replace(/^\.\//, "");
}

/**
 * Paths compared as strings: forward slashes, lower-case drive letter. Windows paths
 * (`d:\Epilog\src\x.cpp`) come from Claude Code on Windows and must work on any host.
 */
function norm(p) {
  if (!p) return p;
  return p.replace(/\\/g, "/").replace(/^([A-Za-z]):(?=\/|$)/, (_, d) => d.toLowerCase() + ":").replace(/\/{2,}/g, "/");
}
const isAbs = (p) => /^(?:\/|[a-z]:\/)/i.test(p);

const clip = (s, n) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
const tail = (out) => (out || "").trim().split("\n").slice(-6).map((l) => l.slice(0, 160)).join("\n");
const sample = (lines) => (lines ? lines.filter((l) => l.trim()).slice(0, 4).map((l) => clip(l, 100)) : undefined);

/** Roll session results up by agent and by model. */
export function aggregate(sessions) {
  const groups = { all: blank() };
  for (const s of sessions) {
    for (const key of ["all", `agent:${s.agent}`, `model:${s.model}`]) {
      const g = (groups[key] ||= blank());
      g.sessions++;
      g.activeSessions += s.commands + s.edits > 0 ? 1 : 0;
      for (const v of VERDICTS) g.claims[v] += s.claims[v];
      for (const k of ["testRuns", "failingRuns", "testMs", "fullSuiteRuns", "fullSuiteMs", "commands", "edits", "userMessages", "corrections", "interrupts"]) g[k] += s[k];
      for (const [k, v] of Object.entries(s.risky)) g.risky[k] = (g.risky[k] || 0) + v;
      for (const [k, v] of Object.entries(s.unclear || {})) g.unclear[k] = (g.unclear[k] || 0) + v;
      for (const [k, v] of Object.entries(s.evidence || {})) g.evidence[k] = (g.evidence[k] || 0) + v;
      for (const v of s.versions || []) if (!g.versions.includes(v)) g.versions.push(v);
      for (const f of s.findings) g.findingCounts[f.type] = (g.findingCounts[f.type] || 0) + 1;
      g.start = Math.min(g.start ?? s.start ?? Infinity, s.start ?? Infinity);
      g.end = Math.max(g.end ?? 0, s.end ?? 0);
    }
  }
  for (const g of Object.values(groups)) {
    const judged = g.claims.backed + g.claims["no-run"] + g.claims.stale + g.claims.failed;
    g.claimsTotal = judged + g.claims.unknown;
    g.receiptRate = judged ? g.claims.backed / judged : null;
  }
  return groups;
}

function blank() {
  return {
    sessions: 0,
    activeSessions: 0,
    claims: Object.fromEntries(VERDICTS.map((v) => [v, 0])),
    testRuns: 0,
    failingRuns: 0,
    testMs: 0,
    fullSuiteRuns: 0,
    fullSuiteMs: 0,
    commands: 0,
    edits: 0,
    userMessages: 0,
    corrections: 0,
    interrupts: 0,
    risky: {},
    unclear: {},
    evidence: {},
    versions: [],
    findingCounts: {},
    start: null,
    end: null,
  };
}
