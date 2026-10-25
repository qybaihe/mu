"""mu as a Harbor agent: pi's adapter with the judgment kernel on, and pi as the baseline it is compared with.

mu is pi plus one extension, so it runs the way Harbor's `pi` agent does (`--print --mode json`, the same session
files, the same trajectory and token accounting) with these differences:

- It installs `mu-agent` instead of pi: from npm (`--ak version=0.1.12`), or from a tarball on this machine
  (`--ak tarball=/path/mu-agent-0.1.12.tgz`) to test a build before it is published.
- It runs in full access (`MU_PERMISSIONS=full`). Headless, mu refuses what it would ask you about; every harness in
  the comparison runs unattended.
- It tells mu the trial's time budget (`MU_TIME_BUDGET_S`, the agent timeout less a little for startup): mu
  0.1.13 and later cut a reply that only thinks in time for its retry, and tell the model at 50% and 80% of the budget
  how much time is left. Older builds ignore the variable: the Terminal-Bench 2.1 run in docs/benchmarks used 0.1.12,
  so neither mu nor pi knew its time limit there.
- The judge's calls are counted. Each verdict is a `kyrn.decision` entry in the session file with the judge's tokens;
  they are added to the run's usage under the judge's model, priced at Jev's list price, and the metadata says how
  many verdicts there were and how many fell back to the default because the judge didn't answer.
- Spend no assistant message carries is counted too: a reply the watchdog cut (the aborted request reports no usage)
  and the sub-agents of `delegate` and `hive` (they keep no session). mu records both as `kyrn.usage` entries
  (kyrn/docs/features/usage-accounting.md); for a session from a build before those, the same is worked out from the
  session (`_derived_usage`). They are added to the run's tokens and cost, and listed in `metadata.unrecorded`.

    PYTHONPATH=. harbor run -p tb21/terminal-bench-2-1 -a bench.harbor.mu_agent:Mu --ak tarball=mu-agent-0.1.12.tgz \
      -m xiaomi/mimo-v2.6-pro -e docker --env-file bench.env --plugin bench.harbor.kill_on_timeout:KillAgentAtPhaseEnd

bench/harbor/README.md has the whole run.
"""

import json
import math
import shlex
import tomllib
from pathlib import Path
from typing import Any, override

from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.installed.pi import _PI_CONFIG_DIR_ENV, _REMOTE_PI_CONFIG_DIR, Pi, PiOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext, ModelUsage
from pydantic import Field

# Jev's list price (OpenRouter, Vercel AI Gateway, OpenCode): $0.042 per million input tokens, output free.
JEV_INPUT_USD_PER_TOKEN = 0.042 / 1_000_000
# mu's estimate of a cut reply's output: characters of streamed reasoning per token (kyrn-judge src/usage.ts).
REASONING_CHARS_PER_TOKEN = 3.5
_TOKEN_FIELDS = ("input", "output", "cacheRead", "cacheWrite")
# List prices in USD per million tokens, for a run whose session has no priced message to take the rates from (its
# only reply was cut, say).
_LIST_PRICES = {"xiaomi/mimo-v2.6-pro": {"input": 0.435, "output": 0.87, "cacheRead": 0.0036, "cacheWrite": 0.0}}
_REMOTE_TARBALL = "/tmp/mu-agent.tgz"
# What the time budget leaves for the time between the agent phase starting and mu's process starting.
_BUDGET_SLACK_S = 15
# Provider keys Harbor does not map to their provider (it knows xiaomi/... models but not XIAOMI_API_KEY).
_PROVIDER_KEYS = ("XIAOMI_API_KEY",)
_PI_COMMAND = "pi --print --mode json "
# What Harbor's pi command puts right after the instruction.
_PI_OUTPUT = " 2>&1 </dev/null | "


