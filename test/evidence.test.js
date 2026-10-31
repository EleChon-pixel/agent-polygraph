// Evidence beyond what the parsers read by default: Claude Code's saved full outputs,
// background output read through the shell, denied commands, full-suite claims judged by
// counts, `record` snapshots and terminal runs, and GitHub Actions results (--ci).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as claude from "../src/sources/claude.js";
import { analyzeSession } from "../src/analyze.js";
import { findCiClaim, findTestClaim, outcomeFromOutput, passedCount } from "../src/classify.js";
import { applyRecords, runRecordHook, recordsFile, snapshot, treeDiff, installShell, uninstallShell } from "../src/record.js";
import { makeCi } from "../src/ci.js";
import { install, uninstall, isOurHook } from "../src/guard.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "polygraph-evidence-"));
process.env.AGENT_POLYGRAPH_HOME = tmp();

const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);
const at = (s) => new Date(T0 + s * 1000).toISOString();
const writeJsonl = (recs, dir = tmp()) => {
  const f = path.join(dir, "s.jsonl");
  fs.writeFileSync(f, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return f;
};
const verdict = (claims) => Object.entries(claims).find(([, n]) => n)?.[0] ?? "none";

const mk = (cwd) => ({
  tool: (s, id, name, input) => ({ type: "assistant", timestamp: at(s), cwd, gitBranch: "main", message: { content: [{ type: "tool_use", id, name, input }] } }),
  res: (s, id, text, isError = false) => ({ type: "user", timestamp: at(s), cwd, message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] } }),
  say: (s, text) => ({ type: "assistant", timestamp: at(s), cwd, message: { content: [{ type: "text", text }] } }),
  note: (s, text) => ({ type: "user", timestamp: at(s), cwd, message: { content: text } }),
});
const { tool, res, say, note } = mk("/repo");
const parse = async (recs, dir) => claude.parse({ id: "x", files: [writeJsonl(recs, dir)] });

test("Claude Code: a test result saved to a file because it was too long is read from that file", async () => {
  const dir = tmp();
  const saved = path.join(dir, "out.txt");
  fs.writeFileSync(saved, ".".repeat(40000) + "\n3 failed, 997 passed in 12.0s\n");
  const preview = `<persisted-output>\nOutput too large (40.1KB). Full output saved to: ${saved}\n\nPreview (first 2KB):\n.......\n...\n</persisted-output>`;
  const s = analyzeSession(await parse([tool(1, "a", "Bash", { command: "pytest" }), res(2, "a", preview), say(3, "All tests pass.")]));
  assert.equal(verdict(s.claims), "failed");
});

test("Claude Code: `tail` of a background run's output file through the shell is evidence about that run", async () => {
  const out = "/tmp/claude-1000/x/tasks/b7vy.output";
  const s = analyzeSession(
    await parse([
      tool(1, "a", "Bash", { command: "pytest -q", run_in_background: true }),
      res(2, "a", `Command running in background with ID: b7vy. Output is being written to: ${out}`),
      note(30, `<task-notification>\n<task-id>b7vy</task-id>\n<tool-use-id>a</tool-use-id>\n<output-file>${out}</output-file>\n<status>completed</status>\n</task-notification>`),
      tool(31, "b", "Bash", { command: `tail -5 ${out}` }),
      res(32, "b", "....\n5055 passed, 3 skipped in 786.91s (0:13:06)\n\n[exited with code 0]"),
      say(33, "Full suite: 5055 passed, 3 skipped."),
    ]),
  );
  assert.equal(verdict(s.claims), "backed");
});

test("a command refused by a permission check never ran: it isn't the latest test run", async () => {
  const s = analyzeSession(
    await parse([
      tool(1, "a", "Bash", { command: "npm test" }),
      res(2, "a", "ℹ pass 1706\nℹ fail 0"),
      tool(3, "b", "Bash", { command: "pkill -f pytest; npm test" }),
      res(4, "b", "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Interfere With Workloads].", true),
      say(5, "1706 tests pass."),
    ]),
  );
  assert.equal(verdict(s.claims), "backed");
  assert.equal(s.testRuns, 1);
});

test("node --test summary joined onto one line still reads", () => {
  assert.equal(outcomeFromOutput("tests: ℹ pass 66 ℹ fail 0 \n56e4932 WIP"), "pass");
  assert.equal(outcomeFromOutput("tests: ℹ pass 64 ℹ fail 2"), "fail");
  assert.equal(passedCount("tests: ℹ pass 66 ℹ fail 0"), 66);
});

