// Regression tests for the ten issues found in the 2026-10-31 external review.
// Each builds a transcript in the agent's real log format and runs it through the parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as claude from "../src/sources/claude.js";
import * as codex from "../src/sources/codex.js";
import { analyzeSession } from "../src/analyze.js";
import { testOutcome } from "../src/classify.js";
import { install, uninstall, runHook } from "../src/guard.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "polygraph-review-"));
const at = (s) => new Date(Date.UTC(2026, 9, 31, 12, 0, s)).toISOString();
const writeJsonl = (recs) => {
  const f = path.join(tmp(), "s.jsonl");
  fs.writeFileSync(f, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return f;
};
const verdict = (claims) => Object.entries(claims).find(([, n]) => n)?.[0] ?? "none";

// Claude Code records
const cwd = "/repo";
const tool = (s, id, name, input) => ({ type: "assistant", timestamp: at(s), cwd, message: { content: [{ type: "tool_use", id, name, input }] } });
const res = (s, id, text, isError = false) => ({ type: "user", timestamp: at(s), cwd, message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] } });
const say = (s, text) => ({ type: "assistant", timestamp: at(s), cwd, message: { content: [{ type: "text", text }] } });
const claudeSession = async (recs) => analyzeSession(await claude.parse({ id: "x", files: [writeJsonl(recs)] }));

// Codex records
const meta = { timestamp: at(0), type: "session_meta", payload: { id: "x", cwd } };
const item = (s, payload) => ({ timestamp: at(s), type: "response_item", payload });
const csay = (s) => item(s, { type: "message", role: "assistant", content: [{ type: "output_text", text: "All tests pass." }] });
const codexSession = async (recs) => analyzeSession(await codex.parse({ id: "x", files: [writeJsonl([meta, ...recs])] }));
const patch = "*** Begin Patch\n*** Update File: src/x.js\n@@\n-old\n+new\n*** End Patch";

test("1. a source edit made through the shell makes earlier tests stale", async () => {
  const s = await claudeSession([
    tool(1, "a", "Bash", { command: "npm test" }), res(2, "a", "ℹ pass 3\nℹ fail 0"),
    tool(3, "b", "Bash", { command: "sed -i 's/old/new/' src/x.js" }), res(4, "b", ""),
    say(5, "All tests pass."),
  ]);
  assert.equal(verdict(s.claims), "stale");
});

test("1b. a write we can't pin to a file makes the claim unknown, not backed", async () => {
  const s = await claudeSession([
    tool(1, "a", "Bash", { command: "npm test" }), res(2, "a", "ℹ pass 3\nℹ fail 0"),
    tool(3, "b", "Bash", { command: "python3 - <<'PY'\nimport pathlib\npathlib.Path(p).write_text(s)\nPY" }), res(4, "b", ""),
    say(5, "All tests pass."),
  ]);
  assert.equal(verdict(s.claims), "unknown");
});

test("2. rereading an old log after an edit is not a new run", async () => {
  const s = await claudeSession([
    tool(1, "a", "Bash", { command: "pytest > pytest.log" }), res(2, "a", ""),
    tool(3, "e", "Edit", { file_path: "/repo/src/x.py", old_string: "a", new_string: "b" }), res(4, "e", "The file /repo/src/x.py has been updated successfully."),
    tool(5, "b", "Bash", { command: "tail -n 5 pytest.log" }), res(6, "b", "10 passed in 0.2s"),
    say(7, "All tests pass."),
  ]);
  assert.equal(verdict(s.claims), "stale");
});

test("2b. reading the log of a run started after the last edit backs the claim", async () => {
  const s = await claudeSession([
    tool(1, "e", "Edit", { file_path: "/repo/src/x.py", old_string: "a", new_string: "b" }), res(2, "e", "The file /repo/src/x.py has been updated successfully."),
    tool(3, "a", "Bash", { command: "pytest > /tmp/run1.log; echo done" }), res(4, "a", "done"),
    tool(5, "b", "Bash", { command: "tail -n 3 /tmp/run1.log" }), res(6, "b", "10 passed in 0.2s"),
    say(7, "All tests pass."),
  ]);
  assert.equal(verdict(s.claims), "backed");
});

