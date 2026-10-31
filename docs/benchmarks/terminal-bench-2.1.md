# Terminal-Bench 2.1: mu and pi on the same model

Does mu's judgment kernel make an agent finish more tasks? This run compares mu with pi, the harness mu is built on: the same model, the same tasks and the same time limits, three attempts per task. The README's [Measured](../../README.md#measured) section has the summary; this page has the method. Every attempt's result is in [terminal-bench-2.1.csv](terminal-bench-2.1.csv), and [bench/harbor/](../../bench/harbor/) has the Harbor adapter that ran mu and pi and a script that recomputes every number here from the CSV.

## Result

Over three attempts per task, mu with Jev passed 68.2% of its attempts and pi passed 58.7%: 9.5 points more, with a 95% interval of +3.8 to +15.2. mu failed less often in both ways: 65 of its attempts ran out of time with the task unfinished, against pi's 81, and 19 finished with a wrong result, against pi's 28.

| Terminal-Bench 2.1, 88 tasks × 3 attempts | mu · Jev | mu · pre-release mude | pi |
| --- | --- | --- | --- |
| Attempts passed | 180 of 264 (68.2%) | 174 of 264 (65.9%) | 155 of 264 (58.7%) |
| Difference from pi, 95% interval | +9.5 points (+3.8 to +15.2) | +7.2 points (+1.5 to +13.3) | |
| Tasks where mu's pass rate is higher / lower than pi's | 25 / 8 | 25 / 10 | |
| Tasks passed at least once / in all three attempts | 72 / 49 | 69 / 47 | 66 / 40 |
| Attempts that hit the time limit (passed anyway) | 87 (22) | 81 (10) | 97 (16) |
| Failed attempts: out of time / finished wrong | 65 / 19 | 71 / 19 | 81 / 28 |
| Agent time, all attempts | 70.7 h | 64.4 h | 70.8 h |
| Agent time per passed attempt | 23.6 min | 22.2 min | 27.4 min |
| Cost per passed attempt | $0.067 | $0.063 | $0.069 |

## Method

- **Benchmark.** Terminal-Bench 2.1, all 89 tasks, downloaded with `harbor download terminal-bench/terminal-bench-2-1` and run with Harbor 0.24.0 in Docker. Each task runs with its own time limit, from 10 minutes to 3 hours 20 minutes (timeout multiplier 1). When the agent hits the limit, a plugin stops its process and Harbor runs the task's tests on what it left, so an attempt can time out and still pass.
- **One task left out of the totals.** pytorch-model-recovery's instruction starts with a dash, and in the first runs Harbor's pi command passed it without `--`, so neither pi nor mu saw it. The adapter was fixed and those attempts ran again; every configuration passed the task in all three attempts on record. It's left out for every configuration, which doesn't change the comparison and leaves 88 tasks.
- **Model.** MiMo v2.6 Pro (`xiaomi/mimo-v2.6-pro`) with reasoning effort high, for every configuration.
- **Control.** pi 1.4.0, as Harbor's pi agent installs it.
- **mu.** mu-agent 0.1.12, built on pi 1.3.0, installed from one fixed tarball for every attempt, with its default settings. Neither mu 0.1.12 nor pi knew its time limit. Two judges:
  - **Jev 1.14**, hosted by TypeSafe: 2,303 verdicts, 0.2% of them falling back to mu's fixed rules.
  - **A pre-release build of mude**, served on the same Mac. It has 24 layers; mude 1.0 is the 20-layer model made from it, so these results aren't mude 1.0's. When its server couldn't be reached, mu fell back to its fixed rules: for 8.4% of its verdicts in attempt 1 and 2.6% in attempts 2 and 3.
- **Not measured.** mu releases after 0.1.12, mude 1.0, other models and other benchmarks.
- **Attempts.** Three per task, from 2026-10-22 to 2026-10-24. Attempts 2 and 3 ran mu and pi at the same time, at the same concurrency: 3 tasks per configuration, then 2 once the Docker VM ran short of memory.
- **Reruns.** Only for infrastructure failures: Docker or disk errors, a judge server that couldn't be reached or failed half its verdicts, an agent still running into verification after its timeout, a verifier stuck cloning. The rules were set before the run and don't look at whether an attempt passed. In the last stretch of attempts 2 and 3 this reran 10 mu-with-mude attempts (6 of which had passed), 3 mu-with-Jev attempts and 1 pi attempt.
- **Machine.** One 16 GB Mac with Apple silicon. Terminal-Bench's images are x86_64 and run under Rosetta, which makes four tasks fail for every configuration: qemu-alpine-ssh and qemu-startup (Rosetta lacks `signalfd`, so qemu crashes) and path-tracing and path-tracing-reverse (the grader runs the program in a chroot without `/proc`). Absolute pass rates are about 4.5 points lower than on an x86_64 machine and can't be compared with the public leaderboard. The comparison with pi isn't affected: every configuration fails those tasks, apart from one mude attempt that got qemu-alpine-ssh working.
- **Time.** Harbor's agent execution time, from the agent's start to its end, without environment setup or verification.
- **Cost.** Recomputed from token counts at MiMo's list prices: $0.435 per million input tokens, $0.0036 per million cached input tokens and $0.87 per million output tokens. Jev is added at $0.042 per million input tokens. The local mude build counts as $0, without its compute.

## Statistics

- **Pass rate.** For each task, the share of its three attempts that passed; then the mean over the 88 tasks. With three attempts everywhere, that equals attempts passed ÷ 264.
- **Interval.** The difference from pi is paired by task, with a 95% interval from 10,000 bootstrap resamples of the 88 tasks (seed 0 in `bench/harbor/tb21_summary.py`; another seed moves the bounds by a few tenths of a point).
- **Tasks won and lost.** A task counts for mu when its pass rate is higher than pi's on that task, and against it when lower. Ties are left out.

## The per-task file

[terminal-bench-2.1.csv](terminal-bench-2.1.csv) has one row per task: its agent time limit in seconds, then each configuration's three attempts in order, one letter each.

| Letter | Attempt |
| --- | --- |
| `P` | passed |
| `p` | passed after hitting its time limit |
| `T` | failed after hitting its time limit |
| `F` | failed |

The note column marks the four tasks Rosetta breaks and the task left out of the totals. `python3 bench/harbor/tb21_summary.py docs/benchmarks/terminal-bench-2.1.csv` prints the table above from this file alone.

## Reproducing it

[bench/harbor/README.md](../../bench/harbor/README.md) has the commands. pi is Harbor's own pi agent; mu runs through `bench.harbor.mu_agent:Mu`, which installs mu-agent and runs `mu` with pi's arguments, and `bench.harbor.kill_on_timeout` stops an agent's process when its time runs out.
