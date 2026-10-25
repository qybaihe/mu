# Test-log admission: survey, design, Jev validation and a replay of real sessions

> English translation of [09-test-log-admission.md](09-test-log-admission.md); the Chinese original is authoritative.
>
> The project was renamed mu on 2026-09-21 (command `mu`, logo μ). This note was written before the rename and its text is left as it was; [10-rename-to-mu.md](10-rename-to-mu.md) maps the old names to the new ones.
>
> 2026-10-21: mu now has more than one judge. Where "Jev" meant the judge in general, the text now says "the judge"; Jev names only TypeSafe's hosted judge model, so the measurements and the config value `jev` keep the name.

Date: 2026-09-21; folding measured again on more logs on 2026-10-25 (section 8). Status: **wired in as an optional strategy, off by default** (`features.admission.testLog`, one of `off`, `rules` or `jev`).

- Code: `packages/kyrn-judge/src/admission/test-log.ts`, wired in at `src/extension/features/admission.ts`
- Tests: `test/test-log.test.ts` (26 tests, offline, covering all 38 samples) and `test/admission-test-log.test.ts` (6 tests, faux sessions)
- Samples: `test/fixtures/test-log-cases.ts` and `test-logs/*.txt` (all synthetic; real logs never enter the repository)
- Replay: `kyrn/spikes/judge-bench/test-log-replay.ts`, with results in `results/` (gitignored)

## Conclusions

1. **In real sessions, the redundancy in test logs isn't in passing-test records. It's in repeated failure details.** KYRN's own history (2 days, 32 session files) holds 15 test logs. 7 are over 4,000 characters, and **all 7 are failing runs**. The agent almost always ran specific files with the default reporter, so there were no long stretches of passing tests. 58% of the characters in these 7 logs are runs of 6 or more consecutive lines that are byte-for-byte identical to earlier text: the same diff, DOM dump or stack trace, printed once per failed test.
2. **One deterministic rule captures this gain.** Replacing each repeated run with a one-line back-reference marker (the first copy is always kept) saves a net **51.0%** across the 7 long real logs (86% on the largest, at 37.8K). Expanding the markers restores the original byte for byte, and all 15 logs pass that check. No judge is called, and no real history leaves the machine.
3. **The old path never looked at these logs.** It let any result with `isError` through untouched, and a failing test run is exactly an `isError` result.
4. **Jev's goal-aware selection works on synthetic verbose logs, but has nothing to do in this real history.** On synthetic samples (verbose reporter, stdout from passing tests) it kept 72/72 required evidence lines, wrongly removed 0 and saved a net 40.2%. On held-out samples not used for tuning it kept 19/19 and saved 46.4% (a perfect judge: 46.5%). On the real logs the parser produces 0 candidates, so the judge is never called.
5. **`AI_AGENT=1` solves most of the judge's share at the source.** Measured on Vitest 4.1.9: the default reporter's output drops from 5,336 to 2,134 characters. Only the failing tests' own stdout is kept, and the failure details are intact; an explicit `--reporter=verbose` still takes precedence. It's now set by default in the bash environment.
6. Goal-blind "keep failures only" (the strategy rtk and tokf share) saves 61.9% on the synthetic samples, but loses 9 required evidence lines across 4 goals.

So the division of labor is: **rules first (free and lossless) → silence the runner at the source → only the verbose output that's left goes to the judge.** My first synthetic benchmark measured a distribution that never shows up in this user's real usage, and that has to be said up front.

The synthetic part is real runner output from synthetic projects plus hand-written labels. It is **not a measure of real task success**. The real part measures only characters and losslessness, not how the main model performs with the trimmed text. In all there were 282 live Jev calls and about 398K input tokens, roughly $0.017 at list price, and only synthetic samples were sent.

## 1. Survey of existing projects

