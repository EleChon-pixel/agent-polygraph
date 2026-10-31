// `agent-polygraph record`: optional evidence the session logs don't carry.
//
// - A PostToolUse hook (Claude Code and Codex). After a test command or a command that may
//   write files, it saves a snapshot of the working tree (a git tree id, stored in
//   agent-polygraph's own object store so your repository is never written to) and, for
//   test commands, the outcome the runner printed in full. With snapshots, a change the
//   logs can't follow ("a script that computes its file names") is settled by comparing the
//   tree after the test run with the tree before the claim.
// - Shell integration (bash, zsh): test commands you run in your own terminals are logged
//   with their folder, start and end time and exit code. No output is kept.
//
// Everything stays in ~/.agent-polygraph (or $AGENT_POLYGRAPH_HOME). Nothing is uploaded.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { isTestCommand, mayWriteFiles, shellWrites, outcomeFromOutput, passedCount } from "./classify.js";

export const home = () => process.env.AGENT_POLYGRAPH_HOME || path.join(os.homedir(), ".agent-polygraph");
const hash = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16);
export const recordsFile = (transcript) => path.join(home(), "records", hash(path.resolve(transcript)) + ".jsonl");
export const terminalFile = () => path.join(home(), "records", "terminal.jsonl");

// --- the hook --------------------------------------------------------------------------

/** PostToolUse entry point. Never throws, never prints: a recorder must not get in the way. */
export function runRecordHook(stdinText) {
  try {
    const p = JSON.parse(stdinText || "{}");
    const cmd = commandOf(p.tool_input);
    if (!cmd || !p.transcript_path) return;
    const test = isTestCommand(cmd);
    if (!test && !mayWriteFiles(cmd) && !shellWrites(cmd).unresolved) return;
    const cwd = p.cwd || process.cwd();
    const rec = { v: 1, ts: Date.now(), id: p.tool_use_id || null, tool: p.tool_name || null, cmd, cwd };
    try {
      rec.tree = snapshot(cwd);
    } catch {}
    if (test) {
      const out = outputOf(p.tool_response);
      const outcome = outcomeFromOutput(out);
      if (outcome) rec.outcome = outcome;
      const passed = passedCount(out);
      if (passed != null) rec.passed = passed;
    }
    if (!rec.tree && !rec.outcome) return;
    const file = recordsFile(p.transcript_path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + "\n");
  } catch {}
}

function commandOf(input) {
  if (!input) return null;
  if (typeof input === "string") return input;
  const c = input.command ?? input.cmd;
  if (typeof c === "string") return c;
  // ["bash", "-lc", "npm test"]
  if (Array.isArray(c)) return c.length >= 3 && /^-\w*c$/.test(c[c.length - 2]) ? String(c[c.length - 1]) : c.join(" ");
  return null;
}

function outputOf(r) {
  if (r == null) return "";
  if (typeof r === "string") return r;
  const parts = [r.stdout, r.stderr, r.output, r.aggregated_output, r.formatted_output, typeof r.content === "string" ? r.content : null];
  return parts.filter((x) => typeof x === "string").join("\n");
}

// --- working-tree snapshots ---------------------------------------------------------------

/**
 * The working tree as a git tree id, untracked files included, ignored files left out.
 * Built with a temporary index and a private object store (the repository's own objects
 * are read through git's alternates), so nothing in the repository changes.
 */
