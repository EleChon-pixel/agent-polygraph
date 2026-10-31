#!/usr/bin/env node
// A local microbenchmark for the recorder's file-fingerprint cost.
// It uses generated untracked source files, never the user's actual projects.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { snapshot } from "../src/record.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "apg-perf-"));
const runs = [];
try {
  execFileSync("git", ["init", "-q", root]);
  const dir = path.join(root, "src");
  fs.mkdirSync(dir);
  const body = "export const value = 1;\n" + "x".repeat(1024);
  let total = 0;
  for (const n of [100, 1000]) {
    for (let i = total; i < n; i++) fs.writeFileSync(path.join(dir, "file-" + i + ".js"), body);
    total = n;
    const samples = [];
    for (let j = 0; j < 3; j++) {
      const start = performance.now();
      const s = snapshot(root);
      samples.push(Number((performance.now() - start).toFixed(2)));
      if (!s.complete || Object.keys(s.files).length !== n) throw new Error("Snapshot incomplete at " + n + " files");
    }
    samples.sort((a, b) => a - b);
    runs.push({ files: n, bytesPerFile: Buffer.byteLength(body), medianMs: samples[1], samplesMs: samples });
  }
  console.log(JSON.stringify({ environment: { node: process.version, platform: process.platform }, runs, note: "One machine, synthetic source files; not a latency guarantee or production benchmark" }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
