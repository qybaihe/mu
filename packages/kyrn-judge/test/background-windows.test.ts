import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobManager } from "../src/background/jobs.ts";
import { planSpawn, resolveShell } from "../src/background/shell.ts";
import { msysGroup } from "../src/process-tree.ts";

/**
 * Background jobs on Windows, with real processes: Git Bash (its bin\bash.exe starts usr\bin\bash.exe), node and npm,
 * as the desktop app's Run pill starts a package.json script. The tests in background.test.ts run on POSIX only.
 *
 * Through Git Bash, npm (a script with a `#!` line) runs in a process whose parent has already exited, so `taskkill /T`
 * from the shell never reached npm, the cmd.exe it starts or the script: a stopped `npm run` went on, in the project's
 * folder, which Windows then would not let anyone remove (EBUSY). A stop now ends every process of the shell's MSYS
 * process group, which MSYS's ps lists (process-tree.ts, msysGroup).
 */
const windows = process.platform === "win32";
const slash = (path: string) => path.replaceAll("\\", "/");
const node = slash(process.execPath);

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

interface Running {
	readonly pid: number;
	readonly ppid: number;
	readonly name: string;
	readonly command: string;
}

/** The processes started since `since` that still run, as Windows lists them: what a failure names. */
function startedSince(since: number): Running[] {
	const script = [
		`$t = [DateTime]::Parse('${new Date(since).toISOString()}').ToUniversalTime()`,
		"$list = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CreationDate -and $_.CreationDate.ToUniversalTime() -ge $t } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; command = [string]$_.CommandLine } })",
		"ConvertTo-Json -InputObject $list -Compress",
	].join("; ");
	const answer = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
		encoding: "utf8",
		windowsHide: true,
		timeout: 60_000,
	});
	const list = JSON.parse(answer.stdout.trim() || "[]") as Running[] | Running;
	return (Array.isArray(list) ? list : [list]).filter((entry) => entry.pid !== process.pid);
}

const show = (list: readonly Running[]) =>
	list.map((entry) => `${entry.pid} (parent ${entry.ppid}) ${entry.name}: ${entry.command}`).join("\n") || "(none)";