test("3. a result that arrives after the claim doesn't back it", async () => {
  const s = await codexSession([
    item(1, { type: "function_call", name: "exec_command", call_id: "run", arguments: JSON.stringify({ cmd: "npm test" }) }),
    item(2, { type: "function_call_output", call_id: "run", output: JSON.stringify({ session_id: 22, output: "still running" }) }),
    csay(3),
    item(4, { type: "function_call", name: "write_stdin", call_id: "poll", arguments: JSON.stringify({ session_id: 22 }) }),
    item(5, { type: "function_call_output", call_id: "poll", output: JSON.stringify({ exit_code: 0, output: "1 passed in 1.0s" }) }),
  ]);
  assert.equal(verdict(s.claims), "unknown");
  assert.equal(s.testRuns, 1);
});

test("4. each command in a Codex cell gets only its own output", async () => {
  const s = await codexSession([
    item(1, { type: "custom_tool_call", name: "exec", call_id: "c", input: 'text(await tools.exec_command({cmd:"pytest -q"})); text(await tools.exec_command({cmd:"git show HEAD:fixtures/pytest-failure.txt"}));' }),
    item(2, { type: "custom_tool_call_output", call_id: "c", output: [{ type: "text", text: JSON.stringify({ exit_code: 0, output: "1 passed in 0.1s" }) }, { type: "text", text: JSON.stringify({ exit_code: 0, output: "1 failed in 0.1s" }) }] }),
    csay(3),
  ]);
  assert.equal(verdict(s.claims), "backed");
});

test("4b. output that can't be mapped to commands stays unknown", async () => {
  const s = await codexSession([
    item(1, { type: "custom_tool_call", name: "exec", call_id: "c", input: 'await Promise.all([tools.exec_command({cmd:"pytest -q"}), tools.exec_command({cmd:"cat old-run.log"})]);' }),
    item(2, { type: "custom_tool_call_output", call_id: "c", output: [{ type: "text", text: "Script completed\n1 failed in 0.1s" }] }),
    csay(3),
  ]);
  assert.equal(verdict(s.claims), "unknown");
});

test("4c. unmatched outputs that all exited 0 still give each command a status, not output", async () => {
  const s = await codexSession([
    item(1, { type: "custom_tool_call", name: "exec", call_id: "c", input: 'await Promise.all([tools.exec_command({cmd:"npm test"}), tools.exec_command({cmd:"git show HEAD:old-failure.txt"})].map((p) => p.then((r) => text(JSON.stringify(r)))));' }),
    item(2, { type: "custom_tool_call_output", call_id: "c", output: [{ type: "text", text: JSON.stringify({ exit_code: 0, output: "1 failed in 0.1s" }) }, { type: "text", text: JSON.stringify({ exit_code: 0, output: "ℹ pass 3" }) }] }),
    csay(3),
  ]);
  assert.equal(verdict(s.claims), "backed");
});

test("4d. plain Promise.all keeps input order, so chunks map to commands", async () => {
  const s = await codexSession([
    item(1, { type: "custom_tool_call", name: "exec", call_id: "c", input: 'const rs = await Promise.all([tools.exec_command({cmd:"npm test"}), tools.exec_command({cmd:"ruff check ."})]); for (const r of rs) text(JSON.stringify(r));' }),
    item(2, { type: "custom_tool_call_output", call_id: "c", output: [{ type: "text", text: JSON.stringify({ exit_code: 1, output: "ℹ pass 2\nℹ fail 1" }) }, { type: "text", text: JSON.stringify({ exit_code: 0, output: "All checks passed!" }) }] }),
    csay(3),
  ]);
  assert.equal(verdict(s.claims), "failed");
});

