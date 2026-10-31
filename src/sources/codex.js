// Codex CLI rollouts: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// Handles both the classic tool format (shell / apply_patch calls) and "code mode",
// where the model writes a JS cell that calls tools.exec_command / tools.apply_patch.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readJsonl } from "../jsonl.js";
import { isTestCommand, ECHOES } from "../classify.js";

export const name = "codex";

export function defaultRoot() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
}

export function discover(root = defaultRoot()) {
  const files = [];
  walk(root, files);
  const byId = new Map();
  const children = [];
  for (const file of files) {
    const meta = firstMeta(file);
    const entry = { agent: name, id: meta?.id || path.basename(file, ".jsonl"), files: [file], mtime: mtime(file) };
    if (meta?.parent_thread_id) children.push([meta.parent_thread_id, file]);
    else byId.set(entry.id, entry);
  }
  for (const [parent, file] of children) {
    const p = byId.get(parent);
    if (p) p.files.push(file);
    else byId.set(file, { agent: name, id: path.basename(file, ".jsonl"), files: [file], mtime: mtime(file) });
  }
  return [...byId.values()];
}

// large records we never use; whitespace-tolerant like the Claude prefilter
const SKIP = /"type"\s*:\s*"(?:token_count|reasoning|world_state|compacted|token_usage_record|Reasoning|AgentMessage|UserMessage|McpToolCall|Extension|ImageView|SubAgentActivity|WebSearch)"/;

