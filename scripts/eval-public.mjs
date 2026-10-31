#!/usr/bin/env node
// Reproduce the public-data evaluation in docs/evaluation.md.
//
//   node scripts/eval-public.mjs [dir]     (default: ./eval-data, git-ignored)
//
// Downloads raw Claude Code session files from public Hugging Face datasets at pinned
// revisions, lays them out the way Claude Code stores them, and runs agent-polygraph.
// The files are only read as data. Some public transcripts warn they may contain
// accidentally pasted secrets: keep the downloads local and don't commit them.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const DATASETS = [
  // name, Hugging Face dataset, pinned revision, folder inside it holding Claude Code sessions
  { name: "trace-commons", repo: "trace-commons/agent-traces", rev: "112ebd4d03ce852b00e935d523107c3d0c9a65bf", dir: "sessions/claude_code", license: "CC-BY-4.0" },
  { name: "thomwolf", repo: "thomwolf/am-session-claude-code-1-c3cc0a", rev: "037d661cb58d4785f9523205350143d8b9af6a7d", dir: "", license: "Apache-2.0" },
];

const out = path.resolve(process.argv[2] || "eval-data");
const claudeDir = path.join(out, "claude");
const codexDir = path.join(out, "codex"); // no public Codex rollouts yet; kept empty

fs.mkdirSync(codexDir, { recursive: true });
for (const d of DATASETS) {
  const target = path.join(claudeDir, d.name);
  fs.mkdirSync(target, { recursive: true });
  const api = `https://huggingface.co/api/datasets/${d.repo}/tree/${d.rev}${d.dir ? "/" + d.dir : ""}`;
  const files = (await (await fetch(api)).json()).filter((f) => f.type === "file" && f.path.endsWith(".jsonl"));
  console.error(`${d.name} (${d.license}, ${d.rev.slice(0, 7)}): ${files.length} sessions`);
  for (const f of files) {
    const dest = path.join(target, path.basename(f.path));
    if (fs.existsSync(dest)) continue;
    const res = await fetch(`https://huggingface.co/datasets/${d.repo}/resolve/${d.rev}/${f.path}`);
    if (!res.ok) throw new Error(`${f.path}: HTTP ${res.status}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }
}

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "polygraph.js");
execFileSync(process.execPath, [bin, "--claude-dir", claudeDir, "--codex-dir", codexDir, ...process.argv.slice(3)], { stdio: "inherit" });
