# Policy-cost comparison (reproducible)

**Question:** Does a selective, evidence-reading claim guard request fewer unnecessary test reruns than a Stop hook that executes the project's test suite after each answered user turn?

Run either:

```sh
npm run benchmark:demo
node scripts/eval-public.mjs ./eval-data --examples 0
node scripts/benchmark.mjs --claude-dir ./eval-data/claude --codex-dir ./eval-data/codex
```

The demo is generated and must **not** be used as independent validation. The external evaluation draws from pinned public Claude Code sessions documented in [evaluation.md](evaluation.md); it does not contain independently verified Codex data. Benchmark output includes parsed sessions, answered user turns, intermediate assistant messages, claim classifications, and a policy-cost projection.

## Fair comparisons

- **Always rerun:** Assume a project-configured test command executes once per answered user turn. That would run a test suite even for turns without test claims. It can also identify breakage the agent never claimed away. It might be the best choice if tests are cheap.
- **Agent-polygraph guard:** Reads existing transcripts and asks the agent once to verify only *definitely unbacked* passing-test claims. It does not itself rerun tests or know whether a requested rerun happened. It intentionally leaves inconclusive evidence and unclaimed breakage alone.
- **Repeated reminder:** Asking the agent to double-check on every turn creates an additional model opportunity and may lead to tests being rerun, but its compliance rate and cost require a controlled experiment; no result is assumed here.

The benchmark reports **possible extra rerun requests** rather than measured additional test executions. A single user turn can have multiple stops, and a transcript may end without a stop; neither can be reconstructed exactly from these logs. Answered user turns approximate Stop-hook opportunities (intermediate assistant messages are not Stop events), and retrospective flagged claims are an upper bound on actual live Stop blocks. The resulting reduction is a *workload projection*, not a measured speedup, not independent proof of verdict accuracy, and not a universal win.

## Reproduced results (2026-10-31)

The [public-session benchmark workflow](https://github.com/EleChon-pixel/agent-polygraph/actions/runs/41247587810) downloaded the pinned datasets and completed successfully on an Ubuntu runner with Node 22. The retrospective parser found **29 sessions**, **323 user turns with an assistant response**, and **27 passing-test claims** (24 backed, 3 marked stale, zero unknown).

| Policy model | Hypothetical verification demand |
|---|---:|
| Rerun a test suite once per answered user turn | 323 additional executions |
| Claim-only guard | Up to 3 additional *verification requests* |
| Potential requests avoided | At least 320 / 323 (99.1%), **projected**, not observed |

This **supports a narrower, conditional claim**: in these session traces, claim-only checking *can avoid asking for tests on most turns*. It does **not** prove lower wall-clock latency (actual suite durations and agent responses were not compared), higher accuracy, or better defect coverage. A full rerun policy can catch failures that never appear in claims. A message in a transcript is not itself a Stop hook call; answered user turns are only a comparison model. The three stale verdicts were not all independently confirmed; see [evaluation.md](evaluation.md).

The same workflow ran a Linux source-snapshot microbenchmark on generated 1,048-byte source files (median of three reads): **9.43 ms for 100 files** and **37.06 ms for 1,000 files**. These measure only a snapshot invocation on that runner, not total Stop-hook overhead. Performance on large or different filesystems may vary significantly.

## Controlled Stop-hook replay (Claude Code and Codex)

Run `npm run benchmark:replay`. This executes the actual `runHook()` entry point against 25 labeled, deterministic transcript scenarios: 19 in Claude Code's format and 6 in Codex's format. The labels are authored tests, **not independent human judgments**. The comparator is a deliberately minimal hook that checks whether *any* test previously passed in the transcript, without considering a later edit or failed run.

| Classification | Agent-polygraph | Any-pass baseline |
|---|---:|---:|
| Correctly blocked unbacked claims | 14 / 14 | 7 / 14 |
| Missed unbacked claims | 0 | 7 |
| Incorrectly blocked backed/non-claim cases | 0 / 11 | 0 / 11 |
| Correctly allowed backed/non-claim cases | 11 / 11 | 11 / 11 |

The result was reproduced in the [four-version Node CI run](https://github.com/EleChon-pixel/agent-polygraph/actions/runs/41248127899) (Node.js 18, 20, 22, 24). The advantage is **test freshness**: a simple "some test passed" rule misses an edit after a passing run or a newer failing run. The tool also deliberately leaves scenarios without clear code work inconclusive.

These results demonstrate better *coverage on this constructed suite* than the minimal comparator, **not** 100% accuracy in the wild, not superiority over a real always-rerun test hook, and not superiority to specialized competitors. Since cases were designed with agent-polygraph's behavior in mind, they have strong selection bias. The retrospective public-data workload projection above is a separate experiment.

## What would establish a stronger claim?

A comparative, externally labeled study needs the **same frozen sessions or tasks** for all policies, labels independently reviewed by someone who did not write the verifier, and separate reporting of:
1. Precision, recall and false-interruption rate on backed, stale, failed, unresolved and claim-free turns.
2. Actual number of added tests, wall-clock latency, tool calls, tokens, and agent compliance after a stop.
3. Defects caught without passing-test claims (a strength of always-rerun).
4. Both Claude Code and Codex, including mixed shell/CI flows and platform-specific logs.

Until then, the defensible result is **lower potential verification overhead for claim-focused auditing**, *not* better correctness coverage than running tests at every stop.

## Recorder snapshot performance

`node scripts/bench-snapshot.mjs` runs three timed, content-hashing snapshots on generated Git worktrees with 100 and 1,000 untracked 1 KiB source files, reporting the median. It is a microbenchmark only: disk speed, real source sizes, other processes and agent startup overhead may differ considerably. The security bounds in `src/record.js` cap snapshots at 10,000 source paths, 8 MiB per file and 64 MiB hashed per snapshot; exceeding them causes an inconclusive snapshot, not a false receipt.
