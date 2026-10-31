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
import { isTestCommand, isCodePath, mayWriteFiles, shellWrites, outcomeFromOutput, passedCount } from "./classify.js";

export const home = () => process.env.AGENT_POLYGRAPH_HOME || path.join(os.homedir(), ".agent-polygraph");
const hash = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16);
export const recordsFile = (transcript) => path.join(home(), "records", hash(path.resolve(transcript)) + ".jsonl");
export const terminalFile = () => path.join(home(), "records", "terminal.jsonl");

// Refuse redirected or shared record paths. These files are local evidence,
// not a place to follow arbitrary symlinks or overwrite somebody else's files.
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
function verifyPrivateFile(fd) {
  const st = fs.fstatSync(fd);
  if (!st.isFile() || st.nlink !== 1) throw new Error("Unsafe record file (not regular or multiply linked)");
  if (process.platform !== "win32") {
    if (st.uid !== process.getuid()) throw new Error("Record file belongs to another user");
    fs.fchmodSync(fd, 0o600);
  }
}
function secureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("Unsafe record directory");
  if (process.platform !== "win32") {
    if (st.uid !== process.getuid()) throw new Error("Record directory belongs to another user");
    fs.chmodSync(dir, 0o700);
  }
}
function secureWrite(file, data, append = false) {
  secureDirectory(path.dirname(file));
  // Never truncate before validating an existing file. O_NOFOLLOW rejects final
  // symlinks, and nlink/owner checks reject hard links and unrelated files.
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_APPEND | NOFOLLOW, 0o600);
  try {
    verifyPrivateFile(fd);
    if (!append) fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

// The key stays on the local machine. A keyed digest lets us correlate commands
// without ever persisting their text (which may contain tokens/passwords).
let keyCache;
let keyCachePath;
function localKey() {
  const file = path.join(home(), "record-key");
  if (keyCachePath === file && keyCache) return keyCache;
  secureDirectory(home());
  let key;
  const readKey = () => {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    try {
      verifyPrivateFile(fd);
      return fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    key = readKey();
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    const candidate = crypto.randomBytes(32);
    try {
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
      try { verifyPrivateFile(fd); fs.writeSync(fd, candidate); } finally { fs.closeSync(fd); }
      key = candidate;
    } catch (race) {
      if (race.code !== "EEXIST") throw race;
      key = readKey();
    }
  }
  if (key.length !== 32) throw new Error("Invalid agent-polygraph local record key");
  keyCache = key;
  keyCachePath = file;
  return key;
}
export const commandFingerprint = (cmd) => crypto.createHmac("sha256", localKey()).update(String(cmd)).digest("hex");

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
    const rec = { v: 2, ts: Date.now(), id: p.tool_use_id || null, tool: p.tool_name || null, cmdKey: commandFingerprint(cmd), cwd };
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
    secureWrite(file, JSON.stringify(rec) + "\n", true);
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

// --- working-tree fingerprints -------------------------------------------------------------

// No git objects or copies of source files are written. Snapshots contain
// bounded HMACs, which cannot be used as a substitute for the source contents.
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 10000;

function safeParents(root, relative) {
  let parent = root;
  for (const part of relative.split(/[\\/]/).slice(0, -1)) {
    if (!part || part === "." || part === "..") return false;
    parent = path.join(parent, part);
    const st = fs.lstatSync(parent);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
  }
  return true;
}

function sourceFingerprint(root, name, key) {
  const file = path.join(root, name);
  // Refuse symlinks in the path. Open the leaf with O_NOFOLLOW too: a symlink
  // substitution between lstat and open must not make us read its target.
  if (path.isAbsolute(name) || name.split(/[\\/]/).includes("..") || !safeParents(root, name)) return null;
  const initial = fs.lstatSync(file, { bigint: true });
  if (!initial.isFile() || initial.nlink !== 1n || initial.size > BigInt(MAX_SOURCE_BYTES)) return null;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.dev !== initial.dev || before.ino !== initial.ino ||
        before.nlink !== 1n || before.size > BigInt(MAX_SOURCE_BYTES)) return null;
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs || bytes.length !== Number(before.size)) return null;
    return { bytes: bytes.length, digest: crypto.createHmac("sha256", key).update(bytes).digest("hex") };
  } finally {
    fs.closeSync(fd);
  }
}

export function snapshot(cwd) {
  const git = (args, options = {}) => execFileSync("git", args, {
    cwd, encoding: options.encoding ?? "utf8", stdio: ["ignore", "pipe", "ignore"],
    timeout: 8000, maxBuffer: 16 << 20,
  });
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  const files = Object.create(null);
  const paths = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "buffer" }).toString("utf8").split("\0").filter(Boolean);
  const key = localKey();
  let complete = true;
  let total = 0;
  let count = 0;
  for (const name of paths) {
    if (!isCodePath(name)) continue;
    if (++count > MAX_SNAPSHOT_FILES) { complete = false; break; }
    try {
      const data = sourceFingerprint(root, name, key);
      if (!data || total + data.bytes > MAX_SNAPSHOT_BYTES) { complete = false; break; }
      total += data.bytes;
      files[name] = data.digest;
    } catch {
      complete = false;
    }
  }
  return { root, files, complete };
}

export function treeDiff(a, b) {
  if (!a || !b || a.root !== b.root || !a.complete || !b.complete) return null;
  const names = new Set([...Object.keys(a.files), ...Object.keys(b.files)]);
  return [...names].filter((name) => a.files[name] !== b.files[name]);
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
    const free = recs.map((r) => ({ ...r, key: r.cmdKey || (r.cmd ? squash(r.cmd) : null) }));
    for (const ev of session.events) {
      if (ev.kind !== "cmd" || ev.external) continue;
      const key = commandFingerprint(ev.cmd);
      const legacyKey = squash(ev.cmd);
      const k = free.findIndex((r) => r && (ev.id && r.id ? r.id === ev.id : r.key != null && r.key === (r.cmdKey ? key : legacyKey) && r.ts >= (ev.ts ?? 0) - 2000));
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
    const runner = r.runner || r.cmd; // legacy raw-command records are still readable
    if (!(start >= session.start && start <= session.end) || !r.cwd || !related(r.cwd) || !runner || !isTestCommand(runner)) continue;
    const ev = { kind: "cmd", ts: start, seq: Number.MAX_SAFE_INTEGER, cmd: runner, workdir: r.cwd, external: "terminal", sub: false };
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
  secureWrite(script, SHELL_SNIPPET());
  secureDirectory(path.join(home(), "records"));
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
