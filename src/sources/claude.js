// Claude Code transcripts: ~/.claude/projects/<project>/<session>.jsonl
// Subagent transcripts live in <session>/subagents/*.jsonl and are merged into the parent.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readJsonl } from "../jsonl.js";

export const name = "claude";

export function defaultRoot() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
}

/** List sessions as { id, files: [main, ...subagents], mtime }. */
export function discover(root = defaultRoot()) {
  const out = [];
  let projects = [];
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const proj of projects) {
    const dir = path.join(root, proj.name);
    for (const f of safeReaddir(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const id = f.slice(0, -6);
      const main = path.join(dir, f);
      const subDir = path.join(dir, id, "subagents");
      const subs = safeReaddir(subDir)
        .filter((s) => s.endsWith(".jsonl"))
        .map((s) => path.join(subDir, s));
      out.push({ agent: name, id, files: [main, ...subs], mtime: mtime(main) });
    }
  }
  return out;
}

// Cheap prefilter before JSON.parse. Whitespace-tolerant: anonymizers and exporters often
// re-serialize transcripts as `"type": "user"`.
// Hook runs are recorded as attachments carrying the command, its output and exit code.
const WANTED = /"type"\s*:\s*"(?:user|assistant|hook_success|hook_non_blocking_error|hook_blocking_error)"/;

