import { spawn, spawnSync } from "node:child_process";

/**
 * Ending a process and everything it started, the same way on every caller:
 * the background jobs, and the programs the packs run (git runs hooks, and a
 * hook starts what it likes).
 */
export type KillStep =
	| { readonly kind: "signal"; readonly pid: number; readonly signal: "SIGTERM" | "SIGKILL" }
	| { readonly kind: "exec"; readonly file: string; readonly args: readonly string[] };

/**
 * How to end a job and everything it started. POSIX: a signal to the process
 * group (the negative pid). Windows has no groups: `taskkill /T` walks the
 * tree, asking first and with `/F` forcing.
 */
export function killPlan(
	pid: number,
	force: boolean,
	platform: NodeJS.Platform,
	systemRoot: string = process.env.SystemRoot ?? "C:\\Windows",
): KillStep {
	if (platform !== "win32") return { kind: "signal", pid: -pid, signal: force ? "SIGKILL" : "SIGTERM" };
	return {
		kind: "exec",
		file: taskkill(systemRoot),
		args: force ? ["/T", "/F", "/PID", String(pid)] : ["/T", "/PID", String(pid)],
	};
}

/** Windows: `taskkill /T /F` for several processes at once, each with what it started. */
export function killAllPlan(
	pids: readonly number[],
	systemRoot: string = process.env.SystemRoot ?? "C:\\Windows",
): KillStep {
	return {
		kind: "exec",
		file: taskkill(systemRoot),
		args: ["/T", "/F", ...pids.flatMap((pid) => ["/PID", String(pid)])],
	};
}

// The trusted System32 binary, so that cleanup does not depend on PATH.
const taskkill = (systemRoot: string) => `${systemRoot}\\System32\\taskkill.exe`;

/** Never throws: a process that is already gone is the outcome that was asked for. */
export function runKillStep(step: KillStep): void {
	try {
		if (step.kind === "exec") {
			const child = spawn(step.file, [...step.args], { stdio: "ignore", detached: true, windowsHide: true });
			child.once("error", () => {});
			child.unref();
			return;
		}
		try {
			process.kill(step.pid, step.signal);
		} catch {
			// No group under that id (the shell was not a group leader): the process itself, then.
			if (step.pid < 0) process.kill(-step.pid, step.signal);
		}
	} catch {
		/* gone already */
	}
}

/** POSIX only: whether anything is left in the job's process group. */
export function groupAlive(pid: number, platform: NodeJS.Platform): boolean {
	if (platform === "win32") return false;
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Windows with Git Bash (MSYS2, or Cygwin): the job's processes, as MSYS has them.
 *
 * `taskkill /T` follows parent pids, and through Git Bash a script with a `#!` line (npm, npx, pnpm, yarn) runs in a
 * process whose parent has already exited: MSYS execs it through /usr/bin/env, and an exec there starts a new
 * Windows process and ends the old one. So npm, the cmd.exe it starts and the script were out of a stop's reach and
 * went on in the project's folder. MSYS keeps its own process groups across those execs: everything the job's bash
 * starts, a native program too (npm's node.exe), stays in the group of that bash, whose pid (`$$`) the job writes down
 * when it starts (shell.ts). Its `ps` lists each one's Windows pid; what a native program starts in turn (npm's cmd.exe
 * and the script) is below that pid, where `taskkill /T` finds it.
 *
 * Reads `ps -l` ("PID PPID PGID WINPID TTY UID STIME COMMAND", a status letter before some lines): the Windows pids
 * of the processes in group `pgid`.
 */
export function groupWindowsPids(psOutput: string, pgid: number): number[] {
	const pids: number[] = [];
	for (const line of psOutput.split(/\r?\n/)) {
		const row = /^\s*[A-Z]?\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(line);
		if (row && Number(row[3]) === pgid) pids.push(Number(row[4]));
	}
	return pids;
}

/** Runs MSYS's `ps` (`ps.exe` beside the shell's bash) for the Windows pids of group `pgid`; none when it cannot. */
export function msysGroup(ps: string, pgid: number): number[] {
	const answer = spawnSync(ps, ["-l"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
	return answer.status === 0 ? groupWindowsPids(answer.stdout, pgid) : [];
}
