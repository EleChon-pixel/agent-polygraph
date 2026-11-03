// Opt-in executable Stop verification. The command and cwd come from the installed
// hook's arguments, never from transcript text or project-discovered configuration.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { home, snapshot, commandFingerprint, secureDirectory, secureWrite } from "./record.js";
import { readSettings } from "./safe-config.js";
import { isTestCommand, outcomeFromOutput, testOutcome } from "./classify.js";

const digest = (x) => commandFingerprint(JSON.stringify(x));
const projectDir = (cwd) => path.join(home(), "guard", crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex"));
const stop = (why) => ({ continue: false, stopReason: `agent-polygraph: ${why}`, systemMessage: `agent-polygraph: ${why}` });

export function verifyOptions({ testCommand, cwd, timeout = 60, maxAttempts = 2, cacheSeconds = 0, onUnknown = "stop" } = {}) {
  if (typeof testCommand !== "string" || !testCommand.trim() || testCommand.length > 8192)
    throw Error("verify mode requires --test-command with a non-empty command (max 8192 characters)");
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw Error("verify mode requires an absolute --cwd");
  for (const [name, value, min, max] of [["timeout", timeout, 1, 300], ["max-attempts", maxAttempts, 1, 5], ["cache-seconds", cacheSeconds, 0, 3600]])
    if (!Number.isInteger(value) || value < min || value > max) throw Error(`--${name} must be an integer from ${min} to ${max}`);
  if (!["stop", "warn"].includes(onUnknown)) throw Error("--on-unknown must be stop or warn");
  return { testCommand, cwd: fs.realpathSync(cwd), timeout, maxAttempts, cacheSeconds, onUnknown };
}

function fingerprint(cwd) {
  const s = snapshot(cwd, { allFiles: true });
  if (!s.complete) return null;
  return digest({ root: s.root, files: Object.entries(s.files).sort(([a], [b]) => a.localeCompare(b)), env: Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)) });
}