// Event model (shared with codex.js): a command's start (`cmd`) and what was learned about
// it (`result`) are separate events, placed where they were observed. Edits are only
// emitted once their tool result confirms them. Analysis relies on event order.
export async function parse(entry) {
  const session = { agent: name, id: entry.id, file: entry.files[0], cwd: null, models: new Set(), versions: new Set(), events: [], start: null, end: null };
  const stats = { lines: 0, kept: 0 };
  let userCmd = null; // a command you typed with `!`, waiting for its output
  const pendingCmds = new Map(); // tool_use id -> cmd event awaiting its result
  const pendingEdits = new Map(); // tool_use id -> edit events awaiting confirmation
  const background = new Map(); // tool_use id -> backgrounded cmd event
  const outputFiles = new Map(); // background output file -> cmd event
  const reads = new Map(); // Read tool_use id -> cmd event whose output file it reads
  // seq breaks timestamp ties in the order things were requested or observed
  let seq = 0;
  const push = (ev) => {
    ev.seq ??= seq++;
    session.events.push(ev);
  };
  const result = (of, ts, fields) => push({ kind: "result", of, ts, ...fields });

  for (const [i, file] of entry.files.entries()) {
    const isSub = i > 0;
    for await (const rec of readJsonl(file, (line) => WANTED.test(line), stats)) {
      const ts = Date.parse(rec.timestamp) || null;
      if (rec.version && !isSub) session.versions.add(rec.version);
      if (ts) {
        session.start = Math.min(session.start ?? ts, ts);
        session.end = Math.max(session.end ?? ts, ts);
      }
      if (!session.cwd && rec.cwd && !isSub) session.cwd = rec.cwd;
      if (rec.gitBranch && rec.gitBranch !== "HEAD" && !isSub) session.branch = rec.gitBranch;
      const msg = rec.message || {};
      const content = msg.content;

      // a hook (PostToolUse, Stop, …) that ran a command: tests run by hooks count too
      if (rec.type === "attachment") {
        const a = rec.attachment || {};
        if (a.command) {
          const ev = { kind: "cmd", ts, cmd: String(a.command), sub: isSub, hook: a.hookEvent || true };
          push(ev);
          result(ev, ts, { exitCode: typeof a.exitCode === "number" ? a.exitCode : null, isError: null, output: (String(a.stdout ?? "") + "\n" + String(a.stderr ?? "")).slice(-6000), ms: a.durationMs ?? null });
        }
        continue;
      }

      if (rec.type === "assistant") {
        if (msg.model && !msg.model.startsWith("<")) session.models.add(msg.model);
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block.type === "text" && !isSub) {
            push({ kind: "say", ts, text: block.text });
          } else if (block.type === "tool_use") {
            if (block.name === "Read" && outputFiles.has(block.input?.file_path)) reads.set(block.id, outputFiles.get(block.input.file_path));
            const evs = toolEvents(block, ts, isSub);
            if (evs.length && evs[0].kind === "cmd") {
              evs[0].id = block.id;
              if (rec.gitBranch && rec.gitBranch !== "HEAD") evs[0].branch = rec.gitBranch;
              // `tail -5 …/tasks/x.output` through the shell reads a background run's output too
              const read = [...outputFiles.keys()].find((f) => evs[0].cmd.includes(f));
              if (read) reads.set(block.id, outputFiles.get(read));
              push(evs[0]);
              pendingCmds.set(block.id, evs[0]);
            } else if (evs.length) {
              // an edit takes effect in request order, before any later tool call runs;
              // it is only emitted if its result confirms it
              for (const e of evs) e.seq = seq++;
              pendingEdits.set(block.id, evs);
            }
          }
        }
      } else if (rec.type === "user") {
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              const text = fullText(resultText(block.content));
              const readOf = reads.get(block.tool_use_id);
              if (readOf) {
                // the agent reading a background run's output file: evidence about that run
                reads.delete(block.tool_use_id);
                result(readOf, ts, { exitCode: null, isError: null, output: text.slice(-6000), partial: true });
                if (!pendingCmds.has(block.tool_use_id)) continue; // a Read; a shell read also gets its own result
              }
              const edits = pendingEdits.get(block.tool_use_id);
              if (edits) {
                pendingEdits.delete(block.tool_use_id);
                if (block.is_error === true) continue; // rejected or failed: nothing changed
                for (const e of edits) {
                  // Write overwrites as happily as it creates; only its result says which
                  if (e.write) e.op = /created successfully/i.test(text) ? "add" : /updated|overwr/i.test(text) ? "update" : "unknown";
                  push(e);
                }
                continue;
              }
              const ev = pendingCmds.get(block.tool_use_id);
              if (!ev) continue;
              pendingCmds.delete(block.tool_use_id);
              // refused by a permission prompt, the auto-mode classifier or a hook: it never ran
              if (block.is_error === true && DENIED.test(text)) {
                result(ev, ts, { denied: true, exitCode: null, isError: true, output: "" });
                continue;
              }
              if (/running in background|backgrounded command/i.test(text) && !/^Exit code/.test(text)) {
                // result arrives later through a <task-notification> or a Read of the output file
                background.set(block.tool_use_id, ev);
                const file = /(\/\S+\.output)\b/.exec(text)?.[1];
                if (file) outputFiles.set(file, ev);
                continue;
              }
              const m = /^Exit code (-?\d+)/.exec(text);
              const isError = block.is_error === true;
              result(ev, ts, { exitCode: m ? Number(m[1]) : isError ? null : 0, isError, output: text.slice(-6000), ms: ts && ev.ts ? ts - ev.ts : null });
            } else if (block.type === "text" && !isSub && /^\[Request interrupted by user/.test(block.text || "")) {
              push({ kind: "interrupt", ts });
            }
          }
        }
        if (typeof content === "string" && content.startsWith("<task-notification")) {
          const id = /<tool-use-id>([^<]+)</.exec(content)?.[1];
          const ev = background.get(id);
          if (ev) {
            const code = /exit code (-?\d+)/i.exec(content);
            const status = /<status>(\w+)</.exec(content)?.[1];
            const file = /<output-file>([^<]+)</.exec(content)?.[1];
            if (file) outputFiles.set(file, ev);
            result(ev, ts, {
              exitCode: code ? Number(code[1]) : status === "completed" ? 0 : status === "failed" ? 1 : null,
              isError: null,
              output: "",
              ms: ts && ev.ts ? ts - ev.ts : null,
            });
          }
        }
        // commands you typed yourself with `!`: <bash-input>, then <bash-stdout>/<bash-stderr>
        if (typeof content === "string" && /^\s*<bash-input>/.test(content)) {
          const cmd = unescape(/<bash-input>([\s\S]*?)<\/bash-input>/.exec(content)?.[1] ?? "").trim();
          if (cmd) {
            userCmd = { kind: "cmd", ts, cmd, sub: false, byUser: true };
            push(userCmd);
          }
          continue;
        }
        if (typeof content === "string" && /^\s*<bash-std(?:out|err)>/.test(content) && userCmd) {
          const out = [...content.matchAll(/<bash-std(?:out|err)>([\s\S]*?)<\/bash-std(?:out|err)>/g)].map((m) => unescape(m[1])).join("\n");
          result(userCmd, ts, { exitCode: null, isError: null, output: out.slice(-6000), ms: ts && userCmd.ts ? ts - userCmd.ts : null });
          userCmd = null;
          continue;
        }
        if (!isSub && isHumanPrompt(rec)) {
          push({ kind: "user", ts, text: typeof content === "string" ? content : textOf(content) });
        }
      }
    }
  }
  // Edits whose outcome never arrived may or may not have happened.
  for (const evs of pendingEdits.values()) push({ kind: "uncertain", ts: evs[0].ts, seq: evs[0].seq, reason: "edit with no result" });
  session.versions = [...session.versions];
  // lines in the file but none we recognize: probably a log format we don't know yet
  session.unrecognized = stats.lines > 5 && stats.kept === 0;
  // stable: events with equal timestamps keep the order they were observed in
  session.events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || a.seq - b.seq);
  session.models = [...session.models];
  return session;
}

