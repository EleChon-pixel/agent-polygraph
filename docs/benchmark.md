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

## What would establish a stronger claim?

A comparative, externally labeled study needs the **same frozen sessions or tasks** for all policies, labels independently reviewed by someone who did not write the verifier, and separate reporting of:
1. Precision, recall and false-interruption rate on backed, stale, failed, unresolved and claim-free turns.
2. Actual number of added tests, wall-clock latency, tool calls, tokens, and agent compliance after a stop.
3. Defects caught without passing-test claims (a strength of always-rerun).
4. Both Claude Code and Codex, including mixed shell/CI flows and platform-specific logs.

Until then, the defensible result is **lower potential verification overhead for claim-focused auditing**, *not* better correctness coverage than running tests at every stop.

## Recorder snapshot performance

`node scripts/bench-snapshot.mjs` runs three timed, content-hashing snapshots on generated Git worktrees with 100 and 1,000 untracked 1 KiB source files, reporting the median. It is a microbenchmark only: disk speed, real source sizes, other processes and agent startup overhead may differ considerably. The security bounds in `src/record.js` cap snapshots at 10,000 source paths, 8 MiB per file and 64 MiB hashed per snapshot; exceeding them causes an inconclusive snapshot, not a false receipt.
