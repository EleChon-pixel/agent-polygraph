#!/usr/bin/env node
// Prepare cases for blind human audit, then score submitted independent labels.
// No report or reviewer packet is uploaded anywhere. The preparer never calls
// analyzeSession, so its packet cannot leak polygraph predictions.
// Usage:
// node scripts/blind-review.mjs prepare --claude-dir ./public-sessions --out ./review-cases.jsonl
// node scripts/blind-review.mjs score --claude-dir ./public-sessions --labels ./reviewed.jsonl
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseArgs } from "node:util";
import * as claude from "../src/sources/claude.js";
import { analyzeSession } from "../src/analyze.js";

const [mode, ...argv] = process.argv.slice(2);
const { values } = parseArgs({ args: argv, options: {
  "claude-dir": { type: "string" },
  out: { type: "string" },
  labels: { type: "string" },
  limit: { type: "string" },
  "include-quotes": { type: "boolean" },
} });
if (!["prepare", "score"].includes(mode) || !values["claude-dir"] || (mode==="prepare"&&!values.out) || (mode==="score"&&!values.labels)) {
  console.error("Usage: prepare --claude-dir ROOT --out FILE [--limit 150] [--include-quotes] | score --claude-dir ROOT --labels FILE");
  process.exit(2);
}
const root = path.resolve(values["claude-dir"]);
const limit = values.limit == null ? 150 : Number(values.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw Error("limit must be 1–5000");
const cases = [];
const sourceByCase = new Map();
const candidate = /\b(?:tests?|suite|passing|passed|ci|build)\b/i;
for (const entry of claude.discover(root)) {
  try {
    const parsed = await claude.parse(entry);
    if (parsed.unrecognized) continue;
    const file = entry.files[0];
    const relative = path.relative(root,file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const seen = new Map();
    for (const ev of parsed.events) {
      if (ev.kind !== "say" || !candidate.test(ev.text||"")) continue;
      const ordinal = (seen.get(ev.ts)||0)+1;
      seen.set(ev.ts,ordinal);
      const id = crypto.createHash("sha256").update(relative+"\0"+ev.ts+"\0"+ordinal).digest("hex").slice(0,20);
      const row = { id, session: relative, eventTimestampMs: ev.ts, eventOrdinal: ordinal, reviewLabel: null };
      if (values["include-quotes"]) row.quote = (ev.text || "").slice(0,220);
      cases.push(row);
      sourceByCase.set(id, { file, relative, ev, parsed });
    }
  } catch {}
}
cases.sort((a,b)=>a.id.localeCompare(b.id));
const subset = cases.slice(0,limit);
if (mode==="prepare") {
  const file = path.resolve(values.out);
  // The manifest can reveal local paths and optional quotes; save privately.
  fs.writeFileSync(file, subset.map(x=>JSON.stringify(x)).join("\n")+"\n",{mode:0o600,flag:"wx"});
  if(process.platform!=="win32")fs.chmodSync(file,0o600);
  console.log(JSON.stringify({ mode, foundCandidateMessages:cases.length, written:subset.length, file,
    containsModelPredictions:false, containsQuotes:!!values["include-quotes"],
    note:"Local-only packet. Review evidence in each original transcript, not this program's verdict. Do not publish without checking for private data." },null,2));
} else {
  const lines = fs.readFileSync(values.labels,"utf8").split("\n").filter(Boolean);
  const labels = lines.map(s=>JSON.parse(s));
  const accepted = new Set(["backed","stale","failed","no-run","unknown","not-claim"]);
  const used = new Set();
  const counts = { reviewed:0, matched:0, errors:0, byReference:{}, confusion:{}, skippedUnrecognized:0, duplicateIds:0 };
  const results = new Map();
  for (const row of labels) {
    if (used.has(row.id)){counts.duplicateIds++;continue;}
    used.add(row.id);
    if (!accepted.has(row.reviewLabel)){counts.errors++;continue;}
    const lookup = sourceByCase.get(row.id);
    if (!lookup){counts.errors++;continue;}
    let reviewed = results.get(lookup.file);
    if (!reviewed) {
      reviewed = await claude.parse({ id:"review",files:[lookup.file] });
      analyzeSession(reviewed);
      results.set(lookup.file,reviewed);
    }
    const associated = reviewed.events.filter(e=>e.kind==="say" && e.ts===row.eventTimestampMs);
    const e = associated[(row.eventOrdinal||1)-1];
    const expected = row.reviewLabel;
    const predicted = e?.verdict || "not-claim";
    const key = expected+" -> "+predicted;
    counts.reviewed++;
    counts.byReference[expected]=(counts.byReference[expected]||0)+1;
    counts.confusion[key]=(counts.confusion[key]||0)+1;
    if (expected===predicted) counts.matched++;
  }
  if (counts.reviewed) counts.exactAgreement = Number((counts.matched/counts.reviewed).toFixed(3));
  console.log(JSON.stringify({
    mode, ...counts, casesAvailable:cases.length, cohortSource:"reviewer-supplied evidence labels",
    cautions:["The tool cannot verify reviewer independence, conflicts of interest, or data quality",
      "A label of not-claim is a valid disagreement with claim detection",
      "Treat unknown and no-detection distinctly; do not hide abstentions",
      "Do not call self-reviewed or auto-labeled cases independent human ground truth"],
  },null,2));
  if(counts.errors||counts.duplicateIds)process.exitCode=1;
}