test('"the full suite passes" is judged against the latest full-size run, by counts', async () => {
  const edit = (s, id) => [tool(s, id, "Edit", { file_path: "/repo/src/a.py", old_string: "x", new_string: "y" }), res(s + 1, id, "The file /repo/src/a.py has been updated successfully.")];
  const recs = [
    tool(1, "a", "Bash", { command: "pytest -q" }), res(2, "a", "812 passed in 30.1s"),
    ...edit(3, "e"),
    tool(5, "b", "Bash", { command: "pytest -q tests/test_a.py" }), res(6, "b", "14 passed in 0.4s"),
  ];
  // the full run predates the edit: stale, though the focused run after it passed
  const stale = analyzeSession(await parse([...recs, say(7, "The full suite passes.")]));
  assert.equal(verdict(stale.claims), "stale");
  // without a full-suite claim, the latest run is the reference as before
  const plain = analyzeSession(await parse([...recs, say(7, "All tests pass.")]));
  assert.equal(verdict(plain.claims), "backed");
  // a full run after the edit backs it
  const ok = analyzeSession(await parse([...recs, tool(7, "c", "Bash", { command: "pytest -q" }), res(8, "c", "812 passed in 30.0s"), tool(9, "d", "Bash", { command: "pytest -q tests/test_a.py" }), res(10, "d", "14 passed in 0.4s"), say(11, "The full suite passes.")]));
  assert.equal(verdict(ok.claims), "backed");
});

// --- record: snapshots -------------------------------------------------------------------

function gitRepo() {
  const dir = tmp();
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "a.py"), "x = 1\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "build/\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return { dir, git };
}

test("record: snapshots never write to the repository and see untracked, unignored changes", () => {
  const { dir, git } = gitRepo();
  const before = git("count-objects", "-v").toString();
  const a = snapshot(dir);
  fs.mkdirSync(path.join(dir, "build"));
  fs.writeFileSync(path.join(dir, "build", "out.py"), "ignored\n");
  const b = snapshot(dir);
  assert.equal(a.tree, b.tree, "ignored files don't change the snapshot");
  fs.writeFileSync(path.join(dir, "src", "new.py"), "y = 2\n");
  fs.writeFileSync(path.join(dir, "src", "a.py"), "x = 3\n");
  const c = snapshot(dir);
  assert.deepEqual(treeDiff(a, c).sort(), ["src/a.py", "src/new.py"]);
  assert.equal(git("count-objects", "-v").toString(), before, "repository object store untouched");
  assert.match(git("status", "--porcelain").toString(), /^\?\? src\/new\.py$/m, "the real index is untouched too");
});

async function recordedSession(dir, scriptWrites) {
  const { tool, res, say } = mk(dir);
  const script = "python3 - <<'PY'\nopen(p, 'w').write(s)\nPY";
  const transcript = writeJsonl([
    tool(1, "a", "Bash", { command: "pytest -q" }),
    res(2, "a", "5 passed in 0.1s"),
    tool(3, "b", "Bash", { command: script }),
    res(4, "b", ""),
    say(5, "All tests pass."),
  ]);
  // what the PostToolUse hook saves at the moments the agent ran each command
  runRecordHook(JSON.stringify({ transcript_path: transcript, cwd: dir, tool_name: "Bash", tool_use_id: "a", tool_input: { command: "pytest -q" }, tool_response: { stdout: "5 passed in 0.1s" } }));
  scriptWrites();
  runRecordHook(JSON.stringify({ transcript_path: transcript, cwd: dir, tool_name: "Bash", tool_use_id: "b", tool_input: { command: script }, tool_response: { stdout: "" } }));
  return { session: await claude.parse({ id: "x", files: [transcript] }), transcript };
}

test("record: an unresolved write that changed no source file no longer leaves the claim unknown", async () => {
  const { dir } = gitRepo();
  const { session } = await recordedSession(dir, () => fs.writeFileSync(path.join(dir, "notes.txt"), "hi\n"));
  assert.equal(verdict(analyzeSession(session).claims), "unknown", "without records: unknown as before");
  const s = analyzeSession(applyRecords(session, { terminal: [] }));
  assert.equal(verdict(s.claims), "backed");
  assert.equal(s.evidence.snapshot, 1);
});

