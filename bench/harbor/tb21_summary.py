"""The numbers in docs/benchmarks/terminal-bench-2.1.md, from the per-task CSV or from Harbor's job directories.

Check the published numbers from the CSV alone:

    python3 bench/harbor/tb21_summary.py docs/benchmarks/terminal-bench-2.1.csv

Or write the CSV from your own run first. Each configuration is a column name and the Harbor jobs of its attempts, in
order (attempt 1, then the job that ran attempts 2 and 3):

    python3 bench/harbor/tb21_summary.py out.csv --dataset tb21/terminal-bench-2-1 --jobs jobs \\
        --config mu_jev_attempts=tb21-mu-jev,tb21-mu-jev-k23 --config pi_attempts=tb21-pi,tb21-pi-k23

Each attempt is one letter: P passed, p passed after hitting its time limit (Harbor runs the tests anyway), T failed
after hitting its time limit, F failed. The last column given with --config, or pi_attempts in a CSV, is the
baseline. Standard library only.
"""

import argparse
import csv
import json
import random
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

BASELINE = "pi_attempts"
# Its instruction starts with a dash, and Harbor's pi command passed it without `--` in the first runs, so neither pi
# nor mu saw it. Left out for every configuration.
EXCLUDED = {"pytorch-model-recovery"}
RESAMPLES = 10_000


def seconds(span):
    if not span or not span.get("started_at") or not span.get("finished_at"):
        return None
    parse = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
    return (parse(span["finished_at"]) - parse(span["started_at"])).total_seconds()


def letter(result):
    passed = ((result.get("verifier_result") or {}).get("rewards") or {}).get("reward") == 1.0
    timed_out = (result.get("exception_info") or {}).get("exception_type") == "AgentTimeoutError"
    return ("p" if timed_out else "P") if passed else ("T" if timed_out else "F")


def from_jobs(jobs, dataset, configs):
    """task -> column -> attempts, in the order of the jobs; and task -> column -> agent seconds."""
    letters = defaultdict(dict)
    times = defaultdict(dict)
    for column, names in configs:
        for name in names:
            for path in sorted((jobs / name).glob("*__*/result.json")):
                result = json.loads(path.read_text())
                if not result.get("finished_at"):
                    continue
                task = result["task_name"].split("/")[-1]
                letters[task][column] = letters[task].get(column, "") + letter(result)
                times[task][column] = times[task].get(column, 0.0) + (seconds(result.get("agent_execution")) or 0.0)
    limits = {}
    for task in letters:
        found = re.search(r"\[agent\][^\[]*?timeout_sec\s*=\s*([0-9.]+)", (dataset / task / "task.toml").read_text(), re.S)
        limits[task] = int(float(found.group(1))) if found else ""
    return letters, times, limits


def write_csv(path, letters, limits, columns, notes):
    with open(path, "w", newline="") as file:
        out = csv.writer(file, lineterminator="\n")
        out.writerow(["task", "agent_time_limit_s", *columns, "note"])
        for task in sorted(letters):
            out.writerow([task, limits[task], *(letters[task].get(c, "") for c in columns), notes.get(task, "")])


def read_csv(path):
    with open(path, newline="") as file:
        rows = list(csv.DictReader(file))
    columns = [c for c in rows[0] if c.endswith("_attempts")]
    return {row["task"]: {c: row[c] for c in columns} for row in rows}, columns


def summarize(letters, columns, baseline, times=None):
    tasks = sorted(t for t in letters if t not in EXCLUDED and all(letters[t].get(c) for c in columns))
    rate = {c: {t: sum(a in "Pp" for a in letters[t][c]) / len(letters[t][c]) for t in tasks} for c in columns}
    print(f"{len(tasks)} tasks (left out: {', '.join(sorted(EXCLUDED))})\n")
    for c in columns:
        attempts = "".join(letters[t][c] for t in tasks)
        passed = sum(a in "Pp" for a in attempts)
        line = (
            f"{c}: {passed} of {len(attempts)} attempts passed ({passed / len(attempts):.1%}); "
            f"hit the time limit {sum(a in 'pT' for a in attempts)} (of which passed {attempts.count('p')}); "
            f"failed after the limit {attempts.count('T')}, failed otherwise {attempts.count('F')}"
        )
        if times:
            hours = sum(times[t][c] for t in tasks) / 3600
            line += f"; agent time {hours:.1f} h, {hours * 60 / max(passed, 1):.1f} min per passed attempt"
        print(line)
    random.seed(0)
    for c in columns:
        if c == baseline:
            continue
        diff = [rate[c][t] - rate[baseline][t] for t in tasks]
        mean = sum(diff) / len(diff)
        boots = sorted(sum(random.choice(diff) for _ in diff) / len(diff) for _ in range(RESAMPLES))
        low, high = boots[int(0.025 * RESAMPLES)], boots[int(0.975 * RESAMPLES) - 1]
        won, lost = sum(d > 0 for d in diff), sum(d < 0 for d in diff)
        print(
            f"\n{c} vs {baseline}: {mean * 100:+.1f} points (95% interval {low * 100:+.1f} to {high * 100:+.1f}, "
            f"{RESAMPLES:,} task resamples); higher pass rate on {won} tasks, lower on {lost}"
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("csv", type=Path, help="the per-task CSV: read it, or write it when --jobs is given")
    parser.add_argument("--jobs", type=Path, help="Harbor's jobs directory")
    parser.add_argument("--dataset", type=Path, help="the terminal-bench-2-1 task directory, for the time limits")
    parser.add_argument("--config", action="append", default=[], help="column=job[,job...], attempt order")
    args = parser.parse_args()
    times = None
    if args.jobs:
        if not args.dataset or not args.config:
            parser.error("--jobs needs --dataset and at least one --config")
        configs = [(spec.split("=", 1)[0], spec.split("=", 1)[1].split(",")) for spec in args.config]
        columns = [c for c, _ in configs]
        letters, times, limits = from_jobs(args.jobs, args.dataset, configs)
        write_csv(args.csv, letters, limits, columns, {})
        print(f"wrote {args.csv}\n")
        baseline = columns[-1]
    else:
        letters, columns = read_csv(args.csv)
        baseline = BASELINE if BASELINE in columns else columns[-1]
    summarize(letters, columns, baseline, times)


if __name__ == "__main__":
    sys.exit(main())
