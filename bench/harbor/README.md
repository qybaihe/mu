# Running mu and pi on Terminal-Bench with Harbor

This is what ran the comparison in [docs/benchmarks/terminal-bench-2.1.md](../../docs/benchmarks/terminal-bench-2.1.md):

- `mu_agent.py`: `Mu`, mu as a Harbor agent (pi's adapter, installing mu-agent and running `mu`), and `PiBaseline`, Harbor's pi with the provider key passed through.
- `kill_on_timeout.py`: a Harbor plugin that stops the agent's process when its time runs out, before the tests run. Without it, Harbor cancels its own `docker exec` and the agent keeps editing files while they're graded.
- `tb21_summary.py`: recomputes the published numbers from the per-task CSV, or writes that CSV from your own run.

## Check the published numbers

```bash
python3 bench/harbor/tb21_summary.py docs/benchmarks/terminal-bench-2.1.csv
```

## Run it yourself

You need Harbor 0.24.0, Docker, Node.js 24 and a MiMo API key. A Jev key is optional: without one, mu uses the free Jev on OpenCode Zen. Put the keys in an env file that stays out of the repository:

```bash
# bench.env
XIAOMI_API_KEY=...
TYPESAFE_API_KEY=...
```

The run used mu-agent 0.1.12 with the fixes for unattended runs that later shipped in 0.1.13. That build isn't on npm: build it from commit `ea9d27188` the way CI does. CI's own build of it, used in the published run, has the sha256 `151b3e70e33bc4d8de97288d088a010964866a97b25ea8ea4be9904bde2f8b9b`.

```bash
git checkout ea9d27188
npm ci --ignore-scripts && npm run build:pinned && node kyrn/npm/build.mjs --pack   # .artifacts/npm/mu-agent-0.1.12.tgz
```

Download the tasks, then run one Harbor job per configuration and attempt round from the repository's root. Attempt 1 is `-k 1`; attempts 2 and 3 are a second job with `-k 2`.

```bash
harbor download terminal-bench/terminal-bench-2-1 -o tb21

PYTHONPATH=. harbor run -p tb21/terminal-bench-2-1 -a bench.harbor.mu_agent:Mu --ak tarball=/path/to/mu-agent-0.1.12.tgz \
  -m xiaomi/mimo-v2.6-pro -k 1 -n 2 -e docker --env-file bench.env -o jobs --job-name tb21-mu-jev \
  --plugin bench.harbor.kill_on_timeout:KillAgentAtPhaseEnd

PYTHONPATH=. harbor run -p tb21/terminal-bench-2-1 -a bench.harbor.mu_agent:PiBaseline --ak version=1.4.0 \
  -m xiaomi/mimo-v2.6-pro -k 1 -n 2 -e docker --env-file bench.env -o jobs --job-name tb21-pi \
  --plugin bench.harbor.kill_on_timeout:KillAgentAtPhaseEnd
```

Run mu and pi at the same concurrency (`-n`) and at the same time, so a slow stretch at the model's provider hits both. To use a judge you serve yourself, add `--ak judge_url=http://host.docker.internal:8790/v1/systemone` and put its key in `MU_BENCH_JUDGE_KEY`.

Then write the CSV and the summary:

```bash
python3 bench/harbor/tb21_summary.py my-run.csv --jobs jobs --dataset tb21/terminal-bench-2-1 \
  --config mu_jev_attempts=tb21-mu-jev,tb21-mu-jev-k23 --config pi_attempts=tb21-pi,tb21-pi-k23
```

## Notes

- `--ak version=<x>` installs a published mu-agent from npm instead of a tarball. From 0.1.13, mu reads `MU_TIME_BUDGET_S`, which the adapter sets to the trial's time limit, and paces itself; 0.1.12 and pi don't know their limit.
- On a Mac with Apple silicon, Terminal-Bench's x86_64 images run under Rosetta, and four tasks fail for every configuration: qemu-alpine-ssh, qemu-startup, path-tracing and path-tracing-reverse. An x86_64 host doesn't have this.
- Harbor resumes an interrupted job with `harbor job resume -p jobs/<job>`. It refuses a job whose concurrency or retry settings changed since it started.