test("4e. indexed Promise.allSettled sections map to their commands", async () => {
  const s = await codexSession([
    item(1, { type: "custom_tool_call", name: "exec", call_id: "c", input: 'const r = await Promise.allSettled([tools.exec_command({cmd:"npm test"}), tools.exec_command({cmd:"git diff --stat"})]); r.forEach((x, i) => text(`${i}: ${x.value?.output}`));' }),
    item(2, { type: "custom_tool_call_output", call_id: "c", output: [{ type: "text", text: "Script completed\nWall time 0.3 seconds\nOutput:\n\n0: \n> node --test\nℹ pass 1\nℹ fail 0\n\n1: dist/app.js | 40 +++\n 1 file changed" }] }),
    csay(3),
  ]);
  assert.equal(verdict(s.claims), "backed");
});

test("4f. wrapped allSettled results map by their index", async () => {
  const wrap = (i, v) => JSON.stringify({ i, result: { status: "fulfilled", value: v } });
  const s = await codexSession([
    item(1, { type: "custom_tool_call", name: "exec", call_id: "c", input: 'const r = await Promise.allSettled([tools.exec_command({cmd:"npm test"}), tools.exec_command({cmd:"cat old.log"})]); r.forEach((result, i) => text(JSON.stringify({ i, result })));' }),
    item(2, { type: "custom_tool_call_output", call_id: "c", output: [{ type: "text", text: "Output:\n" + wrap(0, { exit_code: 0, output: "ℹ pass 4\nℹ fail 0" }) + "\n" + wrap(1, { exit_code: 0, output: "2 failed in 1.0s" }) }] }),
    csay(3),
  ]);
  assert.equal(verdict(s.claims), "backed");
});

test("5. test then patch in one Codex cell is stale; patch then test is backed", async () => {
  const cell = (input) => [
    item(1, { type: "custom_tool_call", name: "exec", call_id: "c", input }),
    item(2, { type: "custom_tool_call_output", call_id: "c", output: [{ type: "text", text: JSON.stringify({ exit_code: 0, output: "1 passed in 0.1s" }) }, { type: "text", text: "Success. Updated src/x.js" }] }),
    csay(3),
  ];
  const testFirst = await codexSession(cell(`text(await tools.exec_command({cmd:"npm test"})); text(await tools.apply_patch(${JSON.stringify(patch)}));`));
  assert.equal(verdict(testFirst.claims), "stale");
  const patchFirst = await codexSession(cell(`text(await tools.apply_patch(${JSON.stringify(patch)})); text(await tools.exec_command({cmd:"npm test"}));`));
  assert.equal(verdict(patchFirst.claims), "backed");
});

test("6. an exit status that belongs to another command isn't a test result", () => {
  assert.equal(testOutcome({ cmd: "npm test; true", exitCode: 0, output: "npm error Missing script: test" }), null);
  assert.equal(testOutcome({ cmd: "make build && pytest", exitCode: 2, output: "" }), null);
  assert.equal(testOutcome({ cmd: "cd app && pytest", exitCode: 1, output: "" }), "fail");
  assert.equal(testOutcome({ cmd: "ulimit -n 4096; pytest", exitCode: 0, output: "" }), "pass");
  assert.equal(testOutcome({ cmd: "pytest && git diff --check", exitCode: 0, output: "" }), "pass");
  // the test runs last after `;` or a newline: its status is the script's
  assert.equal(testOutcome({ cmd: "python3 -m py_compile src/a.py\npython3 -m unittest -v tests.test_a", exitCode: 0, output: "" }), "pass");
  assert.equal(testOutcome({ cmd: "python3 -m py_compile src/a.py; pytest -q", exitCode: 1, output: "" }), "fail");
  assert.equal(testOutcome({ cmd: "set -e\nmake build\npytest -q", exitCode: 2, output: "" }), null);
});

test("7. reinstalling and uninstalling the version-pinned npx hook", () => {
  const dir = tmp();
  const opts = { cwd: dir, agents: ["claude"], command: "npx -y agent-polygraph@0.1.0 guard" };
  install(opts);
  assert.equal(install(opts)[0].changed, false);
  // an upgrade replaces the old pinned version instead of adding a second hook
  const upgraded = install({ ...opts, command: "npx -y agent-polygraph@0.2.0 guard" })[0];
  assert.equal(upgraded.changed, true);
  const file = path.join(dir, ".claude", "settings.json");
  const hooks = JSON.parse(fs.readFileSync(file, "utf8")).hooks.Stop.flatMap((g) => g.hooks);
  assert.deepEqual(hooks.map((h) => h.command), ["npx -y agent-polygraph@0.2.0 guard"]);
  assert.equal(uninstall(opts)[0].changed, true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).hooks, undefined);
});

