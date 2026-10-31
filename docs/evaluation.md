# Evaluation on public sessions

Before this, every accuracy number for agent-polygraph came from my own logs. Here it runs on Claude Code sessions other people published, with every verdict checked by hand and every breakage listed.

## Data

| Dataset | License | Revision | Sessions used |
|---|---|---|---|
| [Trace Commons, agent-traces](https://huggingface.co/datasets/trace-commons/agent-traces) | CC-BY-4.0 | `112ebd4` | 28 Claude Code |
| [thomwolf/am-session-claude-code-1-c3cc0a](https://huggingface.co/datasets/thomwolf/am-session-claude-code-1-c3cc0a) | Apache-2.0 | `037d661` | 1 Claude Code |

Both publish raw, anonymized Claude Code transcripts from open-source work. Trace Commons collects them from public repositories, and each contributor anonymizes their own. Of the 29 sessions, 26 contain commands or edits. Most come from Windows machines and involve C, C++, Odin, PowerShell build scripts and a Svelte/Android app.

There is no public Codex data here. The Trace Commons Codex folder only held a placeholder at this revision, and I found no other raw Codex rollouts, so Codex results are still checked on my logs only.

## Method

1. Run agent-polygraph on the sessions.
2. Read each session around every flagged claim (no run, stale, failed) and every backed one: the commands, edits and test output between the last test and the claim.
3. Fix each wrong verdict at its cause, add a regression test, and run again.

I did the review myself, so it isn't independent, and the sample is small. Read the numbers as a sanity check on other people's workflows, not as a benchmark.

## Results

| | First run | After whitespace fix | After parser fixes | Final |
|---|---|---|---|---|
| Sessions parsed | 0 | 26 | 26 | 26 |
| Backed by a fresh passing run | – | 3 | 17 | 24 |
| No test run in the session | – | 9 | 0 | 0 |
| Code edited after the last run | – | 14 | 3 | 3 |
| Couldn't tell | – | 8 | 7 | 0 |
| Receipt rate | – | 12% | 85% | 89% |

The last column adds Gradle, Maven and JUnit-style results (all 7 "couldn't tell" were Gradle runs) and matches claims to the run they name by count or test file.

All 24 backed verdicts match the test output the agent saw before the claim: `Results: 48 passed`, `13/13 tests passed`, `All smoke tests PASSED`, `# fail 0`, and for Gradle `tests=80 failures=0 errors=0` against "All 80 tests pass".

Of the 3 stale verdicts, one is confirmed. Test and header files were rewritten with `sed -i` and the project was rebuilt, but the tests weren't rerun, and the agent reported "still 135 passed, 0 failed". The other two follow an edit to the project's verification program after its last run. They are probably real, but I couldn't confirm them.

## What broke

None of these showed up in my own logs.

1. Re-serialized transcripts were skipped entirely. The anonymizer wrote `"type": "user"` with a space, and the parser's prefilter expected `"type":"user"`. Both parsers now accept either.
2. PowerShell commands were ignored. Claude Code on Windows runs commands through a `PowerShell` tool, which hid 40% of the commands in this data. It's now handled like `Bash`, including `Set-Location`, `Set-Content`/`Out-File` and Windows paths (`d:\Epilog\src\x.cpp`, case-insensitive drive letters).
3. Custom test runners weren't recognized: scripts under `tests/` (`powershell -File tests/runner/run_tests.ps1`), programs named like tests (`./build/frost_smoke.exe`), test files passed to an interpreter, and `npm run -s test`. Any command that prints a test summary (`135 passed, 0 failed`, `48/48 passed`) now counts as a test run, unless it only prints saved text (`cat`, `git show`).
4. Claude Code's shell keeps its directory between commands. After `cd web`, a later `npm test` runs in `web/`, so an edit in `android/` doesn't make it stale. The analysis now follows the shell's directory until Claude Code reports a reset.
5. Throwaway programs counted as source edits. Obvious scratch files (`check3.cpp`, `tmp_x.py`) are now ignored, and new files that look like debugging aids (`m0_debug2.cpp`) make the claim "couldn't tell".
6. Claims about CI or a manual device test ("all passed on CI", "smoke test on the Pixel: PASS") were judged against local runs. They no longer count as claims about the local tests.
7. Partial results like "6/7 suites pass" were read as claims, and so was "passes X by value" in the programming sense.
8. A counting bug recorded an "unclear" reason for definite "no test run" verdicts.
9. Gradle, Maven and JUnit-style results weren't read: `BUILD SUCCESSFUL`/`BUILD FAILED` for Gradle test tasks only, `Tests run: 12, Failures: 0, Errors: 0`, and `tests=80 failures=0 errors=0`.

These fixes also helped on my own logs. "Couldn't tell" went from 65 to 25, mostly because Codex's per-command execution records are now read, and the receipt rate was 93%.

## Second pass on my logs

Narrowing the documented limits changed some verdicts on my logs. I checked each one against its session.

Unreadable Claude Code results went from 7 to 1. Three were background test runs whose output the agent read with `tail` in the shell, while only the Read tool was followed before. One was a command the auto-mode classifier refused, which counted as the latest test run although it never ran. One was a node:test summary joined onto one line (`ℹ pass 66 ℹ fail 0`). Claude Code's saved full outputs (`Full output saved to: ...`) are now read as well.

Three "code edited after the last run" flags were wrong, all because of how shell writes were read. One script only read `cross_protocol_world.py` and wrote its result to `/tmp`. Another listed `replay_generative_artifact_archive.py` to hash it. The third wrote `r3c.py` in a scratch folder (`cd /tmp/... && python3 - <<EOF ... open('r3c.py','w')`), but the file was placed in the repository because the command's last `cd` went there. Two other scripts write files that can't be named (an archive extraction, and files written from inside a test's text). Those claims are now "couldn't tell".

Checking "the full suite passes" against the latest full-size run added two flags. One is confirmed: a source file and a test were edited, only runs of 4 to 28 tests followed, and two minutes later the agent said "the full suite passed". The last full run in that checkout (3,228 tests) came before the edits. The other is likely: a script changed a test file while a 5,468-test run was in progress, and only runs of 17 and 23 tests followed before "the full suite green".

`--ci` found nothing usable in my logs. Every GitHub Actions run in those repositories ended in `startup_failure`, meaning GitHub never started it, and such runs count as neither passing nor failing.

The receipt rate on my logs is now 94% (Codex 94%, Claude Code 94%). The public sessions are unchanged at 89%, with the same 24 backed and 3 stale verdicts.

## Reproduce

```sh
node scripts/eval-public.mjs            # downloads into ./eval-data (git-ignored) and prints the report
node scripts/eval-public.mjs out --json # any agent-polygraph options after the folder
```

Some public transcript datasets warn that they may contain pasted credentials. Keep the downloads local. This repository has only paraphrased test cases, never transcript text.

## Credits

Trace Commons, *agent-traces* (CC-BY-4.0), and thomwolf, *am-session-claude-code-1-c3cc0a* (Apache-2.0), on Hugging Face.