export function snapshot(cwd) {
  const git = (args, env = {}, dir = cwd) =>
    execFileSync("git", args, { cwd: dir, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000, maxBuffer: 8 << 20 }).trim();
  const root = git(["rev-parse", "--show-toplevel"]);
  const [index, objects] = git(["rev-parse", "--git-path", "index", "--git-path", "objects"])
    .split("\n")
    .map((p) => path.resolve(cwd, p));
  const store = path.join(home(), "objects", hash(objects));
  fs.mkdirSync(store, { recursive: true });
  const tmp = path.join(os.tmpdir(), `agent-polygraph-${process.pid}-${Date.now()}.index`);
  try {
    // starting from the real index keeps git's stat cache: only changed files are hashed
    if (fs.existsSync(index)) fs.copyFileSync(index, tmp);
    const env = { GIT_INDEX_FILE: tmp, GIT_OBJECT_DIRECTORY: store, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
    git(["add", "-A", "--ignore-errors", "--", "."], env, root);
    const tree = git(["write-tree"], env, root);
    return { root, tree, objects, store };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Paths (relative to the checkout) that differ between two snapshots of it. */
export function treeDiff(a, b) {
  const gitDir = path.dirname(a.objects);
  const out = execFileSync("git", ["diff", "--name-only", "-z", "--no-renames", a.tree, b.tree], {
    env: { ...process.env, GIT_DIR: gitDir, GIT_OBJECT_DIRECTORY: a.store, GIT_ALTERNATE_OBJECT_DIRECTORIES: [a.objects, b.store].join(path.delimiter) },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10000,
    maxBuffer: 16 << 20,
  });
  return out.split("\0").filter(Boolean);
}

// --- using the records -----------------------------------------------------------------------

const squash = (c) => String(c).replace(/\s+/g, " ").trim();

/**
 * Attach recorded snapshots and outcomes to the session's commands, and add test runs from
 * your terminals that happened during the session in its checkout. Mutates `session`.
 */
export function applyRecords(session, { terminal = loadTerminal() } = {}) {
  let recs = [];
  try {
    recs = readLines(recordsFile(session.file));
  } catch {}
  if (recs.length) {
    session.treeDiff = treeDiff;
    // a record belongs to the command with the same text, recorded after it started
    const free = recs.map((r) => ({ ...r, key: squash(r.cmd) }));
    for (const ev of session.events) {
      if (ev.kind !== "cmd" || ev.external) continue;
      const key = squash(ev.cmd);
      const k = free.findIndex((r) => r && (ev.id && r.id ? r.id === ev.id : r.key === key && r.ts >= (ev.ts ?? 0) - 2000));
      if (k < 0) continue;
      const r = free[k];
      free[k] = null;
      if (r.tree) ev.tree = r.tree;
      if (r.outcome) ev.recorded = { outcome: r.outcome, passed: r.passed ?? null };
    }
  }
  addTerminalRuns(session, terminal);
  return session;
}

let terminalCache = null;
export function loadTerminal() {
  if (terminalCache) return terminalCache;
  try {
    terminalCache = readLines(terminalFile());
  } catch {
    terminalCache = [];
  }
  return terminalCache;
}

function addTerminalRuns(session, runs) {
  if (!runs.length || !session.cwd || session.start == null || session.end == null) return;
  const cwd = slash(session.cwd);
  const related = (d) => {
    d = slash(d);
    return d === cwd || d.startsWith(cwd + "/") || cwd.startsWith(d + "/");
  };
  let added = 0;
  for (const r of runs) {
    const start = Math.round(r.start * 1000);
    const end = Math.round((r.end ?? r.start) * 1000);
    if (!(start >= session.start && start <= session.end) || !r.cwd || !related(r.cwd) || !isTestCommand(r.cmd)) continue;
    const ev = { kind: "cmd", ts: start, seq: Number.MAX_SAFE_INTEGER, cmd: r.cmd, workdir: r.cwd, external: "terminal", sub: false };
    session.events.push(ev, { kind: "result", of: ev, ts: end, seq: Number.MAX_SAFE_INTEGER, exitCode: typeof r.exit === "number" ? r.exit : null, isError: null, output: "" });
    added++;
  }
  if (added) session.events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));
}

const slash = (p) => String(p).replace(/\\/g, "/").replace(/\/$/, "");

function readLines(file) {
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

// --- shell integration -----------------------------------------------------------------------

const MARK = "# agent-polygraph record";
export const shellScript = () => path.join(home(), "shell.sh");

const SHELL_SNIPPET = () => fs.readFileSync(new URL("./shell/record.sh", import.meta.url), "utf8");

const RC_FILES = () => [".bashrc", ".zshrc"].map((f) => path.join(os.homedir(), f));

export function installShell() {
  const script = shellScript();
  fs.mkdirSync(path.join(home(), "records"), { recursive: true });
  fs.writeFileSync(script, SHELL_SNIPPET());
  const line = `[ -f "${script}" ] && . "${script}"  ${MARK}`;
  const out = [];
  for (const rc of RC_FILES()) {
    const shell = rc.endsWith("zshrc") ? "zsh" : "bash";
    if (!fs.existsSync(rc) && !onPath(shell)) continue;
    const text = fs.existsSync(rc) ? fs.readFileSync(rc, "utf8") : "";
    if (text.includes(MARK)) {
      out.push({ file: rc, changed: false });
      continue;
    }
    fs.appendFileSync(rc, (text && !text.endsWith("\n") ? "\n" : "") + line + "\n");
    out.push({ file: rc, changed: true });
  }
  return { script, rcs: out };
}

export function uninstallShell() {
  const out = [];
  for (const rc of RC_FILES()) {
    if (!fs.existsSync(rc)) continue;
    const text = fs.readFileSync(rc, "utf8");
    if (!text.includes(MARK)) continue;
    fs.writeFileSync(rc, text.split("\n").filter((l) => !l.includes(MARK)).join("\n"));
    out.push({ file: rc, changed: true });
  }
  fs.rmSync(shellScript(), { force: true });
  return { rcs: out };
}

function onPath(cmd) {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
