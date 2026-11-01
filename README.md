# agent-polygraph

[![test](https://github.com/EleChon-pixel/agent-polygraph/actions/workflows/test.yml/badge.svg)](https://github.com/EleChon-pixel/agent-polygraph/actions/workflows/test.yml)

Your coding agent said "all tests pass". Did a test pass after its last edit?

agent-polygraph is an audit of your past sessions. It reads the Claude Code and Codex session logs already on your machine and checks every "tests pass" claim against what ran: was there a passing test run after the agent's last code edit? It tells you how often your agents claimed something they hadn't verified, and shows the evidence for each case. No setup, no API key, nothing uploaded.

The audit and guard **read evidence; they do not execute tests**. A flagged claim is not proof the code is wrong: it means the available evidence does not support the claim at that point. If you want automatic test execution, use a separate test-running hook or CI.

```sh
npx agent-polygraph          # your own sessions
npx agent-polygraph --demo   # generated sample sessions
```

> **Beta / evidence limitations:** The parser has been evaluated on the author's own sessions and public Claude Code traces ([evaluation](docs/evaluation.md)). Controlled replays and real executed tests exist, but **independent, blinded human-validated accuracy has not been established**. If you report a wrong verdict, [open an issue](https://github.com/EleChon-pixel/agent-polygraph/issues/new/choose) with a *manually redacted* example—never upload an unreviewed raw session log.

Historical example from the author's sessions, July–October 2026 (not a representative benchmark or a current-user measurement):

```
agent-polygraph  32 working sessions · Jul 30 – Oct 31, 2026 · 11.0s

"Tests pass" claims  was there a passing run after the last code edit?
                                                    Codex  Claude Code          All
  Backed by a fresh passing run                       243           80          323
  No test run in the session                            0            0            0
  Code edited after the last run                       15            5           20
  Last run had failed                                   1            0            1
  Couldn't tell                                        15           17           32
  …test result unreadable                               3            1            4
  …unresolved file change after the run                11           14           25
  …other                                                1            2            3
  Receipt rate                                        94%          94%          94%

Test integrity  worth a second look, not proof of cheating
  Failing test "fixed" by editing only tests            0            0            0
  Edits that weakened an existing test                  3            1            4

Where the time went
  Test runs                                           851          976         1827
  Time spent in tests                                3.1h         8.7h          12h
  Full-suite runs                                     325          212          537
  ...
```

Under the tables it prints the latest examples: what the agent claimed, the last test command and its result, what was edited afterwards, and the session file, so you can check it yourself.

**What the benchmarks actually show:** agent-polygraph detects stale test claims more reliably than a *simple any-prior-pass rule* in [25 authored replay scenarios](docs/benchmark.md) (14/14 unbacked claims versus 7/14). In [12 instrumented projects using real test executions](docs/live-evaluation.md), its selective guard requested **5** additional tests and detected **3 of 7** failing final suites; rerunning the full suite every time required **12** additional tests and detected **all 7**. That is an efficiency-versus-coverage trade-off, **not** evidence that the guard improves overall defect detection. [Public-session workload projections](docs/benchmark.md) are separate from actual executed tests. The independently labeled human study is [still open](https://github.com/EleChon-pixel/agent-polygraph/issues/3).

**npm distribution:** Install the most recently *published* release with `npx --yes agent-polygraph --demo`, or pin an exact version (for example, `npx --yes agent-polygraph@0.2.0 --demo`). Check the actual public version with `npm view agent-polygraph version`: the GitHub `main` branch may be ahead of npm. Releases use GitHub OIDC trusted publishing and require maintainer 2FA approval before going live. The [automated public-install check](.github/workflows/verify-published-npm.yml) tests the download from npm, not just the repository source. See [Release instructions](docs/releasing.md).

## Explain a specific finding and check your setup

**Release note:** These commands are on GitHub `main` for the upcoming `0.3.0` release. The currently published npm `0.2.1` package does not include them. Until approval of `0.3.0`, use the repository's CLI as `node bin/polygraph.js explain` or `node bin/polygraph.js doctor`.

```sh
agent-polygraph explain --since 7d --limit 10  # show flagged or uncertain claims and their evidence
agent-polygraph explain --session abc123        # narrow by session ID prefix
agent-polygraph doctor                         # check installed hooks, logs and recorder settings
```

`explain` shows the claim, available last-test evidence, relevant subsequent edit and why a result is inconclusive. It is **read-only**, does not run tests, and may print private transcript excerpts, commands and paths. **Do not share its output without reviewing/redacting it.** Use `explain --ci` only if you want to ask GitHub for additional CI evidence.

`doctor` inspects local transcript discovery, a small sample of log formats, project/global hook settings, and recorder-directory permissions. It **never modifies settings or installs hooks**. An uninstalled direct hook is informational: the guard is optional and the Claude Code plugin may supply one separately. The default is offline; `doctor --ci` explicitly checks whether your GitHub CLI login is available, which may contact GitHub. This is a diagnostic, not a complete security audit.

## Share your numbers

```sh
npx agent-polygraph --html
```

This writes `polygraph.html`, a self-contained card with numbers only. Prompts, code, commands and file paths are left out.

<img src="docs/card.png" alt="agent-polygraph report card from my own sessions" width="600">

## Catch unbacked claims as they happen (optional)

```sh
npx agent-polygraph guard --install            # this project (.claude/settings.json, .codex/hooks.json)
npx agent-polygraph guard --install --global   # every project (~/.claude, ~/.codex)
npx agent-polygraph guard --uninstall
```

<img src="docs/guard.gif" alt="staged demo: guard stops a coding agent that claims tests pass after editing code, and the rerun fails" width="760">

`guard` is a Stop hook that runs the same checks on the live session. When the agent's final message says tests pass and the session doesn't back it up, the agent is sent back once:

> agent-polygraph: your final message says "All tests pass.", but you edited calc.js after the last test run. Run the relevant tests now and report the actual result. If they can't be run, say so instead of claiming they pass.

It blocks at most once per stop, looks only at the final message (so a claim the agent already corrected doesn't count), stays quiet when it can't tell, and never fails the turn because of its own errors. Install it globally (`npm i -g agent-polygraph`) so the hook doesn't start `npx` on every stop.

I tested it with both agents in a staged setup: they were told to edit code after a test run and then claim the tests pass (the GIF above is one of these runs). Both were stopped, reran `npm test` and reported the failure. Codex needs one extra step: it only runs hooks you have approved, and only reads a project's `.codex/` folder if you trust it. After installing, open `codex` in the project once, trust the folder and approve the hook.

### Do you need it?

Maybe not. Two simpler setups also work, and they are more thorough:

- A Stop hook that runs your test suite after every turn and gives the agent the result. This also catches breakage when the agent doesn't claim anything.
- A Stop hook that always asks the agent to double-check its results. When I tried this on small tasks where the agent had edited code after its last run, it reran the tests every time (6 of 6, Claude Haiku).

The trade-off is cost. Both fire on every stop, so every turn ends with a test run, and the second also adds a model turn, even when nothing changed or nothing was claimed. A test-running hook also has to know each project's test command and setup (a virtualenv, environment variables, a subfolder, a database). `guard` runs nothing: it reads the session in well under a second and only sends the agent back when the final message claims a pass that no run after the last edit supports (about 6% of claims in my logs), naming the edit that made the run stale.

If your suite runs in a few seconds and needs no setup, running it on every stop is the better choice. `guard` is for suites that are slow or fiddly to run, and for when you don't want an extra turn on every stop.

### As a Claude Code plugin

In Claude Code you can install the guard as a plugin instead:

```
/plugin install agent-polygraph --marketplace EleChon-pixel/agent-polygraph
```

On Claude Code older than 2.1.275, run `/plugin marketplace add EleChon-pixel/agent-polygraph` first, then `/plugin install agent-polygraph@agent-polygraph`.

The plugin runs the same Stop hook from its own copy, so nothing is downloaded when the agent stops, and it adds `/agent-polygraph:check` for the report (it takes the same options, for example `/agent-polygraph:check --since 30d`). If you also installed the hook with `guard --install`, the plugin's copy stays quiet so the agent isn't sent back twice. The plugin doesn't include `record`; turn that on separately if you want it.

## Evidence the logs don't have

Some things never show up in the logs: tests you ran yourself in another terminal, CI results, and files changed by a script that builds their names at run time. Two optional extras cover them.

```sh
npx agent-polygraph record --install           # this project; add --global for all of them
agent-polygraph record --install --shell       # your own terminals (requires a persistent install)
npx agent-polygraph --ci                       # GitHub Actions (online)
```

`record --install` adds a PostToolUse hook to Claude Code and Codex. After a test or a command that may write files, it records the test outcome and an HMAC-fingerprinted source snapshot. The snapshot reads bounded source files without writing copies to Git or storing raw contents. Ignored and non-source files are excluded; symlinks, unreadable files and exceeded size limits make a snapshot inconclusive. Comparing snapshots can resolve scripts that modify dynamically chosen source files. All new records stay in `~/.agent-polygraph` (or `$AGENT_POLYGRAPH_HOME`). Recording starts with new sessions.

`record --install --shell` adds one line to `~/.bashrc` and `~/.zshrc`. Supported test commands you run in interactive Bash/Zsh shells produce a minimal receipt: runner category, working directory, timestamps and exit code. Raw commands and output are never saved. To avoid unsafe shell redirection, the shell hook invokes the installed Node CLI, which validates and writes the receipt with private permissions and no-follow checks. **Use a persistent installation** (`npm i -g agent-polygraph` or a durable checkout) for shell integration; temporary `npx` cache paths may disappear. Shell mode recognizes a conservative subset of direct test commands. `record --uninstall --shell` removes its startup line.

`--ci` goes online. Through your [`gh`](https://cli.github.com) login, it asks the GitHub API for the workflow runs of the repositories your sessions pushed to. The request contains the repository name and a date range, nothing from your sessions. A test workflow on a pushed commit counts as a test run of the code as it was at the push, so later edits still make it stale. Runs are matched to pushes by commit id, which has to appear in the session (in the push output, or from `git commit` or `git log` before it). Branch names and timing alone are not enough. With `--ci`, claims about CI itself ("CI is green", "all checks on the PR pass") are checked too. Workflows with no job or step named like a test, and runs GitHub never started, are ignored.

The report shows how many claims each of these settled.

## What it checks

| Finding | How it's decided |
|---|---|
| Backed claim | The agent said tests pass and the run it refers to passed. That is the run with the count or test file the claim names; for "the full suite passes", the latest run in that folder about as large as the largest one; otherwise the latest result the agent had seen. The run must have started after the last edit to a source file in the same checkout. |
| Code edited after the last run | A test ran, the agent then changed source code in that checkout (with an edit tool, a patch or the shell), and claimed tests pass without running them again. An edit made while the run was still going counts too. |
| Last run had failed | The latest test result in the session showed failures. A subagent's failing run in its own worktree is "couldn't tell" instead. |
| No test run | The agent changed code but ran nothing recognisable as a test before the claim. |
| Couldn't tell | Left out of the receipt rate, with the reason shown: the result can't be read (piped, truncated, mixed with other output), a file changed in a way that can't be traced (a script with no file name in it, `git checkout`, `git merge`), the test was still running, a subagent's run failed in its own worktree, or nothing in the session changed code. |
| Failing test "fixed" by editing only tests | A run failed, the agent changed a test it hadn't touched before, changed nothing else, and the next run passed. Fixing a test the agent just wrote doesn't count. Sometimes the test was wrong, so this is a flag to look at, not a verdict. |
| Weakened an existing test | An edit to a test that existed before the session removed cases or assertions, added `skip`/`xfail`, `.only` or an always-true assertion, or deleted the file. |
| Full-suite runs | A test command with no file, directory, node id or `-k` filter. |
| Retry loops | The same failing command run 3 or more times in a row with no edit in between. |
| Pushback and interrupts | Your messages that start with "no", "stop" or "revert" or contain "I told you", and turns you interrupted. |
| Risky git | `--no-verify`, `push --force`, `reset --hard`, discarding uncommitted changes. |

Background runs are followed: Claude Code's `run_in_background` results (the notification and the output file the agent reads) and Codex cells that finish later through `wait`.

## How it decides

Everything is deterministic pattern matching over the logs. There is no LLM involved, and the same logs always give the same numbers. When a rule is unsure, it says "couldn't tell" instead of flagging the agent.

- Each command's start and its result are separate events, in the order they were observed. A claim can only be backed by a result the agent had already seen. A run covers the code as it was when the run started, so an edit during the run makes it stale.
- In a Codex cell that runs several commands, each command gets its own output. If outputs can't be matched to commands, the result stays unknown.
- An edit counts once it happened: a Claude Code edit after its tool result confirms it, a Codex patch if it applied. Shell writes count too (`sed -i`, redirects, `tee`, `cp`/`mv`, scripts that write named files), placed by the `cd` in effect where they appear.
- A script's writes are the files it clearly writes, such as `open('x.py', 'w')`, `Path('x.py').write_text(...)`, `writeFileSync('x.js', ...)`, or a variable holding such a path that is written later. Files it only reads don't count. A write to a file it can't name (a loop over paths, `extractall`, `shutil.copy` to a variable) makes the claim "couldn't tell".
- An edit in one checkout or worktree doesn't make a run in another one stale. Only edits to source files count; docs, config, data, generated output and hidden tool folders don't.
- `tail pytest.log` is evidence about the run that wrote `pytest.log`, not a new run.
- Results come from the runner's summary line first (`3 failed, 10 passed in 1.2s`, `Tests: 1 failed`, `test result: FAILED`). An exit code is trusted only when the test ran last (`cd app && pytest`, `ruff check .; pytest`) or a plain `&&` chain exited 0. `npm test; true` exits 0 because of `true`.
- Commands refused by a permission prompt, the auto-mode classifier or a hook never ran, so they aren't test runs.
- A claim is a sentence like "all tests pass" or "62 passed". Plans ("I'll make sure the tests pass"), conditions ("once tests pass"), history ("the latest recorded run passed"), questions, partial results ("58 of 59 pass") and quoted runner output are ignored. English is supported, plus simple forms in Greek, Spanish, Portuguese, German, French and Italian.
- Subagent transcripts are merged into the parent session, so a subagent's passing run backs the parent's claim.
- Tests the agent created in the same session can't be "weakened". A Claude Code `Write` over an existing test is an overwrite, so it can.
- `guard` judges only the final message. "Correction: I did not run the tests" after an earlier claim doesn't trigger a block.

The rules are in [`src/classify.js`](src/classify.js) and the tests in [`test/`](test), including a labelled set of claim and non-claim sentences ([`test/claims.corpus.test.js`](test/claims.corpus.test.js)). A false positive or a missed claim makes a good [issue](https://github.com/EleChon-pixel/agent-polygraph/issues/new/choose); include the redacted sentence and it goes into that set.

## Validation and accuracy

The historical analysis of the author's own Claude Code and Codex sessions includes manual spot checks of claims and flagged evidence. In a small, author-selected review, approximately 95% of 25 detected claim candidates were genuine claims, and a separate sample suggested some real claims were missed. **These are preliminary, author-reviewed observations, not externally validated precision or recall.** See the [original evaluation protocol](docs/evaluation.md).

The public Claude Code evaluation reviewed 26 parsed sessions and identified 24 backed claims and three stale findings (one confirmed and two considered likely). It is useful for parser regression coverage but does **not** establish accuracy on an independent, representative population. A separately pinned, redacted holdout audit inspected 103 public sessions; under its conservative automated reference rules, **no eligible claims were found**, so **no holdout accuracy percentage was produced**. Additional dataset limitations and exact counts are documented in [live-evaluation.md](docs/live-evaluation.md).

Two reproducible controlled experiments test narrower propositions:

- [Stop-hook replay](docs/benchmark.md): 25 authored Claude Code/Codex scenarios. Agent-polygraph correctly blocked 14/14 labeled unbacked claims versus 7/14 for a naive “any test passed earlier” hook, with zero false blocks in these selected cases.
- [Executed-test policy comparison](docs/live-evaluation.md): 12 authored scenarios with actual Node.js test executions. The selective guard required five extra test executions and detected three of seven failing final suites; running the full suite after every response required 12 executions and detected all seven.

The replay labels and scenarios were constructed by the project authors. The guard cannot discover failures the agent never claimed away, or infer whether a narrow passing test establishes a full-suite pass. **An independent, blinded human evaluation is still needed.** The [review issue](https://github.com/EleChon-pixel/agent-polygraph/issues/3) describes the protocol; `scripts/blind-review.mjs` prepares prediction-free review packets. No raw private session logs should be shared with reviewers or issues without permission and redaction.

## Limits

These are the gaps that remain. `record` and `--ci` can reduce some of them, but neither replaces running tests or provides independent proof of correctness.

- Tests outside the logs. Tests the agent ran, test runs Claude Code recorded from hooks, commands you typed with `!` in Claude Code, and test output you pasted into the chat all count. So do your own bash and zsh runs with `record --shell`, and GitHub Actions runs on pushed commits with `--ci`. Other shells (fish, PowerShell, an IDE's test button), other CI services, and CI runs on commits the session never printed are still invisible.
- "The full suite passes" prefers an explicitly recognized full-suite command in the same folder, even when no count was printed. If the only observed run is targeted and there is no full-suite evidence, the result is **inconclusive**, not backed. Count-based heuristics still help when the runner cannot reliably identify the suite's scope. A passing test run is evidence of that run, never proof that all code works.
- Output with no summary. Codex keeps each command's full output. Claude Code may save long output to a separate file that the analyzer reads if it still exists. New `record` entries retain **parsed test outcomes and pass counts, not raw test output**. A run abandoned before printing a result leaves nothing to read.
- Files a script names at run time. Without `record` these make a claim "couldn't tell", never "backed". `record` settles them, but only in git checkouts and only for sessions after it was installed.
- New agent versions can change the log format. Supported: Claude Code 2.x (Bash and PowerShell tools; Linux, macOS and Windows paths) and Codex CLI. The report lists the versions it read, warns about newer ones, and counts files it couldn't parse instead of dropping them silently.
- Unbacked is not the same as false. "Code edited after the last run" means the claim wasn't verified after the edit; the edit may have been harmless, such as a comment or a test file. The report can't tell whether the tests would have passed, because nobody ran them at that point.
- The numbers describe your sessions, projects and prompts. They are not a benchmark of the models.

## Options

```
--since <when>      only sessions since a date (2026-10-01) or age (7d, 4w, 3m)
--project <text>    only sessions whose working directory contains <text>
--exclude <text>    skip sessions whose id starts with, or whose working directory contains, <text> (repeatable)
--agent <name>      claude or codex (repeatable; default: both)
--by <col>          compare by "agent" (default) or "model"
--examples <n>      examples to show per finding type (default 3, 0 to hide)
--html [file]       write a numbers-only report to share (default polygraph.html)
--json              full results as JSON: findings, unclear reasons, unreadable files (keep it local)
explain             investigate flagged/uncertain verdicts (--limit, --since, --session, --project)
doctor              check local hooks, transcript availability and recorder permissions
--ci                also use GitHub Actions results (goes online, through your gh login)
--claude-dir <dir>  Claude Code projects dir (default ~/.claude/projects, or $CLAUDE_CONFIG_DIR/projects)
--codex-dir <dir>   Codex sessions dir (default ~/.codex/sessions, or $CODEX_HOME/sessions)
```

## Running the repository version

The GitHub source and the npm-distributed package are different delivery paths. To try the **current `main` code** without assuming npm is up to date:

```sh
git clone https://github.com/EleChon-pixel/agent-polygraph.git
cd agent-polygraph
node bin/polygraph.js --demo
npm test
npm run benchmark:replay
npm run benchmark:live
```

Before distributing a new version, verify `npm view agent-polygraph version`, the published tarball (`npm pack --dry-run`), and that a clean install really contains the latest privacy and guard fixes. The public npm release is currently **0.2.1**. Development on `main` may contain unreleased changes, so `npx agent-polygraph` does not necessarily have the latest GitHub fixes. A green GitHub Actions badge does **not** prove npm has been updated.

## Privacy

New recordings intentionally minimize local data. The agent hook stores a keyed command fingerprint, the runner's result and optional fingerprints of source files. It does **not** save raw command text, test output or copies of repository files in its snapshot store. The shell integration saves only a recognized test-runner category, time, folder and exit code. Local record files, key and snapshot metadata are owner-only on Unix. Hook settings and shell startup files are replaced atomically, preserving their permissions and creating private recovery backups under `~/.agent-polygraph/backups` (see [recovery](docs/releasing.md#recovery-for-installed-hooks)). The secret fingerprint key is stored in `$AGENT_POLYGRAPH_HOME/record-key` (default `~/.agent-polygraph/record-key`).

**Existing installations:** records made before this update may still include full commands, and older versions may have created a local Git object store with duplicate source contents. Upgrading does **not** remove those files. After reviewing whether you still need the historical evidence, uninstall recording and manually remove the old `~/.agent-polygraph/records` and `~/.agent-polygraph/objects` directories. Removing historical records means those sessions will lose their supplemental evidence; the original Claude Code/Codex transcripts remain untouched. Do not delete `record-key` while retaining version 2 records that rely on matching fingerprints.

Stored fingerprints are **not** a guarantee of anonymity: recording metadata includes timestamps, working directories and relative source-file paths, and existing v1 records may still contain raw commands. The original Claude Code/Codex transcripts can also contain secrets and confidential data. The terminal report and `--json` may quote transcript text and paths; do not share them without review. The `--html` report intentionally excludes excerpts, prompts, commands and paths. The recorder only supports bounded source-file snapshots in Git checkouts and skips symbolic links; when evidence cannot be read it must stay inconclusive rather than certifying a pass. New source-file fingerprints include relative filenames and are not an anonymization guarantee.


It reads files and works offline. These operations are opt-in:

- `guard` and `record` edit the hook config files they print when you install or uninstall them, and `record --shell` adds or removes one marked line in `~/.bashrc` and `~/.zshrc`.
- `record` saves snapshots and logs in `~/.agent-polygraph`.
- `--ci` and `explain --ci` contact api.github.com through `gh` and send repository names and date ranges.

The terminal report and `--json` include excerpts from your sessions. `--html` doesn't.

## License

MIT
