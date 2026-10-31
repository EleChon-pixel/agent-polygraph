// `agent-polygraph guard`: a Stop hook for Claude Code and Codex.
// When the agent's final message says tests pass but the session shows no passing run
// after its last code edit, the hook sends it back once to rerun the tests or correct itself.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as claude from "./sources/claude.js";
import * as codex from "./sources/codex.js";
import { analyzeSession } from "./analyze.js";
import { findTestClaim } from "./classify.js";
import { applyRecords } from "./record.js";


/** Hook entry point: read the Stop payload on stdin, maybe print a block decision. */
export async function runHook(stdinText) {
  let payload;
  try {
    payload = JSON.parse(stdinText || "{}");
  } catch {
    return null;
  }
  if (payload.stop_hook_active) return null; // we already sent the agent back once
  const transcript = payload.transcript_path;
  if (!transcript || !fs.existsSync(transcript)) return null;

  const isCodex = sniffCodex(transcript);
  const src = isCodex ? codex : claude;
  const files = [transcript];
  if (!isCodex) {
    const subDir = path.join(transcript.replace(/\.jsonl$/, ""), "subagents");
    try {
      for (const f of fs.readdirSync(subDir)) if (f.endsWith(".jsonl")) files.push(path.join(subDir, f));
    } catch {}
  }
  const session = await src.parse({ agent: src.name, id: "live", files });
  if (payload.cwd && !session.cwd) session.cwd = payload.cwd;
  // snapshots and terminal runs from `agent-polygraph record`, if installed
  try {
    session.file = transcript;
    applyRecords(session);
  } catch {}

  // Judge only what the agent is actually ending with. Agents send that text with the Stop
  // payload (it may not be in the transcript yet); an earlier claim it has since corrected
  // ("Correction: I did not run the tests") must not trigger a block.
  const events = session.events;
  const lastUser = events.findLastIndex((e) => e.kind === "user");
  let final;
  const last = payload.last_assistant_message;
  if (typeof last === "string" && last.trim()) {
    // a loop, not Math.max(...events): long sessions exceed the argument limit
    let latest = session.end ?? 0;
    for (const e of events) if ((e.ts ?? 0) > latest) latest = e.ts;
    final = { kind: "say", ts: latest + 1, text: last };
    events.push(final);
  } else {
    const i = events.findLastIndex((e) => e.kind === "say");
    final = i > lastUser ? events[i] : null;
  }
  if (!final || !findTestClaim(final.text)) return null;

  const result = analyzeSession(session);
  const detail = result.findings.find((f) => f.type === "claim" && f.ts === final.ts && final.verdict === f.detail.verdict)?.detail;
  if (!detail) return null; // backed, or nothing we can judge
  return { decision: "block", reason: reasonFor(detail) };
}

function reasonFor(d) {
  const why = {
    "no-run": "no test run appears in this session",
    stale: `you edited ${d.editedAfter} after the last test run`,
    failed: "the most recent test run in this session failed",
  }[d.verdict];
  return [
    `agent-polygraph: your final message says "${d.claim}", but ${why}.`,
    "Run the relevant tests now and report the actual result. If they can't be run, say so instead of claiming they pass.",
  ].join(" ");
}

function sniffCodex(file) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return /"type"\s*:\s*"session_meta"/.test(buf.subarray(0, n).toString("utf8"));
  } catch {
    return false;
  }
}

// --- install / uninstall ------------------------------------------------------------

const IN_NPX_CACHE = /[\\/]_npx[\\/]/;

