# Utility review — 3 November 2026

Agent-polygraph is useful as a local audit aid and an optional, selective claim-evidence guard. Its useful signal is specific: a passing-test claim lacks a fresh relevant run, a newer run failed, or a test was weakened. It does not establish that code is correct, that a passing subset covers a project, or that an agent intentionally deceived anyone.

## Evidence from this review

The review of v0.3.1 reproduced four gaps: only the first claim sentence was evaluated, another checkout's run could supply evidence, category-only shell receipts inflated full-suite scope, and snapshots failed from repository subdirectories. v0.3.2 adds regression coverage for these paths, including the real Stop-hook entry point and both agents' subagent directories. The fixes make evidence handling more conservative; historical receipt rates are not a fresh accuracy estimate for this release.

Local release validation passed all 126 tests on Node 24, all 25 authored Stop-hook replay cases, and an isolated offline install of the packed 0.3.2 tarball with CLI, demo, `doctor` and `explain` smoke checks. Recorder state was isolated under a temporary directory, and agent-identification environment variables were removed for interactive-shell tests.

The controlled live-test benchmark was rerun during the review. In its 12 project-authored scenarios, seven final suites failed:

| Policy | Extra test executions | Failing final suites detected |
|---|---:|---:|
| Always rerun | 12 | 7/7 |
| Agent-polygraph | 5 | 3/7 |
| Any-prior-pass baseline | 2 | 1/7 |

These counts reproduce the previously documented trade-off: selective claim checking asks for fewer executions, while always rerunning detects more failures. They are not independent accuracy estimates, a population sample, or a measured improvement in real developer productivity. The [live evaluation](live-evaluation.md) describes the scenario construction and limitations. The replay benchmark and generated demo are regression and workload checks, respectively; neither supplies independent field validation.

## Where it earns its cost

- Retrospective audit: find specific claims whose recorded evidence deserves inspection, without changing agent behavior or running a suite.
- Slow or difficult suites: ask for verification on definite evidence gaps rather than on every turn.
- Evidence investigation: use `explain` and the original transcript to examine each result rather than relying only on a headline receipt rate.

For a cheap, reliable suite, an always-rerun Stop hook offers stronger failure coverage and simpler behavior. Keep ordinary tests and CI regardless of this tool. The guard abstains on ambiguity, permits only one corrective cycle and cannot prove the agent complied afterward.

The next useful validation is a separately selected set of real sessions, independently reviewed without seeing predictions. Measure incorrect blocks, missed unbacked claims, abstentions and actual extra suite executions. Existing public-data attempts produced no eligible independent holdout claims; reporting a holdout accuracy percentage would be unsupported. Until that evidence exists, position this tool as an inspectable audit aid rather than a general agent-reliability solution.

## Follow-up: stronger executable guard

Version 0.4.0 adds explicit `verify` and `strict` policies. `verify` closes the authored benchmark's four missed failures by executing the configured suite itself: the comparison now measures 12 extra executions and 7/7 failing suites detected, matching always-rerun coverage in that scenario set. It also retests repairs and reports unresolved budget exhaustion. Default caching is off; optional pass reuse trades execution cost for assumptions about ignored files and external state.

The original claim-only policy still has the limits described above and remains the compatibility default. The new policy adds bounded recovery and inspectable local verification receipts to an ordinary test-running hook; it is not a stronger defect oracle than the chosen tests. Independent transcript-classifier evaluation remains necessary.
