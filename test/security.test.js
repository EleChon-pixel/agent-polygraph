import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { commandFingerprint, recordsFile, runRecordHook, runShellRecord, snapshot, installShell, shellScript, terminalFile } from "../src/record.js";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "apg-sec-"));
const root = temp();
process.env.AGENT_POLYGRAPH_HOME = path.join(root, "evidence");

const event = (cwd = root) => JSON.stringify({
  v: 2, runner: "pytest", start: 10, end: 11, exit: 0, cwd,
});

test("records are private, normalized and never include arbitrary command output", () => {
  assert.equal(runShellRecord(event()), true);
  const p = terminalFile();
  const record = JSON.parse(fs.readFileSync(p, "utf8").trim());
  assert.equal(record.runner, "pytest");
  assert.equal(record.cmd, undefined);
  assert.equal(record.output, undefined);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(p)).mode & 0o777, 0o700);
  }
  assert.equal(runShellRecord(JSON.stringify({runner:"pytest",start:1,end:2,exit:0,cwd:"relative"})),false);
  assert.equal(runShellRecord(JSON.stringify({runner:"pytest; echo secret",start:1,end:2,exit:0,cwd:root})),false);
});

test("record writer rejects malicious final symlinks and hardlinks without changing targets", () => {
  const target = path.join(root, "target.txt");
  fs.writeFileSync(target, "untouched");
  const link = terminalFile();
  fs.rmSync(link, { force: true });
  fs.symlinkSync(target, link);
  assert.equal(runShellRecord(event()), false);
  assert.equal(fs.readFileSync(target, "utf8"), "untouched");
  fs.rmSync(link);
  if (process.platform !== "win32") {
    fs.linkSync(target, link);
    assert.equal(runShellRecord(event()), false);
    assert.equal(fs.readFileSync(target, "utf8"), "untouched");
    fs.rmSync(link);
  }
});

test("record writer rejects a redirected records directory", () => {
  const dest = temp();
  const p = path.join(process.env.AGENT_POLYGRAPH_HOME, "records");
  fs.rmSync(p, { recursive: true, force: true });
  fs.symlinkSync(dest, p, process.platform === "win32" ? "junction" : "dir");
  assert.equal(runShellRecord(event()), false);
  assert.equal(fs.readdirSync(dest).length, 0);
  fs.rmSync(p);
});

test("snapshot refuses symlink targets and oversized source without copying bytes", () => {
  const dir = temp();
  execFileSync("git", ["init", "-q", dir]);
  const sourceDir = path.join(dir, "src");
  fs.mkdirSync(sourceDir);
  fs.writeFileSync(path.join(sourceDir, "ok.py"), "print(1)");
  const first = snapshot(dir);
  assert.ok(first.complete);
  assert.deepEqual(Object.keys(first.files), ["src/ok.py"]);
  const external = path.join(root, "private.py");
  fs.writeFileSync(external, "sensitive information");
  fs.symlinkSync(external, path.join(sourceDir, "link.py"));
  const second = snapshot(dir);
  assert.equal(second.complete, false);
  assert.equal(Object.keys(second.files).includes("src/link.py"), false);
  assert.ok(!JSON.stringify(second).includes("sensitive information"));
  fs.rmSync(path.join(sourceDir, "link.py"));
  fs.writeFileSync(path.join(sourceDir, "huge.py"), Buffer.alloc(8 * 1024 * 1024 + 1));
  const third = snapshot(dir);
  assert.equal(third.complete, false);
});

test("shell integration sends receipts through the safe CLI instead of directly appending", () => {
  if (process.platform === "win32") return;
  const home = temp();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const oldEvidence = process.env.AGENT_POLYGRAPH_HOME;
  process.env.AGENT_POLYGRAPH_HOME = path.join(home, ".agent-polygraph");
  try {
    installShell();
    const source = fs.readFileSync(shellScript(), "utf8");
    assert.match(source, /record --shell-event/);
    assert.doesNotMatch(source, />>\s*["']?\$?__apg_file/);
    const cmd = 'source "$HOME/.agent-polygraph/shell.sh"; __apg_pre "pytest -q"; true; __apg_post; __apg_pre "npm test; true"; true; __apg_post';
    const p = spawnSync("bash", ["-ic", cmd], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 15000 });
    assert.equal(p.status, 0, p.stderr);
    const data = fs.readFileSync(terminalFile(), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(data.length, 1);
    assert.equal(data[0].runner, "pytest");
  } finally {
    process.env.HOME = oldHome;
    process.env.AGENT_POLYGRAPH_HOME = oldEvidence;
  }
});
