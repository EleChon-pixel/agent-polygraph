// `--ci`: GitHub Actions results as evidence. The one part of agent-polygraph that goes
// online: it asks the GitHub API (through your `gh` login) for the workflow runs of the
// repositories your sessions pushed to. Nothing from your sessions is sent; the requests
// name only the repository, the branch and a date range.
//
// - A successful `git push` followed by a test workflow on the pushed commit becomes a test
//   run in the session: it covers the code as of the push and its result counts from the
//   moment the workflow finished.
// - "CI is green" claims are judged against the runs for the latest pushed commit.

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);
const PUSH = /\bgit\b[^|;&\n]*\bpush\b/;
const TEST_STEP = /\b(?:tests?|pytest|jest|vitest|mocha|spec|rspec|phpunit|unit|e2e|ctest|cargo test|go test|check)\b/i;

export class CiUnavailable extends Error {}

/** Check that `gh` exists and is logged in; throws CiUnavailable with a readable reason. */
export async function checkGh() {
  try {
    await run("gh", ["auth", "status"], { timeout: 15000 });
  } catch (e) {
    if (e.code === "ENOENT") throw new CiUnavailable("--ci needs the GitHub CLI (https://cli.github.com), logged in with `gh auth login`.");
    throw new CiUnavailable("--ci: `gh auth status` failed; log in with `gh auth login` first.");
  }
}

export function makeCi({ gh = ghApi } = {}) {
  const repoCache = new Map();
  const runsCache = new Map();
  const jobsCache = new Map();
  const stats = { repos: new Set(), requests: 0, runs: 0 };

  const repoOf = (cwd) => {
    if (!cwd) return null;
    if (repoCache.has(cwd)) return repoCache.get(cwd);
    let repo = null;
    try {
      const url = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
      const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
      if (m) repo = `${m[1]}/${m[2]}`;
    } catch {}
    repoCache.set(cwd, repo);
    return repo;
  };

  /** Workflow runs of a repository created in [from, to] (ms), every branch. */
  const runsFor = async (repo, from, to) => {
    const day = (t) => new Date(t).toISOString().slice(0, 10);
    const key = `${repo}|${day(from)}|${day(to)}`;
    if (!runsCache.has(key)) {
      runsCache.set(
        key,
        (async () => {
          stats.repos.add(repo);
          const out = [];
          for (let page = 1; page <= 5; page++) {
            stats.requests++;
            const data = await gh(`repos/${repo}/actions/runs`, { created: `${day(from)}..${day(to + 86400000)}`, per_page: "100", page: String(page) });
            const rows = data?.workflow_runs || [];
            out.push(...rows);
            if (rows.length < 100) break;
          }
          return out.map((r) => ({
            id: r.id,
            name: r.name || r.display_title || "workflow",
            sha: r.head_sha,
            branch: r.head_branch,
            event: r.event,
            created: Date.parse(r.created_at),
            completed: r.status === "completed" ? Date.parse(r.updated_at) : null,
            conclusion: r.status === "completed" ? r.conclusion : null,
            url: r.html_url,
          }));
        })().catch(() => []),
      );
    }
    return runsCache.get(key);
  };

  /** Does this workflow run tests (a job or step named like one)? */
  const runsTests = async (repo, r) => {
    if (TEST_STEP.test(r.name)) return true;
    if (!jobsCache.has(r.id)) {
      jobsCache.set(
        r.id,
        (async () => {
          stats.requests++;
          const data = await gh(`repos/${repo}/actions/runs/${r.id}/jobs`, { per_page: "50" });
          return (data?.jobs || []).some((j) => TEST_STEP.test(j.name) || (j.steps || []).some((s) => TEST_STEP.test(s.name)));
        })().catch(() => false),
      );
    }
    return jobsCache.get(r.id);
  };

  /**
   * Add CI evidence to a parsed session (mutates it): a test run per successful push whose
   * commit had test workflows, and `session.ci.runs` for judging "CI is green" claims.
   *
   * A workflow run is tied to a push only through its commit: the id the push printed, or
   * one the session printed before the push (`git commit`, `git log`), with the run created
   * within 10 minutes. Branch names and timing alone could attach someone else's run.
   */
  const enrich = async (session) => {
    if (session.start == null) return session;
    const events = session.events;
    // commit ids the session printed, with when they first appeared
    const seen = new Map();
    const note = (text, ts) => {
      for (const m of String(text || "").matchAll(/\b[0-9a-f]{7,40}\b/g)) {
        const k = m[0].slice(0, 7);
        if (!seen.has(k)) seen.set(k, ts ?? 0);
      }
    };
    const pushes = [];
    for (const ev of events) {
      if (ev.kind === "result") note(ev.output, ev.ts);
      if (ev.kind !== "result" || ev.partial || !ev.of || !PUSH.test(ev.of.cmd || "")) continue;
      const out = ev.output || "";
      const ok = ev.exitCode === 0 || (ev.exitCode == null && ev.isError !== true);
      if (!ok || /Everything up-to-date/.test(out)) continue;
      const dir = pushDir(ev.of.cmd, ev.of.workdir || session.cwd);
      const repo = repoOf(dir);
      if (!repo) continue;
      const m = /\b([0-9a-f]{7,40})\.{2,3}([0-9a-f]{7,40})\s+(\S+)\s+->\s+(\S+)/.exec(out);
      pushes.push({ ev, repo, dir, sha: m?.[2] || null });
    }
    const repos = new Set(pushes.map((p) => p.repo));
    const own = repoOf(session.cwd);
    if (own) repos.add(own);
    if (!repos.size) return session;
    const from = session.start - 86400000;
    const to = session.end ?? session.start;
    const byRepo = new Map();
    for (const repo of repos) byRepo.set(repo, await runsFor(repo, from, to));
    stats.runs += [...byRepo.values()].reduce((n, r) => n + r.length, 0);

    // runs for commits this session pushed or printed: what "CI is green" can refer to
    const mentioned = (r) => seen.has(r.sha.slice(0, 7));
    session.ci = { repos: [...repos], runs: [...byRepo.values()].flat().filter((r) => mentioned(r) && r.created >= session.start - 3600000) };

    const added = [];
    for (const p of pushes) {
      const runs = byRepo.get(p.repo) || [];
      let forPush = p.sha
        ? runs.filter((r) => r.sha.startsWith(p.sha))
        : runs.filter((r) => r.created >= p.ev.ts - 60000 && r.created <= p.ev.ts + 600000 && (seen.get(r.sha.slice(0, 7)) ?? Infinity) <= p.ev.ts);
      // one commit per push: the first one CI started on after it
      if (forPush.length) {
        const first = forPush.reduce((a, b) => (b.created < a.created ? b : a)).sha;
        forPush = forPush.filter((r) => r.sha === first);
      }
      const tests = [];
      for (const r of forPush) if (await runsTests(p.repo, r)) tests.push(r);
      if (!tests.length) continue;
      if (!tests.every((r) => r.completed)) continue; // still running when we looked: no result to use
      const failed = tests.some((r) => r.conclusion === "failure" || r.conclusion === "timed_out");
      const passed = tests.every((r) => ["success", "skipped", "neutral"].includes(r.conclusion));
      if (!failed && !passed) continue; // cancelled, or GitHub never started it (startup_failure)
      const finished = Math.max(...tests.map((r) => r.completed));
      const label = `CI: ${[...new Set(tests.map((r) => r.name))].join(", ")} (${tests[0].sha.slice(0, 7)})`;
      // the run starts at the push: edits after it aren't in the pushed commit
      const cmd = { kind: "cmd", ts: p.ev.ts, seq: (p.ev.seq ?? 0) + 0.5, cmd: label, external: "ci", workdir: p.dir, sub: false };
      added.push(cmd, { kind: "result", of: cmd, ts: finished, seq: Number.MAX_SAFE_INTEGER, outcome: failed ? "fail" : "pass", output: "", exitCode: failed ? 1 : 0, isError: null });
    }
    if (added.length) {
      events.push(...added);
      events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));
    }
    return session;
  };

  return { enrich, stats };
}