test("8. the guard judges the final message, not an earlier claim it corrected", async () => {
  const file = writeJsonl([
    { type: "user", timestamp: at(0), cwd, origin: { kind: "human" }, message: { content: "fix x" } },
    tool(1, "e", "Edit", { file_path: "/repo/src/x.js", old_string: "old", new_string: "new" }), res(2, "e", "The file /repo/src/x.js has been updated successfully."),
    say(3, "All tests pass."),
    say(4, "Correction: I did not run the tests. The changes are unverified."),
  ]);
  assert.equal(await runHook(JSON.stringify({ transcript_path: file, last_assistant_message: "Correction: I did not run the tests. The changes are unverified." })), null);
  assert.equal(await runHook(JSON.stringify({ transcript_path: file })), null);
});

test("9. a failed edit is not a change", async () => {
  const s = await claudeSession([
    tool(1, "a", "Bash", { command: "npm test" }), res(2, "a", "ℹ pass 3\nℹ fail 0"),
    tool(3, "e", "Edit", { file_path: "/repo/src/x.js", old_string: "old", new_string: "new" }), res(4, "e", "String to replace not found.", true),
    say(5, "All tests pass."),
  ]);
  assert.equal(verdict(s.claims), "backed");
  assert.equal(s.edits, 0);
});

test("9b. a Codex patch that failed to apply is not a change", async () => {
  const s = await codexSession([
    item(1, { type: "custom_tool_call", name: "exec", call_id: "t", input: 'text(await tools.exec_command({cmd:"npm test"}));' }),
    item(2, { type: "custom_tool_call_output", call_id: "t", output: [{ type: "text", text: JSON.stringify({ exit_code: 0, output: "1 passed in 0.1s" }) }] }),
    item(3, { type: "custom_tool_call", name: "apply_patch", call_id: "p", input: patch }),
    item(4, { type: "custom_tool_call_output", call_id: "p", output: [{ type: "text", text: "apply_patch verification failed: context did not match" }] }),
    csay(5),
  ]);
  assert.equal(verdict(s.claims), "backed");
});

test("10. overwriting an existing test with Write is not creating it", async () => {
  const s = await claudeSession([
    tool(1, "a", "Bash", { command: "pytest" }), res(2, "a", "1 failed in 0.1s", true),
    tool(3, "w", "Write", { file_path: "/repo/tests/test_x.py", content: "def test_x():\n    assert True\n" }), res(4, "w", "The file /repo/tests/test_x.py has been updated successfully."),
    tool(5, "b", "Bash", { command: "pytest" }), res(6, "b", "1 passed in 0.1s"),
  ]);
  assert.ok(s.findings.some((f) => f.type === "test-only-fix"));
});

test("a log is matched by its file name, not by a substring of another command", async () => {
  const s = await claudeSession([
    tool(1, "a", "Bash", { command: "pytest > /tmp/x" }), res(2, "a", "Exit code 1", true),
    tool(3, "b", "Bash", { command: "cat fixtures/expected.txt" }), res(4, "b", "12 passed in 0.3s"),
    say(5, "All tests pass."),
  ]);
  // the fixture's "12 passed" belongs to no run: the failure stands
  assert.equal(verdict(s.claims), "failed");
});

test("the guard handles very long sessions", async () => {
  const recs = [{ type: "user", timestamp: at(0), cwd, origin: { kind: "human" }, message: { content: "go" } }];
  for (let k = 0; k < 150000; k++) recs.push(say(1, "Working."));
  const f = writeJsonl(recs);
  assert.equal(await runHook(JSON.stringify({ transcript_path: f, last_assistant_message: "Done, nothing to test." })), null);
  // and it still judges the final message
  const out = await runHook(JSON.stringify({ transcript_path: f, last_assistant_message: "All tests pass." }));
  assert.equal(out, null); // no code work in the session: nothing to judge
});