def end_of_options(command: str) -> str:
    """Harbor's pi command with `--` before the instruction, as its codex and opencode commands have it.

    pi (and so mu) reads an argument that starts with "-" as an option: pytorch-model-recovery's instruction, a list
    whose first line starts with "- ", ended the run at once with "Unknown option" and exit 1, before the agent ran. The instruction is the last word before the output pipe; it is found by quoting it again the way
    Harbor quoted it, and anything that does not match is left as it is.
    """
    start = command.find(_PI_COMMAND)
    end = command.find(_PI_OUTPUT, start)
    if start == -1 or end == -1:
        return command
    try:
        words = shlex.split(command[start:end])
    except ValueError:
        return command
    if len(words) < 2 or words[-2] == "--":
        return command
    quoted = shlex.quote(words[-1])
    if not command[:end].endswith(f" {quoted}"):
        return command
    at = end - len(quoted)
    return f"{command[:at]}-- {command[at:]}"


class PiBaseline(Pi):
    """Harbor's pi, with the provider keys above passed to it: the baseline mu is compared against."""

    @override
    async def exec_as_agent(
        self,
        environment: BaseEnvironment,
        command: str,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        timeout_sec: int | None = None,
    ) -> Any:
        if _PI_COMMAND in command:
            command = end_of_options(command)
            env = {**(env or {}), **{name: v for name in _PROVIDER_KEYS if (v := self._get_env(name)) is not None}}
        return await super().exec_as_agent(environment, command, env=env, cwd=cwd, timeout_sec=timeout_sec)


class MuOptions(PiOptions):
    tarball: str | None = Field(default=None, description="A local mu-agent tarball to install instead of npm's.")
    permissions: str = Field(default="full", description="MU_PERMISSIONS: full, jev or ask.")
    judge_url: str | None = Field(
        default=None,
        description="A System One endpoint (`.../v1/systemone`) to add as a judge; its key comes from MU_BENCH_JUDGE_KEY.",
    )
    judge_name: str = Field(default="mude", description="The name of the judge at judge_url; MU_JUDGE can list it.")
    record_state: bool = Field(
        default=False,
        description="Keep each judged state in the decision entries (mu.json recordState). It changes nothing mu does.",
    )
    time_budget: bool = Field(
        default=True,
        description="Pass the trial's agent timeout to mu as MU_TIME_BUDGET_S (less a little for startup).",
    )


def trial_time_budget_s(environment: BaseEnvironment) -> int | None:
    """The trial's agent timeout as Harbor resolves it (task.toml or the override, capped, times the multiplier), less
    `_BUDGET_SLACK_S`. None when it cannot be read or the agent has no timeout."""
    try:
        config = json.loads(environment.trial_paths.config_path.read_text())
        agent = config.get("agent") or {}
        base = agent.get("override_timeout_sec")
        if base is None:
            task = tomllib.loads((Path(config["task"]["path"]) / "task.toml").read_text())
            base = (task.get("agent") or {}).get("timeout_sec")
        if base is None:
            return None
        if (cap := agent.get("max_timeout_sec")) is not None:
            base = min(float(base), float(cap))
        multiplier = config.get("agent_timeout_multiplier") or config.get("timeout_multiplier") or 1.0
        return max(60, int(float(base) * float(multiplier)) - _BUDGET_SLACK_S)
    except (OSError, KeyError, TypeError, ValueError, tomllib.TOMLDecodeError):
        return None