/** Where a push ran: `git -C dir push`, else the last `cd` before it, else the command's folder. */
function pushDir(cmd, base) {
  const at = cmd.search(PUSH);
  const before = cmd.slice(0, at + 200);
  const c = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)[^|;&\n]*\bpush\b/.exec(before);
  if (c) return abs(c[1].replace(/^["']|["']$/g, ""), base);
  const cds = [...cmd.slice(0, at).matchAll(/(?:^|[;&|\n]\s*)(?:cd|pushd)\s+("[^"]*"|'[^']*'|[^\s;&|]+)/g)];
  let dir = base;
  for (const m of cds) dir = abs(m[1].replace(/^["']|["']$/g, ""), dir);
  return dir;
}

function abs(p, base) {
  if (!p || /[$`]/.test(p)) return null;
  if (p === "~" || p.startsWith("~/")) return path.join(os.homedir(), p.slice(1));
  return path.isAbsolute(p) ? p : base ? path.join(base, p) : null;
}

async function ghApi(endpoint, params = {}) {
  const args = ["api", "-X", "GET", endpoint, "-H", "Accept: application/vnd.github+json"];
  for (const [k, v] of Object.entries(params)) args.push("-f", `${k}=${v}`);
  const { stdout } = await run("gh", args, { timeout: 30000, maxBuffer: 32 << 20 });
  return JSON.parse(stdout);
}