test("a definite 'no test run' verdict is not also counted as unclear", async () => {
  const s = await claudeSession([
    tool(1, "e", "Edit", { file_path: "/repo/src/x.js", old_string: "a", new_string: "b" }), res(2, "e", "The file /repo/src/x.js has been updated successfully."),
    say(3, "All tests pass."),
  ]);
  assert.equal(verdict(s.claims), "no-run");
  assert.deepEqual(s.unclear, {});
});

test("custom test runners: scripts under tests/, programs named like tests, printed summaries", async () => {
  const run = (command, out) => [tool(1, "a", "Bash", { command }), res(2, "a", out), say(3, "All tests pass.")];
  const editFirst = [tool(0, "e", "Edit", { file_path: "/repo/src/x.c", old_string: "a", new_string: "b" }), res(0, "e", "The file /repo/src/x.c has been updated successfully.")];
  for (const [command, out] of [
    ["powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/runner/run.ps1", "48/48 passed"],
    ["./build/frost_smoke.exe 2>&1", ""],
    ["cd /d/proj && ./build/frost_subsystems.exe", "135 passed, 0 failed"],
  ]) {
    const s = await claudeSession([...editFirst, ...run(command, out)]);
    assert.equal(verdict(s.claims), "backed", command);
  }
  // printing an old summary is not a run
  const s = await claudeSession([...editFirst, ...run("cat build/last-run.txt", "135 passed, 0 failed")]);
  assert.equal(verdict(s.claims), "no-run");
});

test("Claude Code on Windows: PowerShell commands and Windows paths", async () => {
  const win = (recs) => recs.map((r) => ({ ...r, cwd: "D:\\Epilog" }));
  const ps = (s0, id, command) => ({ ...tool(s0, id, "PowerShell", { command }), cwd: "D:\\Epilog" });
  const edit = (s0, id, file) => [
    tool(s0, id, "Edit", { file_path: file, old_string: "a", new_string: "b" }),
    res(s0, id, `The file ${file} has been updated successfully.`),
  ];
  // edit, then tests through PowerShell: backed
  let s = await claudeSession(win([...edit(1, "e", "d:\\Epilog\\engine\\solver.cpp"), ps(2, "t", "Set-Location D:\\Epilog; make test 2>&1"), res(3, "t", "144 passed, 0 failed"), say(4, "All tests pass.")]));
  assert.equal(verdict(s.claims), "backed");
  // tests, then an edit in the same checkout (drive letter case differs): stale
  s = await claudeSession(win([ps(1, "t", "cd d:\\Epilog; make test"), res(2, "t", "144 passed, 0 failed"), ...edit(3, "e", "D:\\Epilog\\tests\\test_atoms.cpp"), say(4, "All tests pass.")]));
  assert.equal(verdict(s.claims), "stale");
  assert.equal(s.findings.find((f) => f.type === "claim").detail.editedAfter, "tests/test_atoms.cpp");
});

test("npm run with flags before the script name is a test run", async () => {
  const s = await claudeSession([
    tool(0, "e", "Edit", { file_path: "/repo/src/x.js", old_string: "a", new_string: "b" }), res(0, "e", "The file /repo/src/x.js has been updated successfully."),
    tool(1, "a", "Bash", { command: "npm run -s test 2>&1 | grep -E '# (pass|fail)'" }), res(2, "a", "# pass 46\n# fail 0"),
    say(3, "46/46 web tests pass."),
  ]);
  assert.equal(verdict(s.claims), "backed");
});

