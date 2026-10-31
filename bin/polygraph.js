#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { scan } from "../src/scan.js";
import { aggregate } from "../src/analyze.js";
import { renderTerminal } from "../src/report/terminal.js";
import { renderHtml } from "../src/report/html.js";

const { version } = createRequire(import.meta.url)("../package.json");

if (process.argv[2] === "guard") {
  await guard(process.argv.slice(3));
  process.exit(0);
}
if (process.argv[2] === "record") {
  await record(process.argv.slice(3));
  process.exit(0);
}

const HELP = `agent-polygraph ${version}
Check what your coding agents claimed against what actually ran.
Reads Claude Code and Codex session logs on this machine. Nothing is uploaded
(except with --ci, which asks GitHub for your workflow results).

Usage: npx agent-polygraph [options]

  --since <when>      only sessions since a date (2026-10-01) or age (7d, 4w, 3m)
  --project <text>    only sessions whose working directory contains <text>
  --exclude <text>    skip sessions whose id starts with, or whose working directory
                      contains, <text> (repeatable)
  --agent <name>      claude or codex (repeatable; default: both)
  --by <col>          compare by "agent" (default) or "model"
  --examples <n>      examples to show per finding type (default 3, 0 to hide)
  --html [file]       write a numbers-only report to share (default polygraph.html)
  --json              print full results as JSON (findings, unclear reasons, unreadable files; keep it local)
  --ci                also use GitHub Actions results (goes online: asks the GitHub API,
                      through your \`gh\` login, about the repositories your sessions pushed to)
  --demo              run on generated sample sessions instead of yours
  --claude-dir <dir>  Claude Code projects dir (default ~/.claude/projects)
  --codex-dir <dir>   Codex sessions dir (default ~/.codex/sessions)
  -h, --help          show this help
  -v, --version       show the version

Guard (stop unbacked "tests pass" claims as they happen):

  npx agent-polygraph guard --install            add a Stop hook to this project (.claude/, .codex/)
  npx agent-polygraph guard --install --global   add it for every project (~/.claude, ~/.codex)
  npx agent-polygraph guard --uninstall [--global]
      --agent claude|codex   only that agent's config

Record (more evidence than the logs carry; stays on this machine):

  npx agent-polygraph record --install [--global]   hook that snapshots the working tree after test
                                                    and file-writing commands (.claude/, .codex/)
  npx agent-polygraph record --install --shell      log test commands you run in your own terminals
                                                    (bash, zsh; time, folder, exit code; no output)
  npx agent-polygraph record --uninstall [--global] [--shell]
`;

async function record(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      install: { type: "boolean" },
      uninstall: { type: "boolean" },
      global: { type: "boolean" },
      shell: { type: "boolean" },
      agent: { type: "string", multiple: true },
      command: { type: "string" },
    },
  });
  const rec = await import("../src/record.js");
  if (!values.install && !values.uninstall) {
    // invoked by the agent as a PostToolUse hook: quiet, and never in the way
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    rec.runRecordHook(Buffer.concat(chunks).toString("utf8"));
    return;
  }
  const { install, uninstall } = await import("../src/guard.js");
  const opts = { sub: "record", agents: values.agent?.length ? values.agent : ["claude", "codex"], global: values.global, command: values.command };
  // --shell alone touches only the shell setup
  const hooks = values.shell ? [] : values.install ? install(opts) : uninstall(opts);
  for (const r of hooks) {
    const verb = values.install ? (r.changed ? "added PostToolUse hook to" : "already installed in") : r.changed ? "removed PostToolUse hook from" : "nothing to remove in";
    console.log(`${r.agent === "claude" ? "Claude Code" : "Codex"}: ${verb} ${r.file}`);
  }
  if (values.shell) {
    const out = values.install ? rec.installShell() : rec.uninstallShell();
    for (const r of out.rcs) console.log(`Shell: ${values.install ? (r.changed ? "added a line to" : "already in") : "removed the line from"} ${r.file}`);
    if (values.install) console.log(`Shell: ${out.rcs.length ? "open a new terminal to start logging" : "no ~/.bashrc or ~/.zshrc found; source " + out.script + " from your shell's startup file"}. Only interactive bash and zsh are supported.`);
  }
  if (values.install) {
    console.log(`\nRecords are kept in ${rec.home()} and never leave this machine.`);
    if (hooks.length) {
      console.log(`Hook command: ${hooks[0].command}`);
      console.log("Snapshots start with the next session; earlier sessions are read as before.");
      if (hooks.some((r) => r.agent === "codex")) console.log("Codex: run `codex` once and approve the new hook when it says it needs review; until then Codex skips it.");
    }
  }
}