class Mu(Pi):
    options_model = MuOptions
    options: MuOptions

    @staticmethod
    @override
    def name() -> str:
        return "mu"

    @override
    def get_version_command(self) -> str | None:
        return ". ~/.nvm/nvm.sh; mu --version"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(environment, ("curl", "git"))
        if self.options.tarball:
            await environment.upload_file(Path(self.options.tarball).expanduser(), _REMOTE_TARBALL)
            package = _REMOTE_TARBALL
        else:
            package = f"mu-agent@{self._version or 'latest'}"
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                f"npm install -g {shlex.quote(package)} && "
                "mu --version"
            ),
        )

    @override
    async def exec_as_agent(
        self,
        environment: BaseEnvironment,
        command: str,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        timeout_sec: int | None = None,
    ) -> Any:
        # pi's run() builds the command for `pi`; mu takes the same arguments.
        if _PI_COMMAND in command:
            command = end_of_options(command).replace(_PI_COMMAND, "mu --print --mode json ", 1)
            # mu reads its config directory from MU_CODING_AGENT_DIR (pi's name for it would be ignored).
            isolated = f"{_PI_CONFIG_DIR_ENV}=" in command
            command = command.replace(f"{_PI_CONFIG_DIR_ENV}=", "MU_CODING_AGENT_DIR=")
            if self.options.judge_url or self.options.record_state:
                config_dir = shlex.quote(_REMOTE_PI_CONFIG_DIR.as_posix()) if isolated else "$HOME/.mu/agent"
                command = f"{self._config_command(config_dir)} && {command}"
            env = {**(env or {}), "MU_PERMISSIONS": self.options.permissions}
            if self.options.time_budget and (budget := trial_time_budget_s(environment)) is not None:
                env["MU_TIME_BUDGET_S"] = str(budget)
            for name in (
                *_PROVIDER_KEYS,
                "TYPESAFE_API_KEY",
                "MU_JUDGE",
                "MU_JUDGE_OPENROUTER_API_KEY",
                "OPENCODE_API_KEY",
                "MU_BENCH_JUDGE_KEY",
            ):
                if (value := self._get_env(name)) is not None:
                    env[name] = value
        return await super().exec_as_agent(environment, command, env=env, cwd=cwd, timeout_sec=timeout_sec)

    def _config_command(self, config_dir: str) -> str:
        """Writes mu.json: the judge at judge_url (answering alone unless MU_JUDGE lists other tiers) and recordState."""
        config: dict[str, Any] = {}
        if self.options.judge_url:
            config["judges"] = {
                self.options.judge_name: {
                    "type": "typesafe",
                    "baseUrl": self.options.judge_url,
                    # Without a model the judge is recorded as jev-latest, and its tokens would be priced as Jev's.
                    "model": self.options.judge_name,
                    "apiKeyEnv": "MU_BENCH_JUDGE_KEY",
                }
            }
            config["tiers"] = [self.options.judge_name]
        if self.options.record_state:
            config["recordState"] = True
        path = f"{config_dir}/mu.json"
        return f"mkdir -p {config_dir} && printf '%s' {shlex.quote(json.dumps(config))} > {path}"

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        super().populate_context_post_run(context)
        try:
            self._add_unrecorded(context)
        except Exception:
            # Accounting must never cost a trial its result.
            self.logger.exception("Failed to add mu's unrecorded usage")
        judge = self._judge_usage()
        if judge is None:
            return
        model, usage, counts = judge
        context.model_usage = {**(context.model_usage or {}), model: usage}
        context.cost_usd = (context.cost_usd or 0.0) + (usage.cost_usd or 0.0)
        context.metadata = {**(context.metadata or {}), "judge": usage.model_dump() | {"model": model} | counts}

    def _session_entries(self) -> list[list[dict[str, Any]]]:
        """Every session file of this run, as its entries in file order."""
        sessions = self.logs_dir / self._SESSIONS_DIRECTORY
        if not sessions.is_dir():
            return []
        files = []
        for path in sorted(sessions.rglob("*.jsonl")):
            entries = []
            for line in path.read_text(errors="replace").splitlines():
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if isinstance(entry, dict):
                    entries.append(entry)
            files.append(entries)
        return files

    @staticmethod
    def _number(value: Any) -> float:
        return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else 0.0

    @classmethod
    def _main_rates(cls, files: list[list[dict[str, Any]]]) -> dict[str, float]:
        """USD per token of the main model, per token field, from what its own messages were priced at."""
        tokens = dict.fromkeys(_TOKEN_FIELDS, 0.0)
        dollars = dict.fromkeys(_TOKEN_FIELDS, 0.0)
        for entries in files:
            for entry in entries:
                message = entry.get("message") if entry.get("type") == "message" else None
                if not isinstance(message, dict) or message.get("role") != "assistant":
                    continue
                usage = message.get("usage") or {}
                cost = usage.get("cost") or {}
                if not isinstance(cost, dict):
                    continue
                for field in _TOKEN_FIELDS:
                    tokens[field] += cls._number(usage.get(field))
                    dollars[field] += cls._number(cost.get(field))
        return {field: dollars[field] / tokens[field] if tokens[field] else 0.0 for field in _TOKEN_FIELDS}

    def _rates(self, files: list[list[dict[str, Any]]]) -> dict[str, float] | None:
        """The main model's USD per token: what its messages were priced at, or its list price. None when unknown."""
        rates = self._main_rates(files)
        if any(rates.values()):
            return rates
        listed = _LIST_PRICES.get(self.model_name or "")
        return {field: listed[field] / 1_000_000 for field in _TOKEN_FIELDS} if listed else None

    @classmethod
    def _derived_usage(cls, entries: list[dict[str, Any]], sources: set[str]) -> list[dict[str, Any]]:
        """What a build before `kyrn.usage` entries spent outside its messages, worked out the way mu now records it:
        a cut reply (an aborted message followed by the watchdog's `kyrn.watchdog` message) from its reasoning at
        `REASONING_CHARS_PER_TOKEN`, less the output it reported; a sub-agent from the usage in the snapshot its
        `delegate` or `hive` result keeps. Only for a source the session has no entry of."""
        derived: list[dict[str, Any]] = []
        aborted: dict[str, Any] | None = None
        for entry in entries:
            kind = entry.get("type")
            message = entry.get("message") if kind == "message" else None
            if isinstance(message, dict) and message.get("role") == "assistant":
                aborted = message if message.get("stopReason") in ("aborted", "error") else None
            elif kind == "custom_message" and entry.get("customType") == "kyrn.watchdog" and aborted is not None:
                if "watchdog-cut" not in sources:
                    chars = sum(
                        len(block.get("thinking") or "")
                        for block in aborted.get("content") or []
                        if isinstance(block, dict) and block.get("type") == "thinking"
                    )
                    reported = cls._number((aborted.get("usage") or {}).get("output"))
                    output = max(0, math.ceil(chars / REASONING_CHARS_PER_TOKEN) - int(reported)) if chars else 0
                    if output > 0:
                        derived.append(
                            {
                                "source": "watchdog-cut",
                                "model": f"{aborted.get('provider')}/{aborted.get('model')}",
                                "input": 0,
                                "output": output,
                                "cacheRead": 0,
                                "cacheWrite": 0,
                                "estimated": True,
                                "estimatedOutput": output,
                                "thoughtChars": chars,
                                "derived": True,
                            }
                        )
                aborted = None
            if (
                "subagent" not in sources
                and isinstance(message, dict)
                and message.get("role") == "toolResult"
                and message.get("toolName") in ("delegate", "hive")
            ):
                snapshot = (message.get("details") or {}).get("snapshot") or {}
                for bee in snapshot.get("bees") or []:
                    if not isinstance(bee, dict) or bee.get("startedAt") is None:
                        continue
                    usage = bee.get("usage") or {}
                    derived.append(
                        {
                            "source": "subagent",
                            "kind": message.get("toolName"),
                            "name": bee.get("name"),
                            "model": bee.get("model"),
                            **{field: cls._number(usage.get(field)) for field in _TOKEN_FIELDS},
                            "cost": cls._number(usage.get("cost")),
                            "status": bee.get("status"),
                            **({} if bee.get("status") == "done" else {"partial": True}),
                            "derived": True,
                        }
                    )
        return derived

    def _add_unrecorded(self, context: AgentContext) -> None:
        """Adds what mu spent outside the session's messages to the run's tokens and cost, and says what in
        `metadata.unrecorded`. An item without a cost of its own is priced at the main model's rates."""
        files = self._session_entries()
        items: list[dict[str, Any]] = []
        for entries in files:
            recorded = [
                entry["data"]
                for entry in entries
                if entry.get("type") == "custom"
                and entry.get("customType") == "kyrn.usage"
                and isinstance(entry.get("data"), dict)
            ]
            items += recorded
            items += self._derived_usage(entries, {str(item.get("source")) for item in recorded})
        if not items:
            return
        rates = self._rates(files)
        groups = {"watchdog-cut": "watchdog_cut", "subagent": "subagents"}
        unrecorded: dict[str, dict[str, Any]] = {}
        for item in items:
            name = groups.get(str(item.get("source")))
            if name is None:
                continue
            tokens = {field: self._number(item.get(field)) for field in _TOKEN_FIELDS}
            cost = item.get("cost")
            priced = isinstance(cost, int | float) or rates is not None
            if isinstance(cost, int | float):
                cost_usd = self._number(cost)
            elif rates is not None:
                cost_usd = sum(tokens[field] * rates[field] for field in _TOKEN_FIELDS)
            else:
                cost_usd = 0.0
            group = unrecorded.setdefault(
                name,
                {
                    "count": 0,
                    "n_input_tokens": 0,
                    "n_cache_tokens": 0,
                    "n_output_tokens": 0,
                    "cost_usd": 0.0,
                    "estimated_output_tokens": 0,
                    "partial": 0,
                    "derived": 0,
                    "unpriced": 0,
                    "models": [],
                },
            )
            group["count"] += 1
            # As Harbor counts them: input includes the cached part.
            group["n_input_tokens"] += int(tokens["input"] + tokens["cacheRead"] + tokens["cacheWrite"])
            group["n_cache_tokens"] += int(tokens["cacheRead"])
            group["n_output_tokens"] += int(tokens["output"])
            group["cost_usd"] += cost_usd
            group["estimated_output_tokens"] += int(self._number(item.get("estimatedOutput")))
            group["partial"] += 1 if item.get("partial") else 0
            group["derived"] += 1 if item.get("derived") else 0
            group["unpriced"] += 0 if priced else 1
            if (model := item.get("model")) and model not in group["models"]:
                group["models"].append(model)
        if not unrecorded:
            return
        context.n_input_tokens = (context.n_input_tokens or 0) + sum(g["n_input_tokens"] for g in unrecorded.values())
        context.n_cache_tokens = (context.n_cache_tokens or 0) + sum(g["n_cache_tokens"] for g in unrecorded.values())
        context.n_output_tokens = (context.n_output_tokens or 0) + sum(
            g["n_output_tokens"] for g in unrecorded.values()
        )
        context.cost_usd = (context.cost_usd or 0.0) + sum(g["cost_usd"] for g in unrecorded.values())
        context.metadata = {**(context.metadata or {}), "unrecorded": unrecorded}

    def _judge_usage(self) -> tuple[str, ModelUsage, dict[str, Any]] | None:
        """The judge's tokens and verdicts, from the `kyrn.decision` entries of this run's session files."""
        sessions = self.logs_dir / self._SESSIONS_DIRECTORY
        if not sessions.is_dir():
            return None
        input_tokens = output_tokens = billed_tokens = verdicts = fallbacks = 0
        reasons: dict[str, int] = {}
        models: set[str] = set()
        for path in sorted(sessions.rglob("*.jsonl")):
            for line in path.read_text(errors="replace").splitlines():
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if entry.get("type") != "custom" or entry.get("customType") != "kyrn.decision":
                    continue
                record = entry.get("data") or {}
                verdicts += 1
                usage = record.get("usage") or {}
                tokens = int(usage.get("inputTokens") or 0)
                input_tokens += tokens
                output_tokens += int(usage.get("outputTokens") or 0)
                if model := record.get("modelId"):
                    models.add(str(model))
                    # Only Jev is billed; a judge served on our own hardware costs nothing per token.
                    if "jev" in str(model).lower():
                        billed_tokens += tokens
                if record.get("source") == "fallback" and record.get("reason") != "shadow":
                    fallbacks += 1
                    reason = str(record.get("reason") or "unknown")
                    reasons[reason] = reasons.get(reason, 0) + 1
        if verdicts == 0:
            return None
        usage = ModelUsage(
            n_input_tokens=input_tokens,
            n_output_tokens=output_tokens,
            cost_usd=billed_tokens * JEV_INPUT_USD_PER_TOKEN,
        )
        model = "+".join(sorted(models)) or "unknown"
        return f"judge/{model}", usage, {"verdicts": verdicts, "fallbacks": fallbacks, "fallback_reasons": reasons}