test("Claude Code's shell keeps its directory between commands", async () => {
  const at0 = (recs) => recs.map((r) => ({ ...r, cwd: "/proj" }));
  // `cd web` once, then the web tests; an edit in android/ doesn't make them stale
  let s = await claudeSession(at0([
    tool(1, "c", "Bash", { command: "cd web" }), res(2, "c", ""),
    tool(3, "t", "Bash", { command: "npm run -s test" }), res(4, "t", "# pass 46\n# fail 0"),
    tool(5, "e", "Edit", { file_path: "/proj/android/MainActivity.kt", old_string: "a", new_string: "b" }), res(6, "e", "The file /proj/android/MainActivity.kt has been updated successfully."),
    say(7, "46/46 web tests pass."),
  ]));
  assert.equal(verdict(s.claims), "backed");
  // an edit inside web/ does
  s = await claudeSession(at0([
    tool(1, "c", "Bash", { command: "cd web" }), res(2, "c", ""),
    tool(3, "t", "Bash", { command: "npm run -s test" }), res(4, "t", "# pass 46\n# fail 0"),
    tool(5, "e", "Edit", { file_path: "/proj/web/src/App.svelte", old_string: "a", new_string: "b" }), res(6, "e", "The file /proj/web/src/App.svelte has been updated successfully."),
    say(7, "46/46 web tests pass."),
  ]));
  assert.equal(verdict(s.claims), "stale");
  // a cd inside an ssh command, or a reset reported by Claude Code, doesn't leave us elsewhere
  s = await claudeSession(at0([
    tool(1, "r", "Bash", { command: "ssh vm 'cd /srv/app && uptime'" }), res(2, "r", "up 3 days"),
    tool(3, "t", "Bash", { command: "npm test" }), res(4, "t", "# pass 3\n# fail 0"),
    tool(5, "e", "Edit", { file_path: "/proj/src/x.js", old_string: "a", new_string: "b" }), res(6, "e", "The file /proj/src/x.js has been updated successfully."),
    say(7, "All tests pass."),
  ]));
  assert.equal(verdict(s.claims), "stale");
});

test("throwaway programs written through the shell don't make tests stale", async () => {
  const s = await claudeSession([
    tool(1, "t", "Bash", { command: "make test" }), res(2, "t", "17 passed, 0 failed"),
    tool(3, "w", "Bash", { command: "cat > check3.cpp << 'DONE'\nint main(){}\nDONE\nclang++ check3.cpp && ./a.out" }), res(4, "w", ""),
    tool(5, "x", "Bash", { command: "cat > src/checkout.cpp << 'DONE'\nint f(){}\nDONE" }), res(6, "x", ""),
    say(7, "All tests pass."),
  ]);
  // check3.cpp is scratch; src/checkout.cpp is real code, so the claim is stale
  assert.equal(verdict(s.claims), "stale");
  assert.equal(s.findings.find((f) => f.type === "claim").detail.editedAfter, "src/checkout.cpp");
});

test("a shell-written file that looks like a debugging aid makes the claim unjudgeable", async () => {
  const s = await claudeSession([
    tool(1, "t", "Bash", { command: "make test" }), res(2, "t", "17 passed, 0 failed"),
    tool(3, "w", "Bash", { command: "cat > m0_debug2.cpp << 'X'\nint main(){}\nX" }), res(4, "w", ""),
    say(5, "All tests pass."),
  ]);
  assert.equal(verdict(s.claims), "unknown");
});

test("a new debug program created with Write is not the code under test; editing one is", async () => {
  const write = (file, text) => [tool(3, "w", "Write", { file_path: file, content: "int main(){}" }), res(4, "w", text)];
  let s = await claudeSession([tool(1, "t", "Bash", { command: "make test" }), res(2, "t", "17 passed, 0 failed"), ...write("/repo/m0_debug2.cpp", "File created successfully at: /repo/m0_debug2.cpp"), say(5, "All tests pass.")]);
  assert.equal(verdict(s.claims), "unknown");
  s = await claudeSession([tool(1, "t", "Bash", { command: "make test" }), res(2, "t", "17 passed, 0 failed"), ...write("/repo/check3.cpp", "File created successfully at: /repo/check3.cpp"), say(5, "All tests pass.")]);
  assert.equal(verdict(s.claims), "backed");
  s = await claudeSession([tool(1, "t", "Bash", { command: "make test" }), res(2, "t", "17 passed, 0 failed"), ...write("/repo/src/debug_log.cpp", "The file /repo/src/debug_log.cpp has been updated successfully."), say(5, "All tests pass.")]);
  assert.equal(verdict(s.claims), "stale");
});