| Project | Approach | Worth borrowing | Limitations |
|---|---|---|---|
| [rtk-ai/rtk](https://github.com/rtk-ai/rtk) (Apache-2.0, 81K stars) | A command proxy that parses output per runner and **regenerates** it as "failures only + pass count" | Three-level parser fallback (JSON → regex → raw), and unrecognized output passes through; on failure it stores the original, which `rtk recall <hash>` retrieves; counts retrievals as a signal of filter quality | Goal-blind. The output is rewritten, so a parsing error makes it lie. Issues: #1813 shows only 5 of 49 failures; #3870 reports a hard error as "No issues"; #3492 and #2974 swallow the exit code and produce false passes |
| [mpecan/tokf](https://github.com/mpecan/tokf) (MIT) | Filters configured in TOML | Skips filtering when the command has `-v`/`--tb`; every filter is verified against fixtures, including prompt-injection and hidden-character checks; an empty result gets a one-line explanation, so the agent doesn't keep changing arguments to get around the filter | Goal-blind; changes the exit code to 0 by default |
| [mksglu/context-mode](https://github.com/mksglu/context-mode) (24K stars) | Output over 5KB that comes with an `intent` is stored; BM25 + trigram retrieval returns the relevant snippets | Intent-driven, returns original snippets, attaches a vocabulary for follow-up searches | Lexical matching: a goal that says "why did it fail" doesn't match a log that says `AssertionError` |
| [Ayanami1314/swe-pruner](https://github.com/Ayanami1314/swe-pruner) (MIT, ByteDance, arXiv 2601.16746) | The agent supplies a `context_focus_question`, and a 0.6B model does **line-level extraction** | The closest to this experiment. It saves 23–54% of tokens on SWE-Bench Verified with no drop in score, which shows that "goal-aware + extractive" works | Trained for source code, not logs; needs a self-hosted GPU service; no deterministic safety layer |
| [yvgude/lean-ctx](https://github.com/yvgude/lean-ctx) (Apache-2.0) | 95+ output patterns, with content-addressed, reversible storage | Trimming never discards anything, and deterministic handles retrieve it; has an off/on test bench at equal budget | Goal-blind |
| Vitest [#9779](https://github.com/vitest-dev/vitest/pull/9779) (merged 2026-03) | With `AI_AGENT=1`, prints only failures and the summary | Silencing at the source costs nothing; worth turning on by default in the bash tool's environment | Covers Vitest only; when the goal needs the list of passing tests, you have to rerun with another reporter |
| pi itself | Truncates bash output to the last 2000 lines or 50KB, saves the original to a temp file and leaves a pointer | Admission may already see truncated text; `details.fullOutputPath` can be reused directly as the archive | — |

Related papers: The Complexity Trap (arXiv 2508.21433) found that simple observation masking works as well as LLM summarization at half the cost, so **the rules arm is the baseline to beat**, not just `full`. See also ACON (arXiv 2510.00615).

The common gap: these projects are either goal-blind or rely on lexical matching or a dedicated small model. None of them is at once goal-aware, rebuilt only from the original text, protective of whatever it doesn't recognize, and retrievable. Those four properties are the design of this experiment.

## 2. Design

**Problem.** The old path cut output into 1,200-character chunks and asked of each one "what category is this?" A category isn't a value: the same block of passing-test records is noise when you're debugging a failure and evidence when you're listing what passed.

**Example.** In a real Vitest log, 9 passing tests each print a block of stdout, and the failing test prints one too (`exp=50 now=100`, which is exactly why it failed). The draft rule "protect everything after the first failure keyword" makes the 60-odd lines of passing-test records after the first `×` untrimmable. A rule that "deletes all stdout" deletes the failing test's own output.

**Approach.**

1. **Units of information, not character chunks.** Split by line syntax and block structure: each file's passing-test records, progress, exact duplicate warnings, and a single test's stdout/stderr block. Look only at the marker at the start of a line, never at words in test names (`✓ handles error responses` is a passing record).
2. **Protect what isn't recognized.** Failure blocks (with their diff and stack trace, up to the next status line at the same level), the failure-detail section through to the end, the summary and unknown lines never become candidates. Four more deterministic protections: the failing test's own output, output blocks with warning or error words (first occurrence), slow tests (≥300ms), and lines that share identifiers or quoted phrases with the goal (anchors).
3. **The judge only selects.** Each candidate gets one `needed / not_needed / unclear` choice question, all in one request. The shared state is `goal`, `intent`, `call`, `run` (the summary and the list of failures) and the candidate texts. Long candidates are shown as head and tail only. A candidate is omitted only when P(not_needed) ≥ 0.9. No probability, an unknown id, an error, a cancellation, shadow mode or off mode all mean "keep".
4. **Rebuild from the original.** Kept bytes are identical to the original, ANSI codes and CRLF included. Each omitted run leaves a one-line marker (line count and kind), and the last line is a pointer to the archive.
5. **Net-saving guard.** A run shorter than its own marker isn't omitted. If the total net saving is below max(300 characters, 10%), the original is returned unchanged.
6. **Budget.** At most 24 questions and a 14K-character state, asking about the largest candidates first. Candidates that don't fit are kept.
7. **Omitting repeated runs (added after the real replay).** Within protected text, a run of 6 or more consecutive lines and at least 200 characters that is byte-for-byte identical to earlier **kept** protected text is replaced with a back-reference marker: `[kyrn: omitted 443 lines: identical to lines 20-35, 25-35 ×38, 454-462 of the full output, kept above]`. References are in order, carry repeat counts and are never truncated. The source must be kept text, so chained repeats all point to the first copy. This rule doesn't depend on the goal: it runs in both the `rules` and `jev` arms and never goes through the judge.

**Required and optional.** 1–5 and 7 are required. Drop any of 1–5 and the real failures from the survey show up; 7 is the only rule that produces savings on real logs. Anchors, slow-test protection and splitting per file are optional precision improvements; turning anchors off barely changes the results (see below).

**Why omitting repeated runs isn't deleting failure evidence.** Every failure's title, error message and unique lines stay. Only text identical to what's above is omitted, and the marker says which lines and how many times. The first implementation merged 38 adjacent identical references into a single "identical to lines 25–35" and lost the count. The check that expanding the markers must restore the original byte for byte caught it, and that check is now a test.

**Injection.** Logs are untrusted text. The judge can only vote on recognized status lines, and failure evidence never goes through it. A judge that always answers "omit" can't remove any protected text in any of the 38 cases (there's a test for this).

## 3. Jev validation on synthetic samples

Tuning samples: 7 real runner outputs (Vitest 4.1.9 verbose/default/ANSI, node:test TAP/spec, pytest 9.1.1 -v/default) produced by one synthetic project, with paths anonymized. They're paired with 16 "same log × different goal" cases, plus 13 hand-written edge cases. The draft's 10 small samples were kept. 6 of them had protected summary lines labeled `optional`, which can never be omitted and would drag the omission rate down; these were corrected.

Live judging: TypeSafe direct, `jev-latest`. Tuning took 246 requests and 357,595 input tokens; the held-out set took 36 requests and 80,922 tokens. Only synthetic samples were sent.

| Arm | Required evidence kept | Wrongly removed | Optional noise omitted | Net characters saved | Requests | Input tokens | Latency p50 / p95 |
|---|---|---|---|---|---|---|---|
| full | 72/72 | 0 | 0/28 | 0% | 0 | 0 | — |
| rules | 72/72 | 0 | 0/28 | 0% | 0 | 0 | — |
| Always omit (offline reference) | 63/72 | 9 (4 cases) | 23/28 | 61.9% | — | — | — |
| Perfect judge (offline reference) | 72/72 | 0 | 23/28 | 52.5% | — | — | — |
| **jev: suffices (default)** | **72/72** | **0** | **19/28** | **40.2%** | 20 | 31,685 | 345 / 2,337 ms |
| jev: policy (draft wording) | 72/72 | 0 | 17/28 | 35.2% | 20 | 30,833 | 323 / 749 ms |
| jev: needed | 72/72 | 0 | 14/28 | 28.0% | 20 | 30,461 | 513 / 4,797 ms |
| jev: lean | 72/72 | 0 | 14/28 | 29.3% | 20 | 25,657 | 376 / 431 ms |
| jev: asks (boolean) | 72/72 | 0 | 2/28 | 2.2% | 20 | 22,780 | 415 / 2,724 ms |

With anchors off: suffices 40.1%, policy 35.4%, both still 72/72. The cost of re-reading after a wrong removal is 0 on every Jev arm; every archive file exists and matches the original.

**Findings.**

- **Goal awareness is real.** With the goal "look at the auth tests' stdout", Jev gives the auth output blocks P(omit) = 0.02–0.05 and the duplicate warnings between them 0.98–0.99, alternating block by block. The highest P(omit) for any candidate holding required evidence is 0.19.
- **Ask "is it enough?", not "is it relevant?".** `needed` asks whether the candidate contains what the goal asks about. When the goal is "did the tests pass?", passing-test records are on topic, so Jev gives 0.58–0.65 and everything is kept. `suffices` first states that the summary and failures are kept no matter what, then asks whether this candidate is still needed. On the same kind of goal it gives 0.98 or more.
- **Boolean probabilities are compressed.** For equally clear cases, boolean questions give 0.14–0.17 and 0.83–0.86, while choice questions give 0.01 and 0.99. Thresholds can't be carried over between question types.
- **`unclear` was never chosen.** Its probability was always 0.00. The uncertainty is spread across the two real options, so the 0.9 bar is what actually does the work.
- **The threshold isn't on a cliff edge.** Recomputing from stored answers at every level from 0.7 to 0.99, no wording removed anything it shouldn't have. 0.9 stays as it is; it wasn't tuned for savings.
- **Billing.** `tokens ≈ 0.279 × state characters + 0.277 × question characters + 317` (123 requests, mean error 48). The state is billed once. Question text costs the same per character as the state, and at 12 questions the question text is longer than the state. Moving the option descriptions into the state (`lean`) saves 19% of tokens but makes the judge less decisive, so it isn't worth it.
- **Not bit-for-bit deterministic.** Running the same input twice, 27 of 72 answers differed in probability by 0.01–0.04, with the same overall result. Candidates right around 0.9 can flip.

**Held-out samples.** The wording, the parser and the threshold were all settled on the 29 cases above, so a separate, unseen set was built: a second synthetic project (thrown exceptions, timeouts, a fixture failing during setup, skipped tests) and 9 goals of new kinds ("did that retry test run?", "did anything write to stderr?", "were any tests skipped?" and so on, none with an identifier to anchor on). The set was labeled first, then run once, and nothing was changed afterward.

| Arm (held-out, 9 cases) | Required evidence kept | Wrongly removed | Optional noise omitted | Net characters saved | Input tokens |
|---|---|---|---|---|---|
| rules | 19/19 | 0 | 0/15 | 0% | 0 |
| Always omit | 13/19 | 6 (3 cases) | 15/15 | 59.4% | — |
| Perfect judge | 19/19 | 0 | 14/15 | 46.5% | — |
| **jev: suffices** | **19/19** | **0** | **14/15** | **46.4%** | 20,595 |
| jev: suffices, anchors off | 19/19 | 0 | 13/15 | 45.2% | 20,595 |
| jev: policy | 19/19 | 0 | 13/15 | 44.3% | 19,866 |

Every structure the parser hadn't seen before fell on the protected side: the failing test's own stdout (`available=undefined`, which is exactly the cause), the second line of a timeout message, `↓` skip markers, and pytest's `ERROR`/`SKIPPED` lines. "Did that retry test run?" refers to a passing record in natural language. Jev gives the candidate that holds it P(omit) = 0.39, its stdout 0.18, and the rest 0.88–0.99.

The narrowest safety margin was on "did anything write to stderr?": the two stderr blocks got P(omit) of 0.51 and 0.66. The result was correct, but it shows that the 0.9 bar is doing real work and shouldn't be lowered below 0.8.

**Where Jev is still conservative** (suffices, compared with the perfect judge):

- "List every passing test in the cache suite": it correctly keeps the cache suite's passing records (needed, 0.89), but is unsure about other files' passing records (0.40–0.60), so the net saving is 0.
- "Which tests are slowest?": it thinks passing records with timings might be needed (0.57–0.74). That's a reasonable call; the labels were too strict.
- "Look at the auth stdout": every judgment is right, but the small blocks to omit sit between blocks to keep. Each omitted run is barely longer than its marker, so the guard decides it isn't worth it.

## 4. Replay of real sessions

Scope: `~/.kyrn/agent/sessions/**/*.jsonl` and `~/.kyrn/acp-sessions/*.jsonl` (including the transcripts of swarm subagents), read-only. That's 1,362 tool results and 330 bash results, among which `isTestLog` recognized 15 distinct test logs (14 from vitest and 1 from `npm test`; 11 from main sessions and 4 from subagents). The extracts stayed in the session's scratch directory. They never entered the repository and were never sent to any external service: the replay used a judge that throws if it's ever called, and it was called 0 times.

| Log | Characters | What it is | Repeated runs | Net saved |
|---|---|---|---|---|
| real_3 | 37,819 | 5 failures, each with a nearly identical diff of a message array | 156 runs, 1,728 lines | 86% |
| real_10 | 34,115 | DOM test, 4 failures, repeated DOM dumps and stack traces | 34 runs, 430 lines | 44% |
| real_14 | 34,115 | The same kind of run, seen by a subagent | 34 runs, 430 lines | 44% |
| real_9 | 15,565 | 4 stderr blocks share one node-internal stack trace; 2 failures share a DOM dump | 4 runs, 138 lines | 47% |
| real_13 | 9,249 | 2 failures | 1 run, 43 lines | 16% |
| real_0 | 4,953 | 7 suites fail to parse | 1 run, below the net-saving bar | 0% |
| real_4 | 4,004 | 5 failures, all different | none | 0% |

The 7 logs total 139,820 characters, with 71,296 saved net (**51.0%**). The other 8 are under 4,000 characters, which admission doesn't process anyway. All 15 pass the check that expanding the markers gives back the original byte for byte.

**Why there are 0 judge candidates.** These runs all used the default reporter on specific files: a passing file gets one line, and only failing files are expanded. The passing records and passing-test stdout I targeted with the synthetic samples barely exist here. The sample is only 15 logs from two days of one person's development, so it can't be extrapolated to other projects. It is enough to show that the synthetic benchmark and real usage have different distributions.

**Where the judge might still help with real logs** (none of this is done; noted for later):

- Environment noise unrelated to the failures. In real_9, 4 `stderr` blocks report a failure to parse `/api/settings/client`, which has nothing to do with the two failing assertions (text that changed from the upstream name to KYRN). They contain error words, so they're always protected today. Letting the judge decide whether to keep them is risky, since an error in stderr is sometimes exactly the cause. One option is to ask in shadow only, without acting, and compare against whether those blocks are referenced later.
- The replay showed chains of reruns (real_3 → real_6: 5 failures → … → pass). That's the deterministic signal the automatic-rewind value function needs, and the parser can already report each run's failure count and failing test names.

## 5. Wiring

`~/.kyrn/agent/kyrn.json`:

```json
{ "features": { "admission": { "testLog": "rules" } } }
```

- `off` (the default): behaves exactly as before.
- `rules`: deterministic omission only (repeated runs, progress, exact duplicate warnings). The judge isn't called.
- `jev`: applies the rules, then asks the judge once about the remaining candidates. Whether its verdicts take effect is set by `modes["tool.admission.test-log"]`, which defaults to `shadow`: verdicts are recorded and the text isn't changed.

Test logs take a separate branch. `isError` isn't skipped (failing runs are where the volume is), and once a result is recognized as a test log it no longer goes into the old per-chunk classification path. The archive holds the text as it was when judged, not pi's full output file, because the line numbers in the markers count lines in that text. `goal` comes from `runtime.taskFrame()` and `intent` from the latest assistant text; with no intent, only the rules run.

`features.admission.agentEnv` (default `true`): runs `process.env.AI_AGENT ??= "1"` when the extension loads, and bash child processes inherit it through `getShellEnv()`.

## 6. Limits

- The samples come from synthetic projects, and the goals, intents and labels were all written by one person. The held-out set lowers the risk of overfitting the wording, but both sets were written the same way and still aren't real tasks. This needs retesting on logs from real sessions.
- There are no real samples from Jest, Go or Cargo. Jest's `PASS`/`FAIL` lines are recognized only by their known syntax, and its `console.log` blocks aren't yet recognized as output blocks: lines in such a block that start with `✓` are treated as passing records and become candidates. This affects only the noise side; failure evidence is unaffected. Go and Cargo have no syntax for passing lines, so they yield no candidates and are kept as they are.
- The rules arm is narrowly defined (progress lines and exact duplicates). This batch of test logs has almost none of that, so its 0% only says that the redundancy in test logs isn't there. It doesn't mean rules are useless on install or download logs. More aggressive goal-blind rules are represented by the "always omit" arm.
- Only characters and evidence retention were measured. The main model's task performance on the trimmed text, its re-reads, caching and total cost were not.
- In production, `goal` and `intent` have to come from `runtime.firstUserMessage` and `lastAssistantText`, and they'll be of lower quality than hand-written ones.
- The real replay covers only 15 logs, all from two days of KYRN's own development and all from Vitest. There's no data on whether the repeated-run rule works as well with other runners.
- The repeated-run rule applies only to output recognized as a test log. Build and install logs can also hold a lot of repetition; they weren't touched.
- The effect of `AI_AGENT=1` on tools other than Vitest hasn't been checked one by one. Any tool that uses `std-env` to detect an agent environment may change its output. `agentEnv: false` turns it off.

## 7. Next steps

1. ~~Read-only replay of real session logs~~, ~~wiring in as an optional strategy~~, ~~`AI_AGENT=1`~~: done (2026-09-21).
2. Turn on `testLog: "rules"` and use it for a while. It's lossless and free; the only risk is that the markers might confuse the main model. The thing to watch is whether the main model goes to read the archive file because of them.
3. Record "pointer read" events as a signal of filter quality (as rtk does).
4. Before extending the repeated-run rule from test logs to all long bash output, measure the repetition rate on the 330 bash results in the history.
5. Keep `jev` in shadow and evaluate it once the ledger has collected real judge candidates. With current usage, that may take a long time.

## 8. Folding on more logs (2026-10-25)

The replay in section 4 had 7 long logs, all Vitest, from two days of one person's sessions. Those session files are gone, and the repeat rule hasn't changed since (`test-log.ts` is the same as at the rename on 2026-09-22), so this round measured it on more logs with `kyrn/spikes/judge-bench/test-log-repeats.ts`: the `rules` arm only, no judge, and a round-trip check on every log.

- **Sample.** Failed GitHub Actions runs, read as data and never run: from each of 12 open-source projects, chosen by test runner before measuring, its 6 most recent failed runs, and mu's own failed test runs since 2026-09-22. One failing test log per run, so a failure repeated across a CI matrix counts once, cut the way mu's bash tool cuts output (the last 2,000 lines or 50 KB) before admission sees it. Only logs mu recognizes as test logs count (`isTestLog`, 4,000 characters or more).
- **Not usable.** The authors' recent agent sessions held only 6 failing test logs over 4,000 characters, because the agent piped most test runs through `tail`; none had a repeat to fold. The Terminal-Bench 2.1 runs held none: the agents there don't run test suites with long output. Go and Cargo logs aren't recognized as test logs (no run summary the parser knows), so they're never folded.

| Failing test logs, one per run | Logs | Characters | Net saved | Folded logs | Largest |
|---|---|---|---|---|---|
| Jest: babel, docusaurus, react, jest | 14 | 584,229 | 40.1% | 12 | 81% |
| pytest: poetry, pandas | 5 | 255,721 | 26.7% | 3 | 50% |
| Vitest: nuxt, prettier, svelte, vite, vitest, vue | 18 | 530,853 | 9.2% | 4 | 36% |
| Vitest: mu's own CI | 27 | 942,761 | 6.0% | 6 | 31% |
| Vitest: the authors' sessions, 2026-09-21 (section 4) | 7 | 139,820 | 51.0% | 5 | 86% |
| All | 71 | 2,453,384 | 19.5% | 30 | |

Every folded log comes back byte for byte: in the public logs every omitted line is a back-reference to kept lines; in 6 of mu's CI logs, repeated stderr blocks are also omitted, and those come back from the archived original.

**What changed.** The 51% from section 4 isn't typical. It came from logs where one diff or DOM dump repeats for every failed test. Jest and pytest print each failure's diff and stack trace in full, so their failing logs fold by a third or more; Vitest's default reporter repeats less, and most of its failing logs have nothing to fold.

## Reproducing

```bash
# Offline (no model calls)
node kyrn/spikes/judge-bench/test-log-replay.ts
# Live Jev (sends only synthetic samples; the replay script for real session logs never calls the judge). SET=tuned|heldout reports the two sets separately
SET=heldout KYRN_JUDGE=jev node --env-file=.env kyrn/spikes/judge-bench/test-log-replay.ts
# Folding on your own logs: one {"command", "output"} JSON object per line; BASH_TOOL=1 cuts each output as mu's bash tool does
BASH_TOOL=1 ONE_PER_RUN=1 node kyrn/spikes/judge-bench/test-log-repeats.ts shell-results.jsonl
# Unit and integration tests (from packages/kyrn-judge)
node ../../node_modules/vitest/dist/cli.js --run test/test-log.test.ts test/admission-test-log.test.ts
```

Requires Node ≥ 23.6.
