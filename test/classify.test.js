import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mayWriteFiles,
  isTestCommand,
  isFullSuite,
  isTestLogRead,
  testOutcome,
  findTestClaim,
  isTestPath,
  isCodePath,
  weakening,
  riskyIn,
  isCorrection,
} from "../src/classify.js";

test("recognises test runners", () => {
  for (const cmd of [
    "pytest -q",
    ".venv/bin/pytest tests/test_x.py",
    "PYTHONPATH=src python3 -m unittest discover",
    "npm test",
    "pnpm run test -- --watch=false",
    "npx vitest run",
    "go test ./...",
    "cargo test",
    "./gradlew :app:test",
    "cd web && yarn test",
    "pip install -e . && pytest",
    "node --test 'test/*.test.js'",
    "bun test",
    "ssh vm 'cd app && pytest -q'",
    "bash -lc 'ulimit -n 4096; pytest -q'",
    'timeout 600 "$V/python" -m pytest -q',
    'npm test 2>&1 | grep -E "pass|fail"',
    "python3 tests/evaluation/test_report.py",
    "cd app && python3 - <<'EOF'\nprint('it\\'s')\nEOF\ncat > t.txt <<'EOF'\nI'll\nEOF\nnpm test 2>&1 | grep -E \"pass|fail\"",
    "node test/api.test.js",
  ]) {
    assert.ok(isTestCommand(cmd), cmd);
  }
});

test("does not mistake other commands for test runs", () => {
  for (const cmd of [
    "tail -n 4 output/pytest-full.log",
    "cat jest.config.js",
    "pip install pytest",
    "grep -r pytest .",
    "pytest --version",
    'python3 -c "import pytest; print(pytest.__version__)"',
    `node hook.js <<< '{"last_assistant_message":"I ran npm test before the edit"}'`,
    'git commit -m "run pytest in CI"',
    "git diff tests/test_x.py",
    "python3 - <<'PY'\nimport subprocess\nsubprocess.run(['pytest'])\nPY",
  ]) {
    assert.ok(!isTestCommand(cmd), cmd);
  }
});

test("full suite vs focused runs", () => {
  assert.ok(isFullSuite("pytest -q"));
  assert.ok(isFullSuite("npm test"));
  assert.ok(!isFullSuite("pytest tests/test_api.py -q"));
  assert.ok(!isFullSuite("pytest -k retry"));
  assert.ok(!isFullSuite("go test ./pkg/..."));
  assert.ok(!isFullSuite("python -m unittest tests.unit.test_x"));
});

test("reads background test logs only when tailed", () => {
  assert.ok(isTestLogRead("tail -n 20 /tmp/pytest-run.log"));
  assert.ok(!isTestLogRead("tail -n 20 app.log"));
});

test("printed runner summary beats the exit code", () => {
  // git diff --check made the chain exit 2 after pytest passed
  assert.equal(
    testOutcome({ cmd: "pytest -q && git diff --check", exitCode: 2, output: "2299 passed, 3 skipped in 154.28s" }),
    "pass",
  );
  assert.equal(testOutcome({ cmd: "pytest | tail -5", exitCode: 0, output: "3 failed, 10 passed in 2.1s" }), "fail");
});

test("exit codes only count when they belong to the test command", () => {
  assert.equal(testOutcome({ cmd: "npm test", exitCode: 1, output: "" }), "fail");
  assert.equal(testOutcome({ cmd: "npm test", exitCode: 0, output: "" }), "pass");
  assert.equal(testOutcome({ cmd: "pytest && ruff check .", exitCode: 1, output: "" }), null);
  assert.equal(testOutcome({ cmd: "pytest | tail -3", exitCode: 0, output: "" }), null);
  assert.equal(testOutcome({ cmd: "pytest || true", exitCode: 0, output: "" }), null);
});

test("node --test summary", () => {
  assert.equal(testOutcome({ cmd: "npm test", exitCode: null, output: "ℹ tests 12\nℹ pass 12\nℹ fail 0" }), "pass");
  assert.equal(testOutcome({ cmd: "npm test", exitCode: null, output: "ℹ tests 12\nℹ pass 11\nℹ fail 1" }), "fail");
});

test("finds claims that tests pass", () => {
  for (const text of [
    "All tests pass.",
    "Done. The full suite now passes: 1,441 tests.",
    "Tests are passing and the build is clean.",
    "- Model/LLM tests: **62 passed**",
    "All 12 unit tests passed.",
    "The test suite is green.",
  ]) {
    assert.ok(findTestClaim(text), text);
  }
});