// Answers the agent gets instead of a command's output when it wasn't allowed to run
const DENIED = /^(?:Permission for this action was denied|Permission to use \S+ (?:with command .* )?has been denied|The user doesn't want to proceed with this tool use|\S+ operation blocked by hook|.{0,40}hook (?:blocked|denied)|User rejected)/is;

/**
 * Output too large for the transcript is saved to a file, and the transcript keeps only
 * a preview (`<persisted-output>… Full output saved to: /path …`). The runner's summary is
 * at the end, so read the end of the saved file when it still exists.
 */
function fullText(text) {
  if (!text.includes("<persisted-output>")) return text;
  const file = /Full output saved to: (\S+?\.txt)\b/.exec(text)?.[1];
  if (!file) return text;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const n = Math.min(size, 16384);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, size - n);
      return text + "\n" + buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return text;
  }
}

function isHumanPrompt(rec) {
  if (rec.isMeta || rec.isSidechain) return false;
  const kind = rec.origin?.kind;
  if (kind) return kind === "human";
  const c = rec.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) && c.every((b) => b.type === "text") ? textOf(c) : null;
  if (!text) return false;
  return !/^\s*(?:<[a-z_-]+[\s>]|\[(?:Request interrupted|Image)|Caveat:)/.test(text);
}

function toolEvents(block, ts, isSub) {
  const input = block.input || {};
  switch (block.name) {
    case "Bash":
    case "bash":
    case "PowerShell": // Claude Code on Windows; same result format as Bash
    case "powershell":
      return input.command ? [{ kind: "cmd", ts, cmd: String(input.command), sub: isSub }] : [];
    case "Edit":
      return [edit(input.file_path, input.old_string, input.new_string, ts)];
    case "MultiEdit":
      return (input.edits || []).map((e) => edit(input.file_path, e.old_string, e.new_string, ts));
    case "Write":
      return [{ kind: "edit", ts, path: input.file_path || "", removed: null, added: lines(input.content), write: true }];
    case "NotebookEdit":
      return [{ kind: "edit", ts, path: input.notebook_path || "", removed: [], added: lines(input.new_source) }];
    default:
      return [];
  }
}

function edit(p, oldS, newS, ts) {
  return { kind: "edit", ts, path: p || "", removed: lines(oldS), added: lines(newS) };
}

const lines = (s) => (typeof s === "string" && s.length ? s.split("\n") : []);

function resultText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === "string" ? b : b.text || "")).join("\n");
  return "";
}

const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

function textOf(content) {
  return Array.isArray(content) ? content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";
}

function safeReaddir(d) {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
}

function mtime(f) {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}