test("tests run by a hook or by you with `!` count as evidence", async () => {
  const edit = [tool(1, "e", "Edit", { file_path: "/repo/src/x.js", old_string: "a", new_string: "b" }), res(2, "e", "The file /repo/src/x.js has been updated successfully.")];
  const hook = { type: "attachment", timestamp: at(3), cwd, attachment: { type: "hook_success", hookEvent: "PostToolUse", command: "npm test", exitCode: 0, stdout: "ℹ pass 12\nℹ fail 0", stderr: "", durationMs: 900 } };
  let s = await claudeSession([...edit, hook, say(4, "All tests pass.")]);
  assert.equal(verdict(s.claims), "backed");
  const mine = [
    { type: "user", timestamp: at(3), cwd, message: { content: "<bash-input>pytest -q</bash-input>" } },
    { type: "user", timestamp: at(4), cwd, message: { content: "<bash-stdout>12 passed in 0.4s</bash-stdout><bash-stderr></bash-stderr>" } },
  ];
  s = await claudeSession([...edit, ...mine, say(5, "All tests pass.")]);
  assert.equal(verdict(s.claims), "backed");
});

test("a file in an unknown log format is reported, not silently dropped", async () => {
  const { scan } = await import("../src/scan.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polygraph-fmt-"));
  fs.mkdirSync(path.join(root, "proj"));
  fs.writeFileSync(path.join(root, "proj", "s.jsonl"), Array.from({ length: 8 }, (_, k) => JSON.stringify({ kind: "message", role: "user", n: k })).join("\n"));
  const ss = await scan({ agents: ["claude"], roots: { claude: root } });
  assert.equal(ss.length, 0);
  assert.equal(ss.unrecognized.length, 1);
});

test("versions newer than tested are flagged", async () => {
  const { versionRange } = await import("../src/report/format.js");
  assert.deepEqual(versionRange("claude", ["2.1.300", "2.1.220"]), { text: "2.1.220–2.1.300", newer: false });
  assert.equal(versionRange("codex", ["0.200.1"]).newer, true);
});

test("a claim about a subset is judged against the run that reported it", async () => {
  // focused run passes 31, then a broad run fails; "31/31 focused tests pass" is backed
  let s = await claudeSession([
    tool(1, "a", "Bash", { command: "pytest -q tests/vm" }), res(2, "a", "31 passed in 4.0s"),
    tool(3, "b", "Bash", { command: "pytest -q" }), res(4, "b", "Exit code 1\n3 failed, 1200 passed in 90s", true),
    say(5, "31/31 focused VM tests pass."),
  ]);
  assert.equal(verdict(s.claims), "backed");
  // "the full suite passes" names no subset: judged against the latest (failing) run
  s = await claudeSession([
    tool(1, "a", "Bash", { command: "pytest -q tests/vm" }), res(2, "a", "31 passed in 4.0s"),
    tool(3, "b", "Bash", { command: "pytest -q" }), res(4, "b", "Exit code 1\n3 failed, 1200 passed in 90s", true),
    say(5, "The full suite passes."),
  ]);
  assert.equal(verdict(s.claims), "failed");
  // a claim naming a test file uses a run of that file, and is stale if code changed after it
  s = await claudeSession([
    tool(1, "a", "Bash", { command: "pytest -q tests/test_api.py" }), res(2, "a", "8 passed in 1.0s"),
    tool(3, "e", "Edit", { file_path: "/repo/src/api.py", old_string: "a", new_string: "b" }), res(4, "e", "The file /repo/src/api.py has been updated successfully."),
    tool(5, "b", "Bash", { command: "pytest -q tests/test_db.py" }), res(6, "b", "5 passed in 1.0s"),
    say(7, "test_api.py passes."),
  ]);
  assert.equal(verdict(s.claims), "stale");
});

