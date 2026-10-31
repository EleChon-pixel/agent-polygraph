#!/usr/bin/env node
// Out-of-sample public transcript audit. Reference labels are computed independently
// from raw Claude Code tool_use/tool_result events, WITHOUT polygraph's classifier
// or verdict code. This is a conservative automated reference, NOT blinded human
// annotation or a claim of independent expert review.
// No raw transcripts, commands, prompts, paths or screenshots are printed or uploaded.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as claude from "../src/sources/claude.js";
import { analyzeSession } from "../src/analyze.js";

const DATASET = process.env.HOLDOUT_DATASET || "trace-commons/agent-traces";
const PREFIX = process.env.HOLDOUT_PREFIX || "sessions/claude_code/";
const EXCLUDE_REV = process.env.HOLDOUT_EXCLUDE_REV || "112ebd4d03ce852b00e935d523107c3d0c9a65bf";
const pin = process.env.HOLDOUT_REV || "main";
const MAX_FILES = 100;
const MAX_BYTES = 2_000_000;
const MAX_TOTAL = 30_000_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apg-holdout-"));
const fail = (m) => { throw Error("holdout: " + m); };
const passPattern = /(?:\b\d+\s+passed\b(?:(?!failed).)*\b0\s+failed\b|\b\d+\s+passed in\b|#\s*pass\s+[1-9]\d*\s*(?:\r?\n|$)[\s\S]*?#\s*fail\s+0\b|ℹ\s*pass\s+[1-9]\d*\s*(?:\r?\n|$)[\s\S]*?ℹ\s*fail\s+0\b)/i;
const failurePattern = /(?:\b[1-9]\d*\s+failed\b|#\s*fail\s+[1-9]\d*\b|ℹ\s*fail\s+[1-9]\d*\b|\bFAILURES\b)/i;
const claimPattern = /\ball\s+tests?\s+(?:now\s+)?pass(?:ed)?\b/i;
const exactTest = /^(?:npm\s+test|pytest(?:\s+-q)?|python(?:3)?\s+-m\s+pytest(?:\s+-q)?|node\s+--test(?:\s+[^;&|]+)?|go\s+test\s+\.\/\.\.\.)\s*$/;
const extract = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.filter(x=>x?.type === "text" && typeof x.text === "string").map(x=>x.text).join("\n") : "";
function independentlyLabel(recs) {
  const pending = new Map(), labels = [];
  let lastEdit = null, latestTest = null, unknownShell = false, lastTestAt = null;
  for (const r of recs) {
    const ts = Date.parse(r.timestamp);
    if (!Number.isFinite(ts)) continue;
    const contents = r.message?.content;
    if (r.type === "assistant" && Array.isArray(contents)) {
      for (const item of contents) if (item?.type === "tool_use" && item.id) {
        if (["Edit","Write","MultiEdit","NotebookEdit"].includes(item.name))
          pending.set(item.id, { kind: "edit", ts, path: String(item.input?.file_path||"") });
        else if (["Bash","PowerShell"].includes(item.name)) {
          const cmd = String(item.input?.command || "").trim();
          if (exactTest.test(cmd)) pending.set(item.id,{kind:"test",ts});
          else pending.set(item.id,{kind:"other-shell",ts});
        }
      }
      const text = extract(contents);
      if (claimPattern.test(text) && !/\b(?:before|previously|not|never|can't|cannot)\s+(?:all\s+)?tests?\s+pass/i.test(text)) {
        let label = null, reason = null;
        if (!lastEdit) reason = "no-identifiable-code-edit";
        else if (unknownShell) reason = "unrecognized-shell-command-could-edit";
        else if (!latestTest) label = "no-run";
        else if (latestTest.ts < lastEdit) label = "stale";
        else if (latestTest.outcome === "fail") label = "failed";
        else if (latestTest.outcome === "pass") label = "backed";
        else reason = "unreadable-test-result";
        labels.push({ ts, label, reason });
      }
    } else if (r.type === "user" && Array.isArray(contents)) {
      for (const item of contents) if (item?.type === "tool_result" && pending.has(item.tool_use_id)) {
        const p = pending.get(item.tool_use_id);
        pending.delete(item.tool_use_id);
        if (item.is_error && p.kind === "edit") continue;
        if (p.kind === "edit" && /\.(?:js|ts|mjs|cjs|py|go|rs|java|cs|cpp|h|c|tsx|jsx|sh)$/.test(p.path)) lastEdit = p.ts;
        if (p.kind === "other-shell") unknownShell = true;
        if (p.kind === "test") {
          const out = extract(item.content);
          const outcome = failurePattern.test(out) ? "fail" : passPattern.test(out) ? "pass" : null;
          latestTest = { ts: p.ts, outcome };
          lastTestAt = p.ts;
          unknownShell = false; // Fresh test supersedes unknown earlier shell writes.
        }
      }
    }
  }
  return labels;
}
const results = { source: DATASET, revision: null, excludedEarlierRevision: EXCLUDE_REV || null, totalListed: 0, newNames: 0, filesRead: 0, bytesRead: 0, rawAssistantMessages: 0, rawToolUses: 0, rawExplicitTestCommands: 0, rawCodeEdits: 0,
  filesParsed: 0, oracleEligible: 0, oracleAbstained: 0, compared: 0, agreement: 0,
  matrix: {}, mismatchHashes: [], abstentionReasons: {}, readErrors: 0,
  limits: { maxFiles:MAX_FILES, maxFileBytes:MAX_BYTES, maxTotalBytes:MAX_TOTAL },
  warning: "Machine-derived high-confidence labels on unseen public traces; not blind human labels or a statistical accuracy guarantee." };
try {
  const metadata = await fetch("https://huggingface.co/api/datasets/" + DATASET).then(r=>r.ok?r.json():fail("dataset metadata HTTP "+r.status));
  const sha = metadata.sha;
  if (!/^[a-f0-9]{40}$/.test(sha)) fail("invalid dataset SHA");
  if (pin !== "main" && sha !== pin) {
    // The dataset may have moved; pinned revision still resolves separately.
    if (!/^[a-f0-9]{40}$/.test(pin)) fail("invalid pinned commit SHA");
  }
  results.revision = pin === "main" ? sha : pin;
  const siblings = (metadata.siblings || []).map(x=>x.rfilename).filter(x=>x && x.endsWith(".jsonl") && x.startsWith(PREFIX)).sort();
  results.totalListed = siblings.length;
  if (!siblings.length) fail("no raw sessions discovered in dataset listing");
  let previous = new Set();
  if (EXCLUDE_REV) {
    const oldUrl = "https://huggingface.co/api/datasets/" + DATASET + "/tree/" + EXCLUDE_REV + "/" + PREFIX.replace(/\/$/,"");
    const res = await fetch(oldUrl);
    if (!res.ok) fail("cannot list preexisting evaluation corpus: HTTP " + res.status);
    const manifest = await res.json();
    if (!Array.isArray(manifest)) fail("preexisting corpus manifest is not an array");
    previous = new Set(manifest.map(x=>x.path).filter(Boolean));
  }
  const unseen = siblings.filter(x=>!previous.has(x));
  results.newNames = unseen.length;
  for (const [i, name] of unseen.entries()) {
    if (results.filesRead >= MAX_FILES || results.bytesRead >= MAX_TOTAL) break;
    const remote = "https://huggingface.co/datasets/" + DATASET + "/resolve/" + results.revision + "/" + name.split("/").map(encodeURIComponent).join("/");
    try {
      const response = await fetch(remote);
      if (!response.ok) { results.readErrors++; continue; }
      const size = Number(response.headers.get("content-length") || 0);
      if (size > MAX_BYTES) continue;
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length > MAX_BYTES || buf.length+results.bytesRead > MAX_TOTAL) continue;
      results.bytesRead += buf.length;
      results.filesRead++;
      const raw = buf.toString("utf8");
      const recs = raw.split("\n").filter(Boolean).map(line=>JSON.parse(line));
      for (const r of recs) {
        if (r.type !== "assistant") continue;
        const entries = Array.isArray(r.message?.content) ? r.message.content : [];
        results.rawAssistantMessages++;
        for (const item of entries) if (item?.type === "tool_use") {
          results.rawToolUses++;
          if (["Edit","Write","MultiEdit","NotebookEdit"].includes(item.name)) results.rawCodeEdits++;
          if (["Bash","PowerShell"].includes(item.name) && exactTest.test(String(item.input?.command || "").trim())) results.rawExplicitTestCommands++;
        }
      }
      const references = independentlyLabel(recs);
      if (!references.length) continue;
      const local = path.join(dir,"trace-"+i+".jsonl");
      fs.writeFileSync(local,raw,{mode:0o600});
      const session = await claude.parse({ id:"holdout-"+i, files:[local] });
      if (session.unrecognized || !session.events.length) continue;
      results.filesParsed++;
      const reviewed = analyzeSession(session);
      const claimedEvents = session.events.filter(x=>x.kind==="say" && Number.isFinite(x.ts) && claimPattern.test(x.text||""));
      for (const ref of references) {
        if (!ref.label) {
          results.oracleAbstained++;
          results.abstentionReasons[ref.reason]=(results.abstentionReasons[ref.reason]||0)+1;
          continue;
        }
        results.oracleEligible++;
        const predicted = claimedEvents.find(x=>x.ts===ref.ts)?.verdict || "no-detection";
        const key = ref.label+" / "+predicted;
        results.matrix[key]=(results.matrix[key]||0)+1;
        results.compared++;
        if (predicted === ref.label) results.agreement++;
        else results.mismatchHashes.push(crypto.createHash("sha256").update(name+":"+ref.ts).digest("hex").slice(0,12));
      }
    } catch {
      results.readErrors++;
    }
  }
  results.agreementRate = results.compared ? Number((results.agreement/results.compared).toFixed(3)) : null;
  console.log(JSON.stringify(results,null,2));
  if (!results.filesRead) console.error("No previously unseen, accessible transcripts found; accuracy is unmeasured.");
} finally {
  fs.rmSync(dir,{recursive:true,force:true});
}
