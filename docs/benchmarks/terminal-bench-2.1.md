# Terminal-Bench 2.1: mu and pi on the same model

Does mu's judgment kernel make an agent finish more tasks? This run compares mu with pi, the harness mu is built on: the same model, the same tasks and the same time limits, three attempts per task. The README's [Measured](../../README.md#measured) section has the summary; this page has the method, the statistics and the caveats. Every attempt's result is in [terminal-bench-2.1.csv](terminal-bench-2.1.csv).

## Result

Over three attempts per task, mu with Jev passed 68.2% of its attempts and pi passed 58.7%: 9.5 points more, with a 95% interval of +3.8 to +15.2. mu passes more because fewer of its attempts run out of time, not because it's faster at a task.

| Terminal-Bench 2.1, 88 tasks × 3 attempts | mu · Jev | mu · pre-release mude | pi |
| --- | --- | --- | --- |
| Attempts passed | 180 of 264 (68.2%) | 174 of 264 (65.9%) | 155 of 264 (58.7%) |
| Difference from pi, 95% interval | +9.5 points (+3.8 to +15.2) | +7.2 points (+1.1 to +13.3) | |
| Tasks where mu's pass rate is higher / lower than pi's | 25 / 8 (sign test p = 0.005) | 25 / 10 (p = 0.017) | |
| Attempt 1 alone: tasks passed | 57 of 88 (McNemar p = 0.064) | 56 of 88 (p = 0.077) | 48 of 88 |
| Tasks passed at least once / in all three attempts | 72 / 49 | 69 / 47 | 66 / 40 |
| Attempts that hit the time limit | 87 | 81 | 97 |
| Agent time, all attempts | 70.7 h | 64.4 h | 70.8 h |
| Agent time per passed attempt | 23.6 min | 22.2 min | 27.4 min |
| Tasks passed by both: time, mu ÷ pi | 1.08 (0.98 to 1.21), 64 tasks | 0.98 (0.90 to 1.08), 61 tasks | |
| Cost per attempt | $0.046 | $0.042 | $0.040 |
| Cost per passed attempt | $0.067 | $0.063 | $0.069 |

## Where mu doesn't come out ahead

- **A single attempt doesn't settle it.** Attempt 1 alone points the same way, but the difference isn't significant (p = 0.064 with Jev, 0.077 with mude). That's why every task ran three times.
- **mu isn't faster at a task.** On the tasks both passed, mu with Jev took 1.08 times as long as pi, and the interval includes 1. Some tasks were much slower: modernize-scientific-stack took 3.4 minutes against pi's 1.2 in attempt 1.
- **An attempt costs more.** With Jev, an attempt costs 14% more than pi's: the judge's calls and a longer request prefix. Because more attempts pass, the cost per passed attempt comes out about the same.
- **It loses some tasks.** Of the 5 tasks pi passed and mu with Jev didn't in attempt 1, 4 were mu running out of time: compile-compcert, large-scale-text-editing, regex-chess and video-processing.

## Method

- **Benchmark.** Terminal-Bench 2.1, all 89 tasks, downloaded with `harbor download terminal-bench/terminal-bench-2-1` and run with Harbor 0.24.0 in Docker. Each task runs with its own time limit, from 10 minutes to 3 hours 20 minutes (timeout multiplier 1). A timeout counts as a failure, as in Terminal-Bench.
- **One task left out.** pytorch-model-recovery is left out for every configuration. Its instruction starts with a dash, and in attempt 1 Harbor's pi command passed it without `--`, so neither pi nor mu ever saw it. That leaves 88 tasks.
- **Model.** MiMo v2.6 Pro (`xiaomi/mimo-v2.6-pro`) with reasoning effort high, for every configuration.
- **Control.** pi 1.4.0, as Harbor's pi agent installs it.
- **mu.** mu-agent 0.1.12, built on pi 1.3.0, installed from one fixed tarball for every attempt, with its default settings. Two judges:
  - **Jev 1.14**, hosted by TypeSafe: 2,303 verdicts, 0.2% of them falling back to mu's fixed rules.
  - **A pre-release build of mude**, served on the same Mac. It has 24 layers; mude 1.0 is the 20-layer model made from it, so these results aren't mude 1.0's. When its server couldn't be reached, mu fell back to its fixed rules: for 8.4% of its verdicts in attempt 1 and 2.6% in attempts 2 and 3.
- **Not measured.** mu 0.2.x, mude 1.0, other models and other benchmarks.
- **Attempts.** Three per task, from 2026-10-22 to 2026-10-24. Attempts 2 and 3 ran mu and pi at the same time, at the same concurrency: 3 tasks per configuration, then 2 once the Docker VM ran short of memory.
- **Reruns.** Only for infrastructure failures: Docker or disk errors, a judge server that couldn't be reached or failed half its verdicts, an agent still running into verification after its timeout, a verifier stuck cloning. The rules were set before the run and don't look at whether an attempt passed. In the last stretch of attempts 2 and 3 this reran 10 mu-with-mude attempts (6 of which had passed), 3 mu-with-Jev attempts and 1 pi attempt.
- **Machine.** One 16 GB Mac with Apple silicon. Terminal-Bench's images are x86_64 and run under Rosetta, which makes four tasks fail for every configuration: qemu-alpine-ssh and qemu-startup (Rosetta lacks `signalfd`, so qemu crashes) and path-tracing and path-tracing-reverse (the grader runs the program in a chroot without `/proc`). Absolute pass rates are about 4.5 points lower than on an x86_64 machine and can't be compared with the public leaderboard. The comparison with pi isn't affected: every configuration fails those tasks, apart from one mude attempt that got qemu-alpine-ssh working.
- **Time.** Harbor's agent execution time, from the agent's start to its end, without environment setup or verification. A timed-out attempt counts its full time limit.
- **Cost.** Recomputed from token counts at MiMo's list prices: $0.435 per million input tokens, $0.0036 per million cached input tokens and $0.87 per million output tokens. Jev is added at $0.042 per million input tokens. The local mude build counts as $0, without its compute.

## Statistics

- **Pass rate.** For each task, the share of its three attempts that passed; then the mean over the 88 tasks. With three attempts everywhere, that equals attempts passed ÷ 264.
- **Interval.** The difference from pi is paired by task, with a 95% interval from 10,000 bootstrap resamples of the 88 tasks.
- **Tasks won and lost.** A task counts for mu when its pass rate is higher than pi's on that task, and against it when lower. Ties are left out of the two-sided sign test.
- **Attempt 1.** Compared with an exact McNemar test on the tasks only one side passed: 14 against 5 for mu with Jev, 12 against 4 for mu with mude.
- **Time ratio.** On tasks both sides passed at least once, each side's median time over its passing attempts. The paired ratio is a geometric mean, with a bootstrap interval.

## The per-task file

[terminal-bench-2.1.csv](terminal-bench-2.1.csv) has one row per task: its agent time limit in seconds, then each configuration's three attempts as `1` (passed) or `0` (failed or timed out), in order. `rosetta` marks the four tasks Rosetta breaks. The counts, pass rates and tests above can be recomputed from it alone.

## Reproducing it

Each configuration ran as one Harbor job per attempt round, in this shape:

```bash
harbor download terminal-bench/terminal-bench-2-1 -o tb21
harbor run -p tb21/terminal-bench-2-1 -a <agent> -m xiaomi/mimo-v2.6-pro -n <concurrency> -e docker \
  --job-name <job> --plugin <stop-the-agent-at-timeout plugin>
```

pi is Harbor's own pi agent. mu ran through a small Harbor agent that installs mu-agent from a tarball and runs `mu` with pi's arguments. That adapter and the plugin, which stops an agent's process when its time runs out, aren't in this repository yet.