test("record: an unresolved write that changed a source file makes the claim stale, naming the file", async () => {
  const { dir } = gitRepo();
  const { session } = await recordedSession(dir, () => fs.writeFileSync(path.join(dir, "src", "a.py"), "x = 99\n"));
  const s = analyzeSession(applyRecords(session, { terminal: [] }));
  assert.equal(verdict(s.claims), "stale");
  assert.equal(s.findings.find((f) => f.type === "claim").detail.editedAfter, "src/a.py");
});

test("record: the hook stores the runner's outcome, used when the log's copy is unreadable", async () => {
  const dir = tmp();
  const { tool, res, say } = mk(dir);
  const transcript = writeJsonl([tool(1, "a", "Bash", { command: "npm test" }), res(2, "a", "<persisted-output>\nOutput too large. Full output saved to: /gone/x.txt\n</persisted-output>"), say(3, "All tests pass.")]);
  runRecordHook(JSON.stringify({ transcript_path: transcript, cwd: dir, tool_name: "Bash", tool_use_id: "a", tool_input: { command: "npm test" }, tool_response: { stdout: "...\nℹ pass 40\nℹ fail 2\n" } }));
  assert.ok(fs.existsSync(recordsFile(transcript)));
  const session = await claude.parse({ id: "x", files: [transcript] });
  const s = analyzeSession(applyRecords(session, { terminal: [] }));
  assert.equal(verdict(s.claims), "failed");
});

test("record: the hook ignores commands that neither test nor write", () => {
  const transcript = path.join(tmp(), "t.jsonl");
  runRecordHook(JSON.stringify({ transcript_path: transcript, cwd: tmp(), tool_name: "Bash", tool_input: { command: "ls -la" }, tool_response: { stdout: "" } }));
  runRecordHook("not json");
  assert.equal(fs.existsSync(recordsFile(transcript)), false);
});

// --- record: terminal runs ------------------------------------------------------------------

test("record --shell: a test you ran in your own terminal is evidence for the session", async () => {
  const recs = [
    tool(1, "e", "Edit", { file_path: "/repo/src/a.py", old_string: "x", new_string: "y" }),
    res(2, "e", "The file /repo/src/a.py has been updated successfully."),
    say(60, "All tests pass."),
  ];
  const run = (exit, cwd = "/repo") => ({ v: 1, kind: "terminal", start: (T0 + 10_000) / 1000, end: (T0 + 40_000) / 1000, exit, cwd, cmd: "pytest -q" });
  assert.equal(verdict(analyzeSession(await parse(recs)).claims), "no-run");
  const ok = analyzeSession(applyRecords(await parse(recs), { terminal: [run(0)] }));
  assert.equal(verdict(ok.claims), "backed");
  assert.equal(ok.evidence.terminal, 1);
  assert.equal(ok.testRuns, 0, "your runs aren't counted as the agent's");
  assert.equal(verdict(analyzeSession(applyRecords(await parse(recs), { terminal: [run(1)] })).claims), "failed");
  assert.equal(verdict(analyzeSession(applyRecords(await parse(recs), { terminal: [run(0, "/elsewhere")] })).claims), "no-run");
  // an edit after your run still makes it stale
  const later = [...recs.slice(0, 2), tool(50, "f", "Edit", { file_path: "/repo/src/a.py", old_string: "y", new_string: "z" }), res(51, "f", "The file /repo/src/a.py has been updated successfully."), say(60, "All tests pass.")];
  assert.equal(verdict(analyzeSession(applyRecords(await parse(later), { terminal: [run(0)] })).claims), "stale");
});

test("record --shell: the shell script is valid bash and install/uninstall edit only its own line", () => {
  execFileSync("bash", ["-n", new URL("../src/shell/record.sh", import.meta.url).pathname]);
  const home = tmp();
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.writeFileSync(path.join(home, ".bashrc"), "alias ll='ls -l'\n");
    const a = installShell();
    assert.equal(a.rcs.find((r) => r.file.endsWith(".bashrc")).changed, true);
    assert.equal(installShell().rcs.find((r) => r.file.endsWith(".bashrc")).changed, false);
    assert.match(fs.readFileSync(path.join(home, ".bashrc"), "utf8"), /agent-polygraph record/);
    uninstallShell();
    assert.equal(fs.readFileSync(path.join(home, ".bashrc"), "utf8").trim(), "alias ll='ls -l'");
  } finally {
    process.env.HOME = prev;
  }
});