test("variables assigned in the same command are expanded before resolving writes", async () => {
  const s = await claudeSession([
    tool(1, "t", "Bash", { command: "npm test" }), res(2, "t", "ℹ pass 3\nℹ fail 0"),
    tool(3, "w", "Bash", { command: "D=/repo/src && sed -i 's/a/b/' $D/server.js" }), res(4, "w", ""),
    say(5, "All tests pass."),
  ]);
  assert.equal(verdict(s.claims), "stale");
  assert.equal(s.findings.find((f) => f.type === "claim").detail.editedAfter, "src/server.js");
});

test("Codex cells: labelled RESULT sections and several commands still running", async () => {
  let s = await codexSession([
    item(1, { type: "custom_tool_call", name: "exec", call_id: "c", input: 'const rs = await Promise.all([tools.exec_command({cmd:"python3 -m unittest tests.test_a"}), tools.exec_command({cmd:"cat notes.txt"})]); rs.forEach((r, i) => text(`=== RESULT ${i + 1} exit=${r.exit_code} ===\\n${r.output}`));' }),
    item(2, { type: "custom_tool_call_output", call_id: "c", output: [{ type: "text", text: "Output:\n=== RESULT 1 exit=0 ===\n....\nRan 4 tests in 0.4s\n\nOK\n=== RESULT 2 exit=0 ===\n2 failed in 1.0s (old notes)" }] }),
    csay(3),
  ]);
  assert.equal(verdict(s.claims), "backed");
  s = await codexSession([
    item(1, { type: "custom_tool_call", name: "exec", call_id: "c", input: 'text(await tools.exec_command({cmd:"make build"})); text(await tools.exec_command({cmd:"pytest -q"}));' }),
    item(2, { type: "custom_tool_call_output", call_id: "c", output: [{ type: "text", text: JSON.stringify({ exit_code: 0, output: "built" }) }, { type: "text", text: JSON.stringify({ session_id: 41, output: "....." }) }] }),
    item(3, { type: "function_call", name: "write_stdin", call_id: "p", arguments: JSON.stringify({ session_id: 41 }) }),
    item(4, { type: "function_call_output", call_id: "p", output: JSON.stringify({ exit_code: 0, output: "5 passed in 9.0s" }) }),
    csay(5),
  ]);
  assert.equal(verdict(s.claims), "backed");
});

test("Codex CommandExecution records are ground truth for each command", async () => {
  const done = (t, cmd, exit_code, aggregated_output) => ({ timestamp: at(t), type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", command: ["/bin/bash", "-lc", cmd], cwd: "file:///repo", status: "completed", exit_code, aggregated_output, duration: { secs: 2, nanos: 0 } } } });
  // the cell's printed output was cut off; the record has the summary
  let s = await codexSession([
    item(1, { type: "custom_tool_call", name: "exec", call_id: "c", input: 'text(await tools.exec_command({cmd:"pytest -q"}));' }),
    done(2, "pytest -q", 0, "........\n1226 passed in 42.4s"),
    item(3, { type: "custom_tool_call_output", call_id: "c", output: [{ type: "text", text: "Warning: truncated output\n........" }] }),
    csay(4),
  ]);
  assert.equal(verdict(s.claims), "backed");
  // still running when the cell returned; the record arrives later with a failure
  s = await codexSession([
    item(1, { type: "custom_tool_call", name: "exec", call_id: "c", input: 'text(await tools.exec_command({cmd:"pytest -q"}));' }),
    item(2, { type: "custom_tool_call_output", call_id: "c", output: [{ type: "text", text: "Script running with cell ID 7" }] }),
    done(5, "pytest -q", 1, "3 failed, 1223 passed in 42.4s"),
    csay(6),
  ]);
  assert.equal(verdict(s.claims), "failed");
});

test("runner output you paste into the chat counts as evidence", async () => {
  const s = await claudeSession([
    tool(1, "e", "Edit", { file_path: "/repo/src/x.py", old_string: "a", new_string: "b" }), res(2, "e", "The file /repo/src/x.py has been updated successfully."),
    { type: "user", timestamp: at(3), cwd, origin: { kind: "human" }, message: { content: "ran it in my terminal:\n12 passed in 0.4s" } },
    say(4, "Great, all tests pass."),
  ]);
  assert.equal(verdict(s.claims), "backed");
});