export function hookCommand(sub = "guard") {
  // npx puts its temporary copy on PATH while it runs, so a bare `agent-polygraph`
  // only counts when it's a real install that will still exist later.
  try {
    const found = execFileSync(process.platform === "win32" ? "where" : "which", ["agent-polygraph"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
    if (found && !IN_NPX_CACHE.test(fs.realpathSync(found))) return `agent-polygraph ${sub}`;
  } catch {}
  const self = fs.realpathSync(process.argv[1]);
  if (!IN_NPX_CACHE.test(self)) return `node ${JSON.stringify(self)} ${sub}`;
  const { version } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return `npx -y agent-polygraph@${version} ${sub}`;
}

/** Hook config files to touch: project-level by default, user-level with `global`. */
export function targets({ agents = ["claude", "codex"], global = false, cwd = process.cwd() } = {}) {
  const out = [];
  if (agents.includes("claude")) {
    out.push({
      agent: "claude",
      file: global
        ? path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json")
        : path.join(cwd, ".claude", "settings.json"),
    });
  }
  if (agents.includes("codex")) {
    out.push({
      agent: "codex",
      file: global
        ? path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "hooks.json")
        : path.join(cwd, ".codex", "hooks.json"),
    });
  }
  return out;
}

/**
 * One definition of "our hook", covering every command form we write: a global install
 * (`agent-polygraph guard`), a version-pinned npx (`npx -y agent-polygraph@0.1.0 guard`)
 * and a local checkout (`node "/path/bin/polygraph.js" guard`).
 */
export function isOurHook(h, sub = "guard") {
  const cmd = String(h?.command || "");
  return new RegExp(String.raw`\bagent-polygraph(?:@\S+)?\s+${sub}\b`).test(cmd) || new RegExp(String.raw`polygraph\.js["']?\s+${sub}\b`).test(cmd);
}

// `guard` is a Stop hook; `record` runs after each shell command (PostToolUse). Codex gets
// no matcher: the recorder itself ignores tools that aren't shell commands.
const HOOKS = {
  guard: { event: "Stop", timeout: 30, matcher: {} },
  record: { event: "PostToolUse", timeout: 20, matcher: { claude: "Bash|PowerShell" } },
};

export function install(opts) {
  const sub = opts.sub || "guard";
  const spec = HOOKS[sub];
  const command = opts.command || hookCommand(sub);
  const isOurs = (h) => isOurHook(h, sub);
  return targets(opts).map(({ agent, file }) => {
    const config = readJson(file);
    config.hooks ||= {};
    const stop = (config.hooks[spec.event] ||= []);
    const ours = stop.flatMap((g) => (g.hooks || []).filter(isOurs));
    let changed = false;
    if (!ours.length) {
      const group = { hooks: [{ type: "command", command, timeout: spec.timeout }] };
      if (spec.matcher[agent]) group.matcher = spec.matcher[agent];
      stop.push(group);
      changed = true;
    } else {
      // upgrade an older form (another version, npx vs global) in place; drop duplicates
      if (ours[0].command !== command) {
        ours[0].command = command;
        changed = true;
      }
      for (const g of stop) {
        const before = (g.hooks || []).length;
        g.hooks = (g.hooks || []).filter((h) => !isOurs(h) || h === ours[0]);
        if (g.hooks.length !== before) changed = true;
      }
      config.hooks[spec.event] = stop.filter((g) => g.hooks.length);
    }
    if (changed) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
    }
    return { agent, file, changed, command };
  });
}

export function uninstall(opts) {
  const sub = opts.sub || "guard";
  const { event } = HOOKS[sub];
  const isOurs = (h) => isOurHook(h, sub);
  return targets(opts).map(({ agent, file }) => {
    if (!fs.existsSync(file)) return { agent, file, changed: false };
    const config = readJson(file);
    const stop = config.hooks?.[event];
    if (!Array.isArray(stop)) return { agent, file, changed: false };
    const removed = stop.reduce((n, g) => n + (g.hooks || []).filter(isOurs).length, 0);
    if (!removed) return { agent, file, changed: false };
    const kept = stop.map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) })).filter((g) => g.hooks.length);
    if (kept.length) config.hooks[event] = kept;
    else delete config.hooks[event];
    if (!Object.keys(config.hooks).length) delete config.hooks;
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
    return { agent, file, changed: true };
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw new Error(`${file} is not valid JSON; fix or remove it first (${e.message})`);
  }
}