test("record --install adds a PostToolUse hook next to guard's Stop hook, and removes only its own", () => {
  const cwd = tmp();
  install({ cwd, agents: ["claude", "codex"], command: "agent-polygraph guard" });
  install({ cwd, sub: "record", agents: ["claude", "codex"], command: "agent-polygraph record" });
  install({ cwd, sub: "record", agents: ["claude", "codex"], command: "npx -y agent-polygraph@0.2.0 record" });
  const cc = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"));
  assert.equal(cc.hooks.PostToolUse.length, 1);
  assert.equal(cc.hooks.PostToolUse[0].matcher, "Bash|PowerShell");
  assert.equal(cc.hooks.PostToolUse[0].hooks[0].command, "npx -y agent-polygraph@0.2.0 record");
  assert.equal(cc.hooks.Stop[0].hooks[0].command, "agent-polygraph guard");
  const cx = JSON.parse(fs.readFileSync(path.join(cwd, ".codex", "hooks.json"), "utf8"));
  assert.equal(cx.hooks.PostToolUse[0].matcher, undefined);
  uninstall({ cwd, sub: "record", agents: ["claude", "codex"] });
  const after = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"));
  assert.equal(after.hooks.PostToolUse, undefined);
  assert.equal(after.hooks.Stop.length, 1);
  assert.equal(isOurHook({ command: "agent-polygraph record" }, "guard"), false);
});

// --- --ci ------------------------------------------------------------------------------------

function ghStub(runs, jobs = {}) {
  const calls = [];
  const gh = async (endpoint, params) => {
    calls.push({ endpoint, params });
    if (endpoint.endsWith("/jobs")) return { jobs: jobs[endpoint.split("/").at(-2)] || [{ name: "test", steps: [{ name: "Run tests" }] }] };
    return { workflow_runs: runs };
  };
  return { gh, calls };
}
const wf = (id, sha, createdS, doneS, conclusion, name = "CI") => ({ id, name, head_sha: sha, event: "push", status: doneS == null ? "in_progress" : "completed", conclusion: doneS == null ? null : conclusion, created_at: at(createdS), updated_at: at(doneS ?? createdS), html_url: `https://github.com/o/r/actions/runs/${id}` });

function pushedRepo() {
  const { dir, git } = gitRepo();
  git("remote", "add", "origin", "git@github.com:o/r.git");
  return dir;
}

async function ciSession(dir, extra, runs, jobs) {
  const { tool, res, say } = mk(dir);
  const session = await claude.parse({
    id: "x",
    files: [
      writeJsonl([
        tool(1, "e", "Edit", { file_path: `${dir}/src/a.py`, old_string: "x", new_string: "y" }),
        res(2, "e", `The file ${dir}/src/a.py has been updated successfully.`),
        tool(3, "c", "Bash", { command: "git commit -am fix && git push" }),
        res(4, "c", "[main 1a2b3c4] fix\nTo github.com:o/r.git\n   0f0f0f0..1a2b3c4  main -> main"),
        ...extra.map((f) => f({ tool, res, say })),
      ]),
    ],
  });
  const stub = ghStub(runs, jobs);
  const ci = makeCi({ gh: stub.gh });
  await ci.enrich(session);
  return { s: analyzeSession(session), calls: stub.calls, ci };
}

test("--ci: a test workflow on the pushed commit backs a claim made after it finished", async () => {
  const dir = pushedRepo();
  const { s, calls } = await ciSession(dir, [({ say }) => say(400, "All tests pass.")], [wf(1, "1a2b3c4d5e6f", 10, 300, "success")]);
  assert.equal(verdict(s.claims), "backed");
  assert.equal(s.evidence.ci, 1);
  assert.equal(calls[0].endpoint, "repos/o/r/actions/runs");
  assert.equal(calls[0].params.branch, undefined, "only the repository and a date range are sent");
  assert.match(calls[0].params.created, /^\d{4}-\d\d-\d\d\.\.\d{4}-\d\d-\d\d$/);
});