describe.runIf(windows)("background jobs on Windows, with real processes", () => {
	const dirs: string[] = [];
	const managers: JobManager[] = [];
	afterEach(async () => {
		for (const manager of managers.splice(0)) await manager.shutdown(100);
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	});

	function create() {
		const dir = mkdtempSync(join(tmpdir(), "mu-bgw-"));
		dirs.push(dir);
		const project = join(dir, "project");
		mkdirSync(project);
		const shell = resolveShell("bash");
		const manager = new JobManager({
			logDir: join(dir, "logs"),
			maxJobs: 4,
			bufferChars: 100_000,
			killGraceMs: 300,
			plan: (command, groupFile) => planSpawn(command, shell, { platform: "win32", groupFile }),
		});
		managers.push(manager);
		return { manager, dir, project };
	}

	/** An npm project with a script that ends at once (`greet`) and one that prints its pid and runs 30 s (`wait`). */
	function npmProject(project: string): void {
		writeFileSync(
			join(project, "package.json"),
			JSON.stringify({
				name: "e2e-project",
				private: true,
				scripts: {
					greet: 'node -e "console.log(1 + 1)"',
					wait: "node -e \"console.log('script', process.pid); setTimeout(() => {}, 30000)\"",
				},
			}),
		);
	}

	/**
	 * Removes the folder a job ran in at once, as a person deleting it would, without the retries a test's cleanup
	 * allows itself. Resolves to how long that took, or what still ran when it gave up.
	 */
	async function remove(folder: string, since: number, withinMs: number): Promise<string> {
		const startedAt = Date.now();
		let last: unknown;
		while (Date.now() - startedAt < withinMs) {
			try {
				rmSync(folder, { recursive: true, force: true });
				return `removed after ${Date.now() - startedAt} ms`;
			} catch (error) {
				last = error;
				await sleep(100);
			}
		}
		return `still not removable after ${withinMs} ms (${(last as NodeJS.ErrnoException).code}); started since the test began and still running:\n${show(startedSince(since))}`;
	}

	async function runningScript(manager: JobManager, id: string): Promise<number> {
		await manager.wait(id, { pattern: "script \\d+", timeoutMs: 60_000, since: 0 });
		const pid = Number(/script (\d+)/.exec(manager.read(id, { since: 0, maxChars: 4000 }).text)?.[1]);
		expect(alive(pid)).toBe(true);
		return pid;
	}

	it("Git Bash's job writes down its MSYS group, and ps lists npm's node.exe in it", async () => {
		const { manager, project } = create();
		npmProject(project);
		const job = manager.start({ command: "npm run wait", cwd: project, name: "wait" });
		await runningScript(manager, job.id);
		const plan = planSpawn("npm run wait", resolveShell("bash"), { platform: "win32", groupFile: "unused" });
		expect(plan.group?.ps).toMatch(/usr\\bin\\ps\.exe$/i);
		const written = Number(readFileSync(join(dirname(job.logPath), `${job.id}.group`), "utf8"));
		const members = msysGroup(plan.group?.ps as string, written);
		console.log(`[windows group] ${written}: ${members.join(", ")}`);
		// The shell's bash and npm's node.exe at least; the script, npm's cmd.exe's child, is below node.exe.
		expect(members.length).toBeGreaterThanOrEqual(2);
	}, 120_000);

	it("stops the whole tree a job started, so its folder can be removed at once", async () => {
		const { manager, dir, project } = create();
		const since = Date.now();
		const child = join(dir, "child.js");
		const parent = join(dir, "parent.js");
		writeFileSync(child, `console.log("grandchild", process.pid); setInterval(() => {}, 1000);`);
		writeFileSync(
			parent,
			`require("node:child_process").spawn(process.execPath, [${JSON.stringify(child)}], { stdio: "inherit" });
console.log("child", process.pid); setInterval(() => {}, 1000);`,
		);
		const job = manager.start({ command: `"${node}" "${slash(parent)}"`, cwd: project });
		await manager.wait(job.id, { pattern: "grandchild \\d+", timeoutMs: 20_000, since: 0 });
		await manager.wait(job.id, { pattern: "child \\d+", timeoutMs: 20_000, since: 0 });
		const pids = [...manager.read(job.id, { since: 0, maxChars: 1000 }).text.matchAll(/child (\d+)/g)].map((match) =>
			Number(match[1]),
		);
		expect(pids).toHaveLength(2);

		expect(await manager.stop(job.id, "user")).toMatchObject({ state: "exited", stoppedBy: "user" });
		expect(pids.filter(alive)).toEqual([]);
		expect(await remove(project, since, 3000)).toMatch(/^removed/);
	}, 90_000);

	it("npm run in the project, as the Run pill starts it, leaves the folder removable when the script ends", async () => {
		const { manager, project } = create();
		const since = Date.now();
		npmProject(project);
		const job = manager.start({ command: "npm run greet", cwd: project, name: "greet" });
		expect(await manager.wait(job.id, { timeoutMs: 60_000 })).toEqual({ reason: "exit" });
		expect(manager.read(job.id, { since: 0, maxChars: 4000 }).text).toContain("2");
		expect(await remove(project, since, 3000)).toMatch(/^removed/);
	}, 120_000);

	it("a stop of npm run while its script runs ends npm, cmd and the script, and leaves the folder removable", async () => {
		const { manager, project } = create();
		const since = Date.now();
		npmProject(project);
		const job = manager.start({ command: "npm run wait", cwd: project, name: "wait" });
		const script = await runningScript(manager, job.id);
		const startedAt = Date.now();
		expect(await manager.stop(job.id, "user")).toMatchObject({ state: "exited", stoppedBy: "user" });
		console.log(`[windows npm] the stop took ${Date.now() - startedAt} ms`);
		expect(alive(script)).toBe(false);
		expect(await remove(project, since, 3000)).toMatch(/^removed/);
	}, 120_000);

	it("the session's shutdown ends an npm run's script too", async () => {
		const { manager, project } = create();
		const since = Date.now();
		npmProject(project);
		const job = manager.start({ command: "npm run wait", cwd: project, name: "wait" });
		const script = await runningScript(manager, job.id);
		expect(await manager.shutdown(300)).toBe(1);
		await vi.waitFor(() => expect(alive(script)).toBe(false), { timeout: 3000 });
		expect(manager.get(job.id)).toMatchObject({ state: "exited", stoppedBy: "shutdown" });
		expect(await remove(project, since, 3000)).toMatch(/^removed/);
	}, 120_000);
	it("reports what a job left running after its shell ended (server &) as lingering, and its shutdown ends it", async () => {
		const { manager, dir, project } = create();
		const since = Date.now();
		const server = join(dir, "server.js");
		writeFileSync(server, `console.log("server", process.pid); setInterval(() => {}, 1000);`);
		const job = manager.start({ command: `"${node}" "${slash(server)}" & sleep 1; echo started`, cwd: project });
		await manager.wait(job.id, { pattern: "server \\d+", timeoutMs: 20_000, since: 0 });
		expect(await manager.wait(job.id, { timeoutMs: 20_000 })).toEqual({ reason: "exit" });
		const pid = Number(/server (\d+)/.exec(manager.read(job.id, { since: 0, maxChars: 1000 }).text)?.[1]);
		expect(alive(pid)).toBe(true);
		expect(manager.get(job.id)).toMatchObject({ state: "exited", lingering: true });
		expect(await manager.shutdown(300)).toBe(1);
		await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 });
		expect(await remove(project, since, 3000)).toMatch(/^removed/);
	}, 90_000);
});