// Same event model as claude.js: `cmd` (start) and `result` are separate events placed
// where they were observed, edits are emitted once the tool reports success, and the
// actions inside one code-mode cell keep their source order.
export async function parse(entry) {
  const session = { agent: name, id: entry.id, file: entry.files[0], cwd: null, models: new Set(), versions: new Set(), events: [], start: null, end: null };
  const push = (ev) => session.events.push(ev);
  const stats = { lines: 0, kept: 0 };
  let sawMeta = false;

  for (const [i, file] of entry.files.entries()) {
    const isSub = i > 0;
    const calls = new Map(); // call_id -> pending call
    const running = new Map(); // exec session id -> cmd event still running
    const cells = new Map(); // code-mode cell id -> call whose script is still running
    // Codex also records every finished command as a CommandExecution item with its own exit
    // code and full output. That is ground truth: it beats anything reconstructed from a
    // cell's printed text. Items and command starts are matched by command text.
    const execs = []; // finished items not yet matched to a started command
    const open = []; // started commands still waiting for their item
    const resolve = (ev, item) => {
      ev.resolved = true;
      if (!ev.workdir && item.cwd) ev.workdir = item.cwd;
      push({ kind: "result", of: ev, ts: Math.max(item.ts ?? 0, ev.ts ?? 0), exitCode: item.exitCode, isError: null, output: item.output, ms: item.ms });
    };
    const started = (ev) => {
      const k = execs.findIndex((it) => it.key === cmdKey(ev.cmd) && (it.ts ?? 0) >= (ev.calledAt ?? ev.ts ?? 0) - 1000);
      if (k >= 0) resolve(ev, execs.splice(k, 1)[0]);
      else open.push(ev);
    };

    for await (const rec of readJsonl(file, (line) => !SKIP.test(line), stats)) {
      const ts = Date.parse(rec.timestamp) || null;
      if (ts) {
        session.start = Math.min(session.start ?? ts, ts);
        session.end = Math.max(session.end ?? ts, ts);
      }
      const p = rec.payload || {};
      if (rec.type === "session_meta") {
        sawMeta = true;
        if (!isSub && p.cli_version) session.versions.add(p.cli_version);
        if (!isSub && p.cwd) session.cwd = p.cwd;
        if (!isSub && p.git?.branch) session.branch = p.git.branch;
        continue;
      }
      if (rec.type === "turn_context") {
        if (p.model) session.models.add(p.model);
        if (!session.cwd && p.cwd) session.cwd = p.cwd;
        continue;
      }
      if (rec.type === "event_msg") {
        if (p.type === "turn_aborted" && p.reason === "interrupted" && !isSub) push({ kind: "interrupt", ts });
        if (p.type === "item_completed" && p.item?.type === "CommandExecution") {
          const item = execItem(p.item, Number(p.completed_at_ms) || ts);
          if (item) {
            const k = open.findIndex((ev) => !ev.resolved && cmdKey(ev.cmd) === item.key);
            if (k >= 0) resolve(open.splice(k, 1)[0], item);
            else execs.push(item);
          }
        }
        continue;
      }
      if (rec.type !== "response_item") continue;

      switch (p.type) {
        case "message": {
          if (isSub) break;
          const text = (p.content || []).map((c) => c.text || "").join("\n");
          if (p.role === "user" && isHumanPrompt(text)) push({ kind: "user", ts, text });
          else if (p.role === "assistant" && text) push({ kind: "say", ts, text });
          break;
        }
        case "custom_tool_call":
        case "function_call": {
          const input = typeof (p.input ?? p.arguments) === "string" ? p.input ?? p.arguments : JSON.stringify(p.input ?? p.arguments ?? "");
          const call = { ts, actions: [], stdinSessions: [], emitted: false, sub: isSub };
          if (p.name === "exec" || p.name === "js") {
            call.actions = cellActions(input, ts, isSub);
            for (const a of call.actions) if (a.ev) a.ev.callId = p.call_id;
            // Promise.all keeps input order; output printed per-promise (.then) or from
            // race/any arrives in completion order and can't be matched to commands
            call.parallel = /Promise\.(?:race|any)\b/.test(input) || (/Promise\.(?:all|allSettled)\b/.test(input) && /\.then\s*\(/.test(input));
            call.stdinSessions = [...input.matchAll(/write_stdin\(\s*\{[^}]*?session_id"?\s*:\s*(\d+)/g)].map((m) => m[1]);
          } else if (p.name === "apply_patch") {
            call.actions = [{ type: "patch", edits: patchEdits(input, ts) }];
          } else if (["shell", "exec_command", "local_shell", "container.exec", "unified_exec"].includes(p.name)) {
            const cmd = classicCommand(input);
            if (cmd && /^\s*apply_patch\b/.test(cmd)) call.actions = [{ type: "patch", edits: patchEdits(cmd, ts) }];
            else if (cmd) {
              let workdir;
              try {
                workdir = JSON.parse(input).workdir;
              } catch {}
              call.actions = [{ type: "cmd", ev: cmdEvent(cmd, ts, isSub, typeof workdir === "string" ? workdir : undefined) }];
              emitStarts(call, push, started); // a plain shell call starts right away
            }
          } else if (p.name === "wait") {
            const m = /cell_id"?\s*:\s*"?(\w+)/.exec(input);
            if (m && cells.has(m[1])) call.cell = m[1];
          } else if (p.name === "write_stdin") {
            const m = /session_id"?\s*:\s*(\d+)/.exec(input);
            if (m) call.stdinSessions = [m[1]];
          }
          if (call.actions.length || call.stdinSessions.length || call.cell) calls.set(p.call_id, call);
          break;
        }
        case "custom_tool_call_output":
        case "function_call_output": {
          const call = calls.get(p.call_id);
          if (!call) break;
          calls.delete(p.call_id);
          const text = outputText(p.output);
          // `wait` on a still-running cell delivers that cell's results
          const target = call.cell ? cells.get(call.cell) : call;
          if (!target) break;
          target.text = (target.text ? target.text + "\n" : "") + text;
          const still = /Script running with cell ID (\w+)/.exec(text);
          if (still) cells.set(still[1], target);
          else if (call.cell) cells.delete(call.cell);
          settle(target, ts, push, running, Boolean(still), started);
          pollResults(call, text, ts, push, running);
          break;
        }
      }
    }
  }
  session.events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  session.models = [...session.models];
  session.versions = [...session.versions];
  // content but no session header we recognize: probably a log format we don't know yet
  session.unrecognized = stats.lines > 5 && !sawMeta;
  return session;
}

function cmdEvent(cmd, ts, sub, workdir) {
  return { kind: "cmd", ts, cmd, sub, workdir };
}

/** exec_command and apply_patch calls in a JS cell, in source order. */
function cellActions(js, ts, sub) {
  const actions = [];
  for (const { pos, cmd, workdir } of execCommands(js, true)) actions.push({ pos, type: "cmd", ev: cmdEvent(cmd, ts, sub, workdir) });
  const patchAt = js.search(/apply_patch\s*\(/);
  const edits = patchEdits(js, ts);
  if (edits.length) actions.push({ pos: patchAt >= 0 ? patchAt : js.length, type: "patch", edits });
  return actions.sort((a, b) => a.pos - b.pos);
}

function emitStarts(call, push, started) {
  if (call.emitted) return;
  call.emitted = true;
  for (const a of call.actions) {
    if (a.type !== "cmd") continue;
    push(a.ev);
    started?.(a.ev);
  }
}

const cmdKey = (cmd) => String(cmd).replace(/\s+/g, " ").trim();

/** A finished CommandExecution item, normalized. */
function execItem(it, ts) {
  const c = it.command;
  const cmd = Array.isArray(c) ? (c.length >= 3 && /^-l?c$/.test(c[1]) ? c[c.length - 1] : c.join(" ")) : c;
  if (!cmd || it.exit_code == null) return null;
  const output = String(it.aggregated_output || [it.stdout, it.stderr].filter(Boolean).join("\n") || it.formatted_output || "").slice(-6000);
  const d = it.duration;
  const ms = d && typeof d === "object" ? Math.round((d.secs ?? 0) * 1000 + (d.nanos ?? 0) / 1e6) : null;
  const cwd = typeof it.cwd === "string" ? decodeURIComponent(it.cwd.replace(/^file:\/\//, "")) : undefined;
  return { key: cmdKey(cmd), exitCode: Number(it.exit_code), output, ts, ms, cwd };
}


const PATCH_FAILED = /apply_patch verification failed|failed to apply|invalid patch|patch rejected|no such file|did not match/i;

/**
 * Turn a call's output into events. In a cell, each command gets only its own output
 * chunk; when chunks can't be matched to commands, the result stays unknown instead of
 * sharing one command's output with another.
 */
function settle(call, ts, push, running, stillRunning, started) {
  const text = call.text || "";
  const cmds = call.actions.filter((a) => a.type === "cmd");
  const chunks = jsonChunks(text);
  const codedChunks = chunks.filter((c) => typeof c.exit_code === "number");
  const wall = /Wall time:?\s*([\d.]+)\s*s/.exec(text);

  // a lone command still running hands back a session id to poll with write_stdin
  const sid = cmds.length === 1 && !codedChunks.length ? chunks.find((c) => c.session_id != null)?.session_id ?? /"session_id"\s*:\s*(\d+)/.exec(text)?.[1] : null;
  const polling = sid != null;
  if (polling && !cmds[0].done) running.set(String(sid), cmds[0]);

  // per-command results, by position, when the mapping is unambiguous
  let perCmd = null;
  if (polling) perCmd = null;
  else if (cmds.length === 1) {
    const codes = codedChunks.length
      ? codedChunks.map((c) => c.exit_code)
      : [...text.matchAll(/"exit_code"\s*:\s*(-?\d+)|Process exited with code (-?\d+)|Exit code:\s*(-?\d+)/g)].map((m) => Number(m[1] ?? m[2] ?? m[3]));
    const code = codes.length && codes.every((c) => c === codes[0]) ? codes[0] : null;
    // prefer the command's own (decoded) output over the raw cell text
    const own = chunks.map((c) => c.output).filter((o) => typeof o === "string").join("\n");
    perCmd = [{ exitCode: code, output: (own || text).slice(-6000) }];
  } else if (cmds.length > 1 && chunks.length === cmds.length && (chunks.every((c, j) => c.i === j) || !call.parallel)) {
    // one chunk per command, by explicit index or in source order. A chunk without an exit
    // code but with a session id is still running: its result comes from a later poll.
    perCmd = chunks.map((c) => {
      const output = String(c.output ?? "").slice(-6000);
      if (typeof c.exit_code === "number") return { exitCode: c.exit_code, output };
      if (c.session_id != null) return { pending: String(c.session_id), output };
      return { exitCode: null, output };
    });
  } else if (cmds.length > 1 && !call.parallel && codedChunks.length === cmds.length) {
    perCmd = codedChunks.map((c) => ({ exitCode: c.exit_code, output: String(c.output ?? "").slice(-6000) }));
  } else if (cmds.length > 1 && indexed(text, cmds.length)) {
    // labelled sections, one per command: `0: …` or `=== RESULT 1 exit=0 ===`
    perCmd = indexed(text, cmds.length).map((r) => ({ exitCode: r.exitCode, output: r.output.slice(-6000) }));
  } else if (cmds.length > 1 && codedChunks.length >= cmds.length && codedChunks.every((c) => c.exit_code === 0)) {
    // can't tell which output is whose, but every command exited 0: share the status only
    perCmd = cmds.map(() => ({ exitCode: 0, output: "" }));
  } else if (cmds.length > 1) {
    // Unlabelled output from several commands. Only a test runner prints a runner summary,
    // so with exactly one test command and no command that could echo saved text (a log,
    // a fixture), any summary in the output is that test's.
    const tests = cmds.filter((a) => isTestCommand(a.ev.cmd));
    const echoes = cmds.some((a) => !isTestCommand(a.ev.cmd) && ECHOES.test(a.ev.cmd));
    if (tests.length === 1 && !echoes) perCmd = cmds.map((a) => ({ exitCode: null, output: a === tests[0] ? text.slice(-6000) : "" }));
  }

  if (!call.emitted) {
    // emit the cell's actions in source order, each command followed by its result
    call.emitted = true;
    let k = 0;
    for (const a of call.actions) {
      if (a.type === "patch") {
        if (!PATCH_FAILED.test(text)) for (const e of a.edits) push({ ...e, ts: ts ?? e.ts });
        continue;
      }
      // one timestamp for the whole cell, so sorting can't reorder its actions
      a.ev.calledAt = a.ev.ts;
      a.ev.ts = ts ?? a.ev.ts;
      push(a.ev);
      started?.(a.ev); // its CommandExecution item, if it already arrived
      a.k = k++;
      if (!stillRunning && perCmd) emitResult(a, perCmd[a.k], ts, wall, cmds.length, push, running);
    }
  } else if (!stillRunning) {
    for (const a of cmds) if (!a.done && perCmd) emitResult(a, perCmd[a.k ?? 0], ts, wall, cmds.length, push, running);
  }

  // a cell that finished without a usable mapping: its commands' results are unknown
  if (!stillRunning && !polling) for (const a of cmds) if (!a.done && !a.pending && !a.ev.resolved) emitResult(a, { exitCode: null, output: "" }, ts, wall, cmds.length, push);
}

function emitResult(action, r, ts, wall, n, push, running) {
  if (!r || action.done || action.ev.resolved) return;
  if (r.pending) {
    // still running: the result arrives when the agent polls this session
    running?.set(r.pending, action);
    action.pending = true;
    return;
  }
  action.done = true;
  const began = action.ev.calledAt ?? action.ev.ts;
  const ms = n === 1 && wall ? Math.round(Number(wall[1]) * 1000) : ts && began ? ts - began : null;
  push({ kind: "result", of: action.ev, ts, exitCode: r.exitCode, isError: null, output: r.output, ms });
}

/** write_stdin polls deliver the result of a command started earlier. */
function pollResults(call, text, ts, push, running) {
  for (const sid of call.stdinSessions) {
    const action = running.get(sid);
    if (!action || action.ev.resolved) continue;
    const coded = jsonChunks(text).filter((c) => typeof c.exit_code === "number");
    const code = coded.length ? coded[coded.length - 1].exit_code : /"exit_code"\s*:\s*(-?\d+)/.exec(text)?.[1];
    if (code == null) continue;
    running.delete(sid);
    action.done = true;
    push({ kind: "result", of: action.ev, ts, exitCode: Number(code), isError: null, output: text.slice(-6000), ms: ts && action.ev.ts ? ts - (action.ev.calledAt ?? action.ev.ts) : null });
  }
}

/** Split `0: …\n1: …` output into one section per index, if there are exactly n of them. */
function indexed(text, n) {
  const body = text.replace(/^[\s\S]*?\nOutput:\n/, "\n");
  const sections = (marks, base, codeOf) => {
    if (marks.length !== n || marks.some((m, i) => Number(m[1]) !== i + base)) return null;
    return marks.map((m, i) => ({ output: body.slice(m.index + m[0].length, i + 1 < n ? marks[i + 1].index : undefined), exitCode: codeOf(m) }));
  };
  // `=== RESULT 1 exit=0 ===`, numbered from 0 or 1, with the command's exit code
  const results = [...body.matchAll(/(?:^|\n)=+\s*RESULT\s+(\d+)(?:\s+exit=(-?\d+))?\s*=+[^\n]*/gi)];
  const code = (m) => (m[2] !== undefined ? Number(m[2]) : null);
  const labelled = sections(results, 0, code) || sections(results, 1, code);
  if (labelled) return labelled;
  return sections([...body.matchAll(/(?:^|\n)(\d+): ?/g)], 0, () => null);
}
/** JSON objects printed one per line by code-mode cells ({"exit_code":0,"output":"…"}). */
function jsonChunks(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{") || !t.endsWith("}")) continue;
    try {
      let o = JSON.parse(t);
      // Promise.allSettled results arrive wrapped: {"i":0,"result":{"status":"fulfilled","value":{…}}}
      const i = Number.isInteger(o?.i) ? o.i : undefined;
      if (o?.result && typeof o.result === "object") o = o.result;
      if (o?.status && o.value && typeof o.value === "object") o = o.value;
      if (o && typeof o === "object" && ("exit_code" in o || "session_id" in o || "output" in o)) out.push(i === undefined ? o : { ...o, i });
    } catch {}
  }
  return out;
}

function isHumanPrompt(text) {
  if (!text.trim()) return false;
  return !/^\s*(?:<[a-z_-]+[\s>]|# AGENTS\.md|\[Image)/i.test(text);
}

function outputText(out) {
  if (typeof out === "string") {
    // classic format wraps {"output": "...", "metadata": {"exit_code": n}}
    return out;
  }
  if (Array.isArray(out)) return out.map((c) => c.text || "").join("\n");
  if (out && typeof out === "object") return JSON.stringify(out);
  return "";
}

function classicCommand(args) {
  let a = args;
  if (typeof a === "string") {
    try {
      a = JSON.parse(a);
    } catch {
      return a;
    }
  }
  const c = a?.command ?? a?.cmd;
  if (Array.isArray(c)) return c.length >= 3 && /^-l?c$/.test(c[1]) ? c[c.length - 1] : c.join(" ");
  return typeof c === "string" ? c : null;
}

/** Pull string-literal `cmd` arguments out of a code-mode JS cell (with positions if asked). */
export function execCommands(js, withPos = false) {
  if (typeof js !== "string") return [];
  const cmds = [];
  const rx = /exec_command\(\s*\{[^]*?\b"?cmd"?\s*:\s*/g;
  let m;
  while ((m = rx.exec(js))) {
    const lit = readStringLiteral(js, rx.lastIndex);
    if (lit == null) continue;
    // the call's own `workdir` argument, if it has one (before the next call starts)
    const rest = js.slice(rx.lastIndex, js.indexOf("exec_command(", rx.lastIndex) >>> 0 || undefined);
    const wd = /\bworkdir"?\s*:\s*/.exec(rest);
    const workdir = wd ? readStringLiteral(rest, wd.index + wd[0].length) : undefined;
    cmds.push(withPos ? { pos: m.index, cmd: lit, workdir } : lit);
  }
  return cmds;
}

function readStringLiteral(src, i) {
  const q = src[i];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  let out = "";
  for (let j = i + 1; j < src.length; j++) {
    const ch = src[j];
    if (ch === "\\") {
      const n = src[++j];
      out += n === "n" ? "\n" : n === "t" ? "\t" : n === "u" ? String.fromCharCode(parseInt(src.slice(j + 1, (j += 4) + 1), 16)) : n;
      continue;
    }
    if (ch === q) return out;
    out += ch;
  }
  return null;
}

/** Turn an apply_patch envelope into edit events with removed/added lines. */
export function patchEdits(text, ts) {
  if (typeof text !== "string" || !text.includes("*** ")) return [];
  // In JSON or JS string literals the patch's newlines are escaped.
  let body = text;
  const start = body.indexOf("*** Begin Patch");
  if (start >= 0) body = body.slice(start);
  if (!body.includes("\n") || /\\n\*\*\* /.test(body)) body = body.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');

  const edits = [];
  let cur = null;
  for (const line of body.split("\n")) {
    const h = /^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/.exec(line);
    if (h) {
      cur = { kind: "edit", ts, path: h[2], removed: [], added: [], op: h[1].toLowerCase() };
      edits.push(cur);
      continue;
    }
    if (!cur || line.startsWith("***") || line.startsWith("@@")) continue;
    if (line.startsWith("-")) cur.removed.push(line.slice(1));
    else if (line.startsWith("+")) cur.added.push(line.slice(1));
  }
  return edits;
}

function firstMeta(file) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const s = buf.subarray(0, n).toString("utf8");
    const id = /"payload"\s*:\s*\{[^]*?"id"\s*:\s*"([^"]+)"/.exec(s)?.[1];
    const parent = /"parent_thread_id"\s*:\s*"([^"]+)"/.exec(s.split("\n")[0])?.[1];
    return { id, parent_thread_id: parent };
  } catch {
    return null;
  }
}

function walk(dir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
}

function mtime(f) {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}