test("--ci: a failed workflow fails the claim; one still running when the claim was made doesn't count", async () => {
  const dir = pushedRepo();
  assert.equal(verdict((await ciSession(dir, [({ say }) => say(400, "All tests pass.")], [wf(1, "1a2b3c4", 10, 300, "failure")])).s.claims), "failed");
  assert.equal(verdict((await ciSession(dir, [({ say }) => say(200, "All tests pass.")], [wf(1, "1a2b3c4", 10, 300, "success")])).s.claims), "no-run");
});

test("--ci: an edit after the push makes the CI result stale", async () => {
  const dir = pushedRepo();
  const { s } = await ciSession(
    dir,
    [({ tool }) => tool(350, "f", "Edit", { file_path: `${dir}/src/a.py`, old_string: "y", new_string: "z" }), ({ res }) => res(351, "f", `The file ${dir}/src/a.py has been updated successfully.`), ({ say }) => say(400, "All tests pass.")],
    [wf(1, "1a2b3c4", 10, 300, "success")],
  );
  assert.equal(verdict(s.claims), "stale");
});

test("--ci: workflows that run no tests (lint, deploy) aren't test evidence", async () => {
  const dir = pushedRepo();
  const { s } = await ciSession(dir, [({ say }) => say(400, "All tests pass.")], [wf(7, "1a2b3c4", 10, 300, "success", "Deploy")], { 7: [{ name: "deploy", steps: [{ name: "Upload" }] }] });
  assert.equal(verdict(s.claims), "no-run");
});

test('--ci: "CI is green" claims are judged against the latest pushed commit\'s runs', async () => {
  const dir = pushedRepo();
  const runs = [wf(1, "1a2b3c4", 10, 300, "failure"), wf(2, "1a2b3c4", 10, 200, "success", "Lint")];
  assert.equal(verdict((await ciSession(dir, [({ say }) => say(400, "CI is green.")], runs)).s.claims), "failed");
  assert.equal(verdict((await ciSession(dir, [({ say }) => say(250, "CI is green.")], runs)).s.claims), "unknown");
  assert.equal(verdict((await ciSession(dir, [({ say }) => say(400, "CI is green.")], [wf(1, "1a2b3c4", 10, 300, "success")])).s.claims), "backed");
  // without --ci, CI claims aren't claims at all
  assert.equal(findTestClaim("Tests pass on CI."), null);
  assert.equal(findCiClaim("Tests pass on CI."), "Tests pass on CI.");
  assert.equal(findCiClaim("I'll check whether CI passes."), null);
});

test("--ci: sessions in repositories without a GitHub remote make no requests", async () => {
  const { dir } = gitRepo();
  const { calls } = await ciSession(dir, [({ say }) => say(400, "All tests pass.")], []);
  assert.equal(calls.length, 0);
});

test("a file a script writes is placed by the cd in effect where it's named, not the command's last cd", async () => {
  const cmd = "cd /tmp/scratch && python3 - <<'EOF'\ns=open('r3.py').read()\nopen('r3c.py','w').write(s)\nEOF\ncd /repo && python3 /tmp/scratch/r3c.py";
  const s = analyzeSession(await parse([tool(1, "a", "Bash", { command: "pytest -q" }), res(2, "a", "5 passed in 0.1s"), tool(3, "b", "Bash", { command: cmd }), res(4, "b", "ok"), say(5, "All tests pass.")]));
  assert.equal(verdict(s.claims), "backed");
  // the same write after `cd /repo` is an edit to the checkout
  const t = analyzeSession(await parse([tool(1, "a", "Bash", { command: "pytest -q" }), res(2, "a", "5 passed in 0.1s"), tool(3, "b", "Bash", { command: "cd /repo && python3 - <<'EOF'\nopen('src/x.py','w').write(s)\nEOF" }), res(4, "b", ""), say(5, "All tests pass.")]));
  assert.equal(verdict(t.claims), "stale");
});