// Bounded in memory. Never persist stdout, stderr, command text or source contents.
async function execute(command, cwd, timeout) {
  return new Promise((resolve) => {
    let output = "", timedOut = false, timer, killTimer;
    const env = { ...process.env, AGENT_POLYGRAPH_VERIFY: "1" };
    // Node's internal worker marker makes a nested --test silently skip files.
    // A new verification process must execute its own suite normally.
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(command, { cwd, shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env });
    const collect = (b) => { output = (output + b.toString("utf8")).slice(-16384); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const kill = (signal) => {
      try {
        if (process.platform === "win32") {
          // taskkill kills descendants too. Never pass command text to a shell here.
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
          killer.on("error", () => { try { child.kill(); } catch {} });
        } else process.kill(-child.pid, signal);
      } catch {}
    };
    timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 500);
    }, timeout * 1000);
    child.on("error", () => { clearTimeout(timer); clearTimeout(killTimer); resolve({ outcome: "unknown", why: "test command could not start" }); });
    child.on("close", (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (timedOut) return resolve({ outcome: "unknown", why: "test command timed out" });
      if (signal || code == null) return resolve({ outcome: "unknown", why: "test command was interrupted" });
      const printed = outcomeFromOutput(output);
      let outcome = code !== 0 || printed === "fail" ? "fail" : "pass";
      if (code === 0 && !printed && isTestCommand(command) && testOutcome({ cmd: command, exitCode: code, output }) !== "pass") outcome = "unknown";
      if (/agent-polygraph: recursive verification was refused/.test(output) ||
          (!printed && /node:test.*recursively.*skipping running files/i.test(output))) outcome = "unknown";
      if (/\bno tests? (?:files? )?(?:ran|found|collected)\b|\b0 tests?\b.*\bpassed\b|(?:^|\n)\s*(?:[ℹ#]\s*)?tests?\s+0(?:\s|$)|\bRan 0 tests?\b/i.test(output)) outcome = "unknown";
      resolve({ outcome, exitCode: code, why: outcome === "unknown" ? "test result was inconclusive" : outcome === "fail" ? "configured test command failed" : null });
    });
  });
}

function readState(file) {
  const { text } = readSettings(file);
  return text === null ? {} : JSON.parse(text);
}

/** Actual command execution closes gaps in transcript coverage and agent compliance. */
export async function verifyStop(payload, session, options) {
  const opts = verifyOptions(options);
  if (process.env.AGENT_POLYGRAPH_VERIFY) return stop("recursive verification was refused; verification remains unresolved.");
  // A project hook must never execute its command in another checkout, even if
  // the agent supplies a different cwd in its Stop payload.
  if (payload.cwd && fs.realpathSync(payload.cwd) !== opts.cwd)
    return stop("hook cwd differs from the installed verification project; verification remains unresolved.");
  const dir = projectDir(opts.cwd);
  secureDirectory(dir);
  const commandKey = digest(opts.testCommand);
  const sessionKey = digest(payload.transcript_path || payload.session_id || "no-transcript");
  const file = path.join(dir, sessionKey + "-" + commandKey + ".json");
  const lock = path.join(dir, "running.lock");
  let fd;
  try {
    fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  } catch (e) {
    if (e.code === "EEXIST") return stop("another verification is running, or a stale guard lock remains; no passing result was established. Inspect guard --status before removing a stale lock.");
    throw e;
  }
  try {
    const state = readState(file);
    // Codex Stop continuations may appear as user prompts. They are not a new
    // human turn and must not reset the repair budget.
    const human = session?.events.findLast((e) => e.kind === "user" && !/^\s*agent-polygraph:/.test(e.text || ""));
    const turn = digest(human ? [human.ts, human.text] : payload.session_id || payload.transcript_path || "unknown-turn");
    const attempts = state.turn === turn && state.outcome !== "pass" ? Number(state.attempts) || 0 : 0;
    let before = null;
    try { before = fingerprint(opts.cwd); } catch {}
    const now = Date.now();
    if (opts.cacheSeconds > 0 && before && state.outcome === "pass" && state.fingerprint === before &&
        now >= state.finished && now - state.finished < opts.cacheSeconds * 1000) return null;
    if (attempts >= opts.maxAttempts && state.outcome === "unknown" && opts.onUnknown === "warn")
      return { systemMessage: "agent-polygraph: verification is UNKNOWN; the attempt budget is exhausted. --on-unknown warn permits stopping without passing verification. Inspect guard --status." };
    if (attempts >= opts.maxAttempts) return stop(`verification remains ${state.outcome || "unresolved"}; the ${opts.maxAttempts}-attempt repair budget is exhausted. Inspect guard --status and resolve the failure manually before a new user turn.`);
    // Write the attempt before launching: crashes/timeouts must not reset budgets.
    const receipt = { v: 1, turn, attempts: attempts + 1, outcome: "running", started: now, timeout: opts.timeout, maxAttempts: opts.maxAttempts, executions: (Number(state.executions) || 0) + 1 };
    secureWrite(file, JSON.stringify(receipt) + "\n");
    const commandStarted = Date.now();
    const ran = await execute(opts.testCommand, opts.cwd, opts.timeout);
    ran.commandMs = Date.now() - commandStarted;
    let after = null;
    try { after = fingerprint(opts.cwd); } catch {}
    if (ran.outcome === "pass" && (!before || !after || before !== after)) {
      ran.outcome = "unknown";
      ran.why = !before || !after ? "working-tree fingerprint is incomplete; a stable tested revision could not be established" : "working-tree files changed while tests ran";
    }
    Object.assign(receipt, ran, { finished: Date.now(), fingerprint: ran.outcome === "pass" ? after : null });
    secureWrite(file, JSON.stringify(receipt) + "\n");
    if (ran.outcome === "pass") return null;
    if (ran.outcome === "unknown" && opts.onUnknown === "warn")
      return { systemMessage: `agent-polygraph: verification is UNKNOWN (${ran.why}); --on-unknown warn permits stopping. No passing verification was established; inspect guard --status.` };
    const explanation = `${ran.why}. Verification is ${ran.outcome}; attempt ${receipt.attempts}/${opts.maxAttempts}.`;
    if (receipt.attempts >= opts.maxAttempts) return stop(`${explanation} Repair budget exhausted; manual intervention is required. No passing verification was established.`);
    return { decision: "block", reason: `agent-polygraph: ${explanation} Fix the cause and report the actual result. The configured command will run again before you stop; changing the wording of your answer does not satisfy verification.` };
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

export function guardStatus(cwd = process.cwd()) {
  const dir = projectDir(fs.realpathSync(cwd));
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { if (e.code === "ENOENT") return { records: [], lockPresent: false }; throw e; }
  const records = files.filter((f) => f.endsWith(".json")).map((f) => ({ id: f.replace(/\.json$/, ""), ...readState(path.join(dir, f)) }));
  return { records: records.sort((a, b) => (b.started || 0) - (a.started || 0)), lockPresent: files.includes("running.lock") };
}
