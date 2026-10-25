"""A Harbor job plugin that stops the agent when its phase ends, before verification starts.

Harbor enforces the agent timeout by cancelling its own `docker exec` call; the agent process inside the container
keeps running, so on a timeout the agent goes on editing files while the verifier grades them (seen on TB 2.1: 10 of
17 timed-out mu trials kept running, and one deleted and recreated the graded repository mid-verification).

At the end of every agent phase this kills the agent's own CLI process (mu or pi) inside the trial's container. Processes the agent started and left running, such as a server the task asks for,
are not touched, as in Terminal-Bench's own harness. Docker environments only.

    harbor run ... --plugin bench.harbor.kill_on_timeout:KillAgentAtPhaseEnd
"""

import asyncio
import re
from typing import Any

from harbor.models.job.plugin import BaseJobPlugin
from harbor.trial.hooks import TrialHookEvent

# Command lines of the agent CLIs, as Harbor launches them.
_AGENT_PATTERNS = (
    "mu --print --mode json",
    "pi --print --mode json",
)
_KILL_SCRIPT = (
    "for d in /proc/[0-9]*; do "
    'cmd=$(tr "\\000" " " < "$d/cmdline" 2>/dev/null) || continue; '
    # This script's own shell holds the patterns in its command line: skip it.
    'case "$cmd" in *"/proc/[0-9]"*) continue;; esac; '
    'case "$cmd" in ' + "|".join(f'*"{p}"*' for p in _AGENT_PATTERNS) + ') kill -9 "${d#/proc/}" 2>/dev/null; echo "${d#/proc/}";; esac; '
    "done"
)


def compose_project(trial_name: str) -> str:
    """The Docker Compose project Harbor runs a trial's environment under, by Harbor's own rule
    (environments/docker/docker.py, _sanitize_docker_compose_project_name): lowercase, every character other than
    a-z, 0-9, "-" and "_" replaced by "-". A task name with a dot (install-windows-3.11) therefore runs as
    install-windows-3-11__<id>__env; looking for the dotted name found no container, and the agent was not stopped."""
    name = f"{trial_name}__env".lower()
    if not re.match(r"^[a-z0-9]", name):
        name = "0" + name
    return re.sub(r"[^a-z0-9_-]", "-", name)


class KillAgentAtPhaseEnd(BaseJobPlugin):
    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)

    async def on_job_start(self, job: Any) -> None:
        job.on_agent_ended(self._stop_agent)

    async def on_job_end(self, job_result: Any) -> None:
        return None

    async def _stop_agent(self, event: TrialHookEvent) -> None:
        project = compose_project(event.trial_name)
        find = await asyncio.create_subprocess_exec(
            "docker", "ps", "-q", "--filter", f"label=com.docker.compose.project={project}",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await find.communicate()
        for container in out.decode().split():
            kill = await asyncio.create_subprocess_exec(
                "docker", "exec", container, "sh", "-c", _KILL_SCRIPT,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
            await kill.communicate()