test("a script's writes: clear write targets are edits, files it only reads are not, unnamed writes are unresolved", async () => {
  const { shellWrites } = await import("../src/classify.js");
  const w = (body) => shellWrites(`python3 - <<'EOF'\n${body}\nEOF`);
  assert.deepEqual(w('p = Path("src/a.py")\ns = p.read_text()\np.write_text(s.replace("a", "b"))'), { paths: ["src/a.py"], unresolved: false });
  assert.deepEqual(w('p="src/a.py"\ns=open(p).read()\nopen(p,"w").write(s)'), { paths: ["src/a.py"], unresolved: false });
  assert.deepEqual(w('with open("src/c.py", "w") as f: f.write(x)'), { paths: ["src/c.py"], unresolved: false });
  // reads only, even next to a write elsewhere in the command
  assert.deepEqual(shellWrites(`cat > notes.txt <<'X'\nhi\nX\npython3 - <<'EOF'\nfor f in ["src/a.py", "src/b.py"]: ast.parse(Path(f).read_text())\nEOF`).paths, ["notes.txt"]);
  assert.deepEqual(w('import sys; sys.stdout.write(open("src/a.py").read())'), { paths: [], unresolved: false });
  // a write we can't tie to a name
  assert.deepEqual(w('for f in ["src/a.py"]:\n    t = Path(f).read_text(); Path(f).write_text(t)'), { paths: [], unresolved: true });
});

test("a script's writes: paths joined onto a folder variable, and archive/copy writes", async () => {
  const { shellWrites } = await import("../src/classify.js");
  const w = (body) => shellWrites(`python3 - <<'EOF'\n${body}\nEOF`);
  assert.deepEqual(w("p=root/'scripts/run.py';s=p.read_text();p.write_text(s)"), { paths: ["scripts/run.py"], unresolved: false });
  assert.deepEqual(w("p = os.path.join(ROOT, 'src/a.py')\nopen(p, 'w').write(x)"), { paths: ["src/a.py"], unresolved: false });
  assert.deepEqual(w("(ROOT / 'src/b.py').write_text(x)"), { paths: ["src/b.py"], unresolved: false });
  assert.equal(w("with tarfile.open('src.tgz') as a: a.extractall(root)").unresolved, true);
  assert.equal(w("shutil.copy('a.py', dest)").unresolved, true);
});

test("--ci: a quiet push is tied to a run only through a commit id the session printed", async () => {
  const dir = pushedRepo();
  const session = async (commitOut) => {
    const { tool, res, say } = mk(path.dirname(dir)); // the session runs in the repo's parent folder
    const s = await claude.parse({
      id: "x",
      files: [
        writeJsonl([
          tool(1, "e", "Edit", { file_path: `${dir}/src/a.py`, old_string: "x", new_string: "y" }),
          res(2, "e", `The file ${dir}/src/a.py has been updated successfully.`),
          // pushed from another folder than the session's, quietly
          tool(3, "c", "Bash", { command: `cd ${dir} && git commit -qam fix && git log --oneline -1 && git push -q` }),
          res(4, "c", commitOut),
          say(400, "All tests pass."),
        ]),
      ],
    });
    const ci = makeCi({ gh: ghStub([wf(1, "9f8e7d6c5b4a", 10, 300, "success")]).gh });
    await ci.enrich(s);
    return analyzeSession(s);
  };
  assert.equal(verdict((await session("9f8e7d6 fix")).claims), "backed");
  // a run on a commit the session never showed could be anyone's push
  assert.equal(verdict((await session("")).claims), "no-run");
});

test("--ci: runs GitHub never started (startup_failure) are not evidence either way", async () => {
  const dir = pushedRepo();
  const { s } = await ciSession(dir, [({ say }) => say(400, "All tests pass.")], [wf(1, "1a2b3c4", 10, 11, "startup_failure")]);
  assert.equal(verdict(s.claims), "no-run");
});

test("claims are quoted as written (inline code kept), and guard quotes the message's conclusion", async () => {
  const { findTestClaim, findTestClaims } = await import("../src/classify.js");
  const msg = "Step 1: `npm test` ran and passed (1 test, 0 failures).\n\nStep 2: I changed `calc.js`.\n\nAll tests pass.";
  assert.equal(findTestClaim(msg), "Step 1: `npm test` ran and passed (1 test, 0 failures).");
  assert.deepEqual(findTestClaims(msg).at(-1), "All tests pass.");
  assert.equal(findTestClaim('I won\'t say "all tests pass" yet.'), null);
});

test("a pass the agent itself says was against the original code is not a claim", async () => {
  const { findTestClaim } = await import("../src/classify.js");
  assert.equal(findTestClaim('- **Step 1:** `npm test` passed (1 test, "adds two numbers"), but that run was against the original `calc.js`.'), null);
});

test('"the original 1720 plus 12 new tests" is still a claim', async () => {
  const { findTestClaim } = await import("../src/classify.js");
  assert.ok(findTestClaim("The full suite passes: 1732 passed, which is the original 1720 plus 12 new tests."));
});