async function guard(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      install: { type: "boolean" },
      uninstall: { type: "boolean" },
      global: { type: "boolean" },
      agent: { type: "string", multiple: true },
      command: { type: "string" },
    },
  });
  const { runHook, install, uninstall } = await import("../src/guard.js");
  if (!values.install && !values.uninstall) {
    // invoked by the agent as a Stop hook; never fail the agent's turn
    try {
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      const out = await runHook(Buffer.concat(chunks).toString("utf8"));
      if (out) process.stdout.write(JSON.stringify(out));
    } catch (e) {
      if (process.env.POLYGRAPH_DEBUG) console.error(e);
    }
    return;
  }
  const opts = { agents: values.agent?.length ? values.agent : ["claude", "codex"], global: values.global, command: values.command };
  const results = values.install ? install(opts) : uninstall(opts);
  for (const r of results) {
    const verb = values.install ? (r.changed ? "added Stop hook to" : "already installed in") : r.changed ? "removed Stop hook from" : "nothing to remove in";
    console.log(`${r.agent === "claude" ? "Claude Code" : "Codex"}: ${verb} ${r.file}`);
  }
  if (values.install) {
    console.log(`\nHook command: ${results[0].command}`);
    console.log("When a final message says tests pass without a passing run after the last edit, the agent is asked once to rerun them.");
    if (results.some((r) => r.agent === "codex")) {
      console.log(
        values.global
          ? "Codex: run `codex` once and approve the new hook when it says it needs review; until then Codex skips it."
          : "Codex: run `codex` once in this project, trust the folder, and approve the new hook when it says it needs review; until then Codex skips it.",
      );
    }
  }
}

let args;
try {
  args = parseArgs({
    allowPositionals: false,
    options: {
      since: { type: "string" },
      project: { type: "string" },
      exclude: { type: "string", multiple: true },
      agent: { type: "string", multiple: true },
      by: { type: "string", default: "agent" },
      examples: { type: "string", default: "3" },
      html: { type: "string" },
      json: { type: "boolean" },
      demo: { type: "boolean" },
      ci: { type: "boolean" },
      "claude-dir": { type: "string" },
      "codex-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    // `--html` with no value
    strict: true,
    tokens: false,
    args: process.argv.slice(2).flatMap((a, i, arr) => (a === "--html" && (!arr[i + 1] || arr[i + 1].startsWith("-")) ? ["--html", "polygraph.html"] : [a])),
  }).values;
} catch (e) {
  console.error(`${e.message}\n\n${HELP}`);
  process.exit(2);
}

if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (args.version) {
  console.log(version);
  process.exit(0);
}

const agents = args.agent?.map((a) => a.toLowerCase());
if (agents?.some((a) => !["claude", "codex"].includes(a))) {
  console.error("--agent must be claude or codex");
  process.exit(2);
}
if (!["agent", "model"].includes(args.by)) {
  console.error('--by must be "agent" or "model"');
  process.exit(2);
}

const since = parseSince(args.since);
if (args.since && !since) {
  console.error(`Can't read --since ${args.since}; use a date like 2026-10-01 or an age like 7d`);
  process.exit(2);
}

const started = Date.now();
const progress = process.stderr.isTTY && !args.json;
let roots = { claude: args["claude-dir"], codex: args["codex-dir"] };
let demoDir;
if (args.demo) {
  const { makeDemo } = await import("../src/demo.js");
  const d = makeDemo();
  demoDir = d.root;
  roots = { claude: d.claudeDir, codex: d.codexDir };
}
let ci = null;
if (args.ci && !args.demo) {
  const { checkGh, makeCi } = await import("../src/ci.js");
  try {
    await checkGh();
    ci = makeCi();
    console.error("--ci: asking GitHub (api.github.com, through your gh login) for workflow runs of the repositories your sessions pushed to. Only repository names, branches and dates are sent.");
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
const sessions = await scan({
  agents,
  since,
  project: args.project,
  exclude: args.exclude,
  roots,
  records: !args.demo,
  enrich: ci ? ci.enrich : undefined,
  onProgress: progress ? (done, total) => process.stderr.write(`\rReading sessions… ${done}/${total}`) : undefined,
});
if (progress) process.stderr.write("\r\x1b[K");
const groups = aggregate(sessions);
const seconds = (Date.now() - started) / 1000;
if (demoDir) fs.rmSync(demoDir, { recursive: true, force: true });

if (args.json) {
  process.stdout.write(JSON.stringify({ version, groups, sessions, skipped: sessions.skipped, unrecognized: sessions.unrecognized }, null, 2) + "\n");
} else {
  console.log(renderTerminal({ sessions, groups, seconds, by: args.by, examples: Math.max(0, Number(args.examples) || 0), demo: args.demo }));
}

if (args.html) {
  const file = path.resolve(args.html);
  fs.writeFileSync(file, renderHtml({ groups, by: args.by, version, demo: args.demo, skipped: sessions.skipped?.length || 0, unrecognized: sessions.unrecognized?.length || 0 }));
  console.error(`Wrote ${file}`);
}

function parseSince(s) {
  if (!s) return null;
  const rel = /^(\d+)\s*([dwmy])$/i.exec(s.trim());
  if (rel) {
    const days = { d: 1, w: 7, m: 30, y: 365 }[rel[2].toLowerCase()] * Number(rel[1]);
    return Date.now() - days * 86400000;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}
