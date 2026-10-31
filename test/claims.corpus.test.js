// A labelled corpus of agent sentences (paraphrased from real sessions, no project data).
// Keeps recall and precision honest when the claim patterns change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findTestClaim } from "../src/classify.js";

const CLAIMS = [
  "All tests pass.",
  "All 227 affected tests pass.",
  "Tests are green again (32 pass).",
  "The full suite now passes: 1,441 tests.",
  "Final regression result: 1,760 passed, 3 skipped, plus 111 subtests.",
  "The combined branch passes 2071 tests with clean lint.",
  "The shoe logic, server validation and avatar wear all pass (51 tests).",
  "I fixed the stale fixtures and added tests for the new behaviour, so all 35 pass.",
  "There are 75 automated tests, and they all pass.",
  "The runner now passes its smoke, hashing and ordering tests.",
  "All three repaired workflows now pass their focused tests.",
  "Checkpoint integrity now passes 13 focused tests.",
  "- Focused prompt tests: `12 passed`",
  "- **57 focused tests passed**, and the lint step passed too.",
  "The check-in feature is implemented and all 14 tests pass.",
  "The deployed endpoints responded and all **109 tests passed**.",
  "Both containers are healthy, and all five tests pass.",
  "The test suite is green.",
  "Local build and API tests pass.",
  "The expanded regression set passes: 521 tests, including permissions.",
  "12/12 tests pass.",
  "48/48 tests passing.",
  "test_api.py passes.",
  "cart.test.ts now passes.",
  "All three focused report tests passed.",
  "pytest: 48 passed, 0 failed.",
  "The fresh regression run passed: 1,695 tests, with 3 skips.",
  "The expanded set passes 521 tests, including stale-plan rejection.",
  "All six confirmed issues are fixed, and the full suite passes 3110 tests.",
  "Όλα τα τεστ περνούν.",
  "Η νέα suite πέρασε πλήρως: 447/447 tests.",
  "The checks passed: 75 tests, zero contrast failures in both themes.",
  "1,087 targeted tests passed across the initial run and a rerun.",
  "Todas las pruebas pasan.",
  "Alle Tests sind grün.",
  "Tous les tests passent.",
  "Todos os testes passam.",
  "Tutti i test passano.",
];

const NOT_CLAIMS = [
  "I'll run the tests to make sure they pass.",
  "Once the tests pass I will commit.",
  "Tests should pass now.",
  "3 tests pass but 2 fail.",
  "Do the tests pass?",
  "The tests don't pass yet.",
  "```\n12 passed in 0.4s\n```",
  "Agents often claim tests passed without running them.",
  'The report checks whether "tests pass" is backed by a fresh run.',
  "It's now running its final full test pass.",
  "When the tests pass I'll commit this.",
  "The readiness flag must stay false until the complete suite passes.",
  "| Smoke test | Pass |",
  "Pass the seed through and test that seeds change requests.",
  "Both tests fail without the fix and pass with it.",
  "The unit tests completed before the failures appeared.",
  "With localhost enabled the suite reached 1,240 passes but exposed three failures.",
  "Interactions between branches can break tests, so I'll run the full suite.",
  "Tests passed before the edit; I haven't rerun them.",
  "I’ll proceed with the deployment after the isolation checks and tests pass.",
  "I’m going to make sure every test passes first.",
  "Now tests against a fake upstream, checking that allowed calls pass through.",
  "Scan result: 8 companies scanned and 5 new ones passed the filters.",
  "The first regression pass is clean for 58 of 59 targeted tests.",
  "The targeted suite is mostly passing.",
  "All 35 affected unit tests pass in isolation.",
  "Two stale tests fail; the other 30 pass.",
  "The deck now reflects the result: a 1,503-test VM pass and exact restart recovery.",
  "The suite reached its final check with every preceding step passing.",
  "The latest recorded full regression run passed 1,409 tests.",
  "The checker passed everything on the pre-fix head: 5461 passed, 0 failed.",
  "The load test is still mixed: blind-dynamic passes so far.",
  "Web build, typecheck, and tests all passed on CI.",
  "v0.2.0 smoke test on the Pixel: PASS.",
  "The broad run passed 2,652 tests, but 25 local HTTP tests were blocked by the sandbox.",
  "The functional result is otherwise 1,496 passed.",
  "6/7 suites pass, 106 tests passing; only one is still locked.",
  "The function signature in the test: it passes the buffer by value.",
  "Οι δοκιμές δεν περνούν ακόμα.",
  "Las pruebas no pasan todavía.",
  "Die Tests sind nicht grün.",
];

test("recall: every labelled claim is found", () => {
  const missed = CLAIMS.filter((s) => !findTestClaim(s));
  assert.deepEqual(missed, []);
});

test("precision: no labelled non-claim is flagged", () => {
  const wrong = NOT_CLAIMS.filter((s) => findTestClaim(s));
  assert.deepEqual(wrong, []);
});