test("ignores plans, hedges, failures and quoted output", () => {
  for (const text of [
    "I'll run the tests to make sure they pass.",
    "Once the tests pass I will commit.",
    "Tests should pass now.",
    "3 tests pass but 2 fail.",
    "Do the tests pass?",
    "The tests don't pass yet.",
    "```\n12 passed in 0.4s\n```",
    "Agents often claim tests passed without running them.",
  ]) {
    assert.equal(findTestClaim(text), null, text);
  }
});

test("test and source paths", () => {
  assert.ok(isTestPath("tests/test_api.py"));
  assert.ok(isTestPath("src/foo.test.ts"));
  assert.ok(isTestPath("pkg/server_test.go"));
  assert.ok(!isTestPath("src/testing_utils_helpers.py"));
  assert.ok(isCodePath("src/app.py"));
  assert.ok(!isCodePath("README.md"));
  assert.ok(!isCodePath("output/report.json"));
  assert.ok(!isCodePath(".claude/worktrees/agent-1/src/app.py"));
  assert.ok(!isCodePath("nginx.conf"));
});

test("detects weakened tests", () => {
  assert.deepEqual(weakening(["    assert result == 3", "    assert len(x) == 2"], ["    assert result"]), ["removed 1 assertion"]);
  assert.deepEqual(weakening(["def test_retry():"], ["@pytest.mark.skip", "def test_retry():"]), ["added skip/xfail"]);
  assert.deepEqual(weakening(['  expect(x).toBe(3)'], ['  expect(true).toBe(true)']), ["added always-true assertion"]);
  assert.deepEqual(weakening(["it('a', () => {"], ["it.only('a', () => {"]), ["added .only"]);
  // a brand-new skipped test is not weakening an existing one
  assert.deepEqual(weakening([], ["@pytest.mark.skipif(no_docker, reason='docker')", "def test_new():", "    assert run()"]), []);
});

test("risky git commands at command position only", () => {
  assert.deepEqual(riskyIn("git commit --no-verify -m wip").map((r) => r.id), ["no-verify"]);
  assert.deepEqual(riskyIn("cd repo && git push --force origin main").map((r) => r.id), ["force-push"]);
  assert.deepEqual(riskyIn("git push --force-with-lease origin main"), []);
  assert.deepEqual(riskyIn("git reset --hard HEAD~1").map((r) => r.id), ["reset-hard"]);
  assert.deepEqual(riskyIn("echo 'git reset --hard'"), []);
  assert.deepEqual(riskyIn("python3 - <<'PY'\nos.system('git push -f')\nPY"), []);
});

test("corrections", () => {
  assert.ok(isCorrection("no, that's not what I asked"));
  assert.ok(isCorrection("I told you not to touch the migrations"));
  assert.ok(!isCorrection("now add a settings page"));
  assert.ok(!isCorrection("not bad! next, the API"));
});

test("commands that may write files", () => {
  assert.ok(mayWriteFiles("sed -i 's/a/b/' src/x.py"));
  assert.ok(mayWriteFiles("python3 - <<'EOF'\npathlib.Path('a.py').write_text(s)\nEOF"));
  assert.ok(mayWriteFiles("echo x > src/a.js"));
  assert.ok(!mayWriteFiles("pytest -q 2>&1"));
  assert.ok(!mayWriteFiles("npm test > /dev/null"));
  assert.ok(!mayWriteFiles("git status"));
});

test("maven, junit-style and gradle results", () => {
  assert.equal(testOutcome({ cmd: "mvn test", exitCode: null, output: "Tests run: 12, Failures: 0, Errors: 0, Skipped: 1" }), "pass");
  assert.equal(testOutcome({ cmd: "mvn test", exitCode: null, output: "Tests run: 12, Failures: 2, Errors: 0" }), "fail");
  assert.equal(testOutcome({ cmd: "./gradlew test | grep TOTAL", exitCode: 0, output: "TOTAL dal tests=80 failures=0 errors=0" }), "pass");
  assert.equal(testOutcome({ cmd: "./gradlew test --tests 'dal.*' 2>&1 | tail -5", exitCode: 0, output: "BUILD SUCCESSFUL in 21s" }), "pass");
  assert.equal(testOutcome({ cmd: "./gradlew test | tail -5", exitCode: 0, output: "There were failing tests. BUILD FAILED in 9s" }), "fail");
  // a plain build's BUILD SUCCESSFUL is not a test result
  assert.equal(testOutcome({ cmd: "./gradlew assembleDebug | tail -3", exitCode: 0, output: "BUILD SUCCESSFUL in 30s" }), null);
});
