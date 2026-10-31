# Executable verification-policy comparison

**Date:** 2026-10-31. **Source revision:** [CI run on main](https://github.com/EleChon-pixel/agent-polygraph/actions/runs/41248816241). Run `npm run benchmark:live`.

This is an *instrumented local test-project experiment*, **not** a real-agent A/B study or an independent field accuracy estimate. The harness creates temporary projects with real Node.js source files and passing/failing tests. It executes a **fresh full `node --test` run as an external oracle** after each scenario's final edit, independently of the verifier's verdict. It then replays agent transcripts constructed from test executions and asks each policy whether to run one additional *actual* test suite.

Three policies:
- **Always rerun:** execute the complete suite on every final response. This detects failures even when no passing claim is made.
- **Agent-polygraph guard:** invoke the actual `runHook()`, and for each `block` run the full suite once *in the harness*. Real agents are not invoked; compliance with a guard request is an untested assumption.
- **Any prior passing test:** a deliberately weak comparator that requests one full-suite test only if the agent explicitly claims tests pass but no earlier test passed in the transcript.

## Measured results on one Linux GitHub Actions runner (Node 22)

| Policy | Extra real test processes | Detected final failing suites | Missed failing suites | Test execution time | Guard decision time |
|---|---:|---:|---:|---:|---:|
| Always rerun | 12 | **7/7** | 0 | 1265.5 ms | 0 ms |
| Agent-polygraph | **5** | **3/7** | 4 | 497.2 ms | 74.7 ms |
| Any-prior-pass | 2 | 1/7 | 6 | 196.7 ms | Not instrumented |

Across these **12 intentionally selected scenarios**, agent-polygraph made seven fewer extra test invocations than always-rerun, or a **58% reduction in this scenario mix**. Its measured guard and test time was 571.9 ms versus 1265.5 ms in executed tests for always-rerun, but these totals are small, unpaired process timings and must **not** be presented as a general speedup.

**Key trade-off:** always-rerun detected all seven suites with failing final code, including defects that the agent never claimed were fixed. Agent-polygraph caught three of the seven because it only requests verification for unbacked passing-test claims. In particular it missed the unclaimed failures and a case with a narrower passing test despite a failing full suite. A fresh passing test does not itself establish code correctness.

**Interpretation:** agent-polygraph is a lower-invocation *claim-evidence guard*. It is not a replacement for real testing or a better defect detector than always rerunning the full suite. The replay's earlier [25 controlled scenarios](benchmark.md) compare claimed-test evidence freshness against a simple **any-pass hook**, not blanket testing.

The oracle executions that establish ground truth, and the tests used to populate the session transcript, are excluded from each policy's reported additional-test cost. Tool calls and token costs for autonomous agents are not measured. Cases were designed by the project authors and are not representative samples. Re-run across machines and with independently selected bugs before drawing population-level conclusions.

## Genuine blind, independent review

An evaluation with **independent human labels** cannot be produced by a program grading its own synthetic scenarios. To obtain those labels, a reviewer with access to the original public transcript corpus should receive a case manifest **without any model verdicts**:

```sh
node scripts/blind-review.mjs prepare --claude-dir /path/to/public/claude/projects --out private-review-cases.jsonl
```

Each record contains an opaque ID, relative transcript file, assistant event timestamp and ordinal, plus a blank `reviewLabel`. No model prediction is included. **Keep the file private** unless the source corpus has been inspected for confidential information. Opening the original raw transcript, the reviewer should assign one of `backed`, `stale`, `failed`, `no-run`, `unknown` or `not-claim`. The reviewer should decide whether tests ran *after* the last relevant edit, using actual outputs rather than exit status alone. They should mark ambiguous files as `unknown`, not guess.

After labels have been independently assigned, score them:

```sh
node scripts/blind-review.mjs score --claude-dir /path/to/public/claude/projects --labels reviewed.jsonl
```

The scorer reports the confusion matrix, missing IDs, and agreement. It cannot verify whether reviewers were independent or blinded. A rigorous study requires at least two reviewers, independent first-pass judgments, disagreements adjudicated without predictions, a pre-registered holdout, and no tuning on the held-out labels. **Until those human reviews exist, no claim of independent human-validated accuracy is justified.**

## External holdout attempts

The out-of-sample audit is separated from the core test CI and never uploads downloaded transcript contents. Its source is pinned in `.github/workflows/holdout-evaluation.yml`. It only admits oracle labels for narrow, unmistakable raw tool-use/result patterns; all ambiguous cases are excluded and must be counted. It is an **automated reference**, not a blind human review.

The first new source (`clem/ml-intern-sessions`, 92 transcripts) supplied zero eligible claims under these rules. `trace-commons/agent-traces` had **zero new sessions** beyond the already-evaluated revision `112ebd4`. A second independent Claude Code dataset (`crispwisp/wisp-claude-code-sessions`) likewise supplied zero exact qualifying claims among 100 sampled sessions. None of these zero-coverage attempts yields an accuracy score. The separate SWE-chat holdout evaluates an additional corpus and should be reported only with its actual usable labels and exclusions.
