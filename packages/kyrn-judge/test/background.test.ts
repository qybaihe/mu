import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { compilePattern, JobError, type JobEvent, JobManager, pruneLogDirs } from "../src/background/jobs.ts";
import { OutputCleaner, RingBuffer } from "../src/background/ring-buffer.ts";
import {
	type KillStep,
	killPlan,
	planSpawn,
	readShellSettings,
	runKillStep,
	shellEnv,
	shellKind,
} from "../src/background/shell.ts";
import { parseConfig } from "../src/config.ts";
import type { DecisionMode } from "../src/decision.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import type { KyrnPresentationEvent } from "../src/extension/presentation.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";

const posix = process.platform !== "win32";
const BASH = { shell: "/bin/bash", args: ["-c"] };
const node = JSON.stringify(process.execPath);

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("ring buffer and output cleaning", () => {
	it("keeps the newest characters and tells a reader what it missed", () => {
		const buffer = new RingBuffer(10);
		buffer.append("0123");
		buffer.append("456789");
		expect(buffer.read(0)).toEqual({ text: "0123456789", from: 0, missed: 0 });
		buffer.append("abcde");
		expect(buffer.end).toBe(15);
		expect(buffer.start).toBe(5);
		expect(buffer.read(0)).toEqual({ text: "56789abcde", from: 5, missed: 5 });
		expect(buffer.read(12)).toEqual({ text: "cde", from: 12, missed: 0 });
		expect(buffer.read(99)).toEqual({ text: "", from: 15, missed: 0 });
		buffer.append("x".repeat(25));
		expect(buffer.read(0).text).toBe("x".repeat(10));
		expect(buffer.end).toBe(40);
	});

	it("strips colour codes and carriage returns, also when a chunk cuts them in two", () => {
		const cleaner = new OutputCleaner();
		const out = [
			cleaner.push("\x1b[32mok\x1b[0m one\r"),
			cleaner.push("\ntwo \x1b[3"),
			cleaner.push("1mred\x1b[0m\r10%\r20%"),
		];
		expect(out.join("") + cleaner.flush()).toBe("ok one\ntwo red\n10%\n20%");
	});

	it("takes a model's regex, and its text when that is not a regex", () => {
		expect(compilePattern("listening on \\d+").test("Server LISTENING on 3000")).toBe(true);
		const literal = compilePattern("ready (http");
		expect(literal.literal).toBe(true);
		expect(literal.test("server Ready (http://localhost)")).toBe(true);
		expect(literal.test("not yet")).toBe(false);
	});
});

describe("shell and kill plans per platform", () => {
	it("runs in PowerShell only where that is the one shell tool, on Windows", () => {
		expect(shellKind(["read", "powershell"], "win32")).toBe("powershell");
		expect(shellKind(["read", "bash", "powershell"], "win32")).toBe("bash");
		expect(shellKind(["read", "powershell"], "linux")).toBe("bash");
	});

	it("passes the command as an argument, or on stdin for the legacy WSL launcher", () => {
		expect(planSpawn("npm run dev", BASH, { platform: "darwin", prefix: "shopt -s expand_aliases" })).toEqual({
			file: "/bin/bash",
			args: ["-c", "shopt -s expand_aliases\nnpm run dev"],
			detached: true,
		});
		const wsl = { shell: "C:\\Windows\\System32\\bash.exe", args: ["-s"], commandTransport: "stdin" as const };
		expect(planSpawn("npm run dev", wsl, { platform: "win32" })).toEqual({
			file: wsl.shell,
			args: ["-s"],
			stdin: "npm run dev",
			detached: false,
		});
		const pwsh = planSpawn(
			"npm run dev",
			{ shell: "pwsh.exe", args: ["-Command"] },
			{ platform: "win32", kind: "powershell" },
		);
		expect(pwsh.args[1]).toMatch(/OutputEncoding.*\nnpm run dev$/s);
	});

	it("signals the process group on POSIX and walks the tree with taskkill on Windows, asking before forcing", () => {
		expect(killPlan(4242, false, "linux")).toEqual({ kind: "signal", pid: -4242, signal: "SIGTERM" });
		expect(killPlan(4242, true, "darwin")).toEqual({ kind: "signal", pid: -4242, signal: "SIGKILL" });
		expect(killPlan(4242, false, "win32", "D:\\Win")).toEqual({
			kind: "exec",
			file: "D:\\Win\\System32\\taskkill.exe",
			args: ["/T", "/PID", "4242"],
		});
		expect(killPlan(4242, true, "win32", "D:\\Win")).toMatchObject({ args: ["/T", "/F", "/PID", "4242"] });
	});

	it("puts the agent's bin directory first on PATH, whatever the variable is called", () => {
		expect(shellEnv({ PATH: "/usr/bin" }, "/mu/bin", "linux").PATH).toBe("/mu/bin:/usr/bin");
		expect(shellEnv({ Path: "C:\\Windows" }, "C:\\mu\\bin", "win32").Path).toBe("C:\\mu\\bin;C:\\Windows");
		expect(shellEnv({ PATH: "/mu/bin:/usr/bin" }, "/mu/bin", "linux").PATH).toBe("/mu/bin:/usr/bin");
	});

	it("reads the foreground shell's settings, the project's only when it is trusted", () => {
		const root = mkdtempSync(join(tmpdir(), "mu-bg-settings-"));
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		mkdirSync(agentDir);
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ shellPath: "/bin/zsh", shellCommandPrefix: "set -e" }),
		);
		writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ shellPath: "/tmp/evil-shell" }));
		try {
			expect(readShellSettings(project, agentDir, false)).toEqual({
				shellPath: "/bin/zsh",
				commandPrefix: "set -e",
			});
			expect(readShellSettings(project, agentDir, true).shellPath).toBe("/tmp/evil-shell");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe.skipIf(!posix)("background jobs", () => {
	const dirs: string[] = [];
	const managers: JobManager[] = [];
	afterEach(async () => {
		for (const manager of managers.splice(0)) await manager.shutdown(100);
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function create(overrides: Partial<ConstructorParameters<typeof JobManager>[0]> = {}) {
		const dir = mkdtempSync(join(tmpdir(), "mu-bg-"));
		dirs.push(dir);
		const events: JobEvent[] = [];
		const manager = new JobManager({
			logDir: join(dir, "logs"),
			maxJobs: 4,
			bufferChars: 100_000,
			killGraceMs: 300,
			plan: (command) => planSpawn(command, BASH, { platform: process.platform }),
			onEvent: (event) => events.push(event),
			...overrides,
		});
		managers.push(manager);
		return { manager, events, dir };
	}

	it("returns at once, hands out only what is new, and records the exit code and the duration", async () => {
		const { manager, events } = create();
		const job = manager.start({ command: `echo one; sleep 0.3; echo two; exit 3`, cwd: tmpdir(), name: "steps" });
		expect(job).toMatchObject({ id: "bg-1", name: "steps", state: "running" });
		expect(job.pid).toBeGreaterThan(0);

		expect(await manager.wait("bg-1", { pattern: "one", timeoutMs: 5000 })).toEqual({ reason: "match", line: "one" });
		const first = manager.read("bg-1", { maxChars: 1000 });
		expect(first.text).toBe("one\n");
		expect(await manager.wait("bg-1", { timeoutMs: 5000 })).toEqual({ reason: "exit" });
		const second = manager.read("bg-1", { maxChars: 1000 });
		expect(second.text).toBe("two\n");
		expect(second.job).toMatchObject({ state: "exited", exitCode: 3, unread: 0, lingering: false });
		expect(second.job.durationMs).toBeGreaterThanOrEqual(250);
		expect(manager.read("bg-1", { since: 0, maxChars: 1000 }).text).toBe("one\ntwo\n");
		expect(manager.read("bg-1", { since: first.next, maxChars: 1000 }).text).toBe("two\n");
		// The waiter was told by its own call, so the exit is marked as observed.
		expect(events.map((event) => event.type)).toEqual(["start", "exit"]);
		expect(events[1]).toMatchObject({ type: "exit", observed: true });
		expect(() => manager.read("bg-9", { maxChars: 10 })).toThrow(/bg-1/);
	});

	it("waits for a line without polling, and gives up after the timeout or on abort", async () => {
		const { manager } = create();
		manager.start({
			command: `${node} -e 'console.log("booting"); setTimeout(() => console.log("Listening on http://localhost:5173"), 200); setInterval(() => {}, 1000)'`,
			cwd: tmpdir(),
		});
		const startedAt = Date.now();
		const hit = await manager.wait("bg-1", { pattern: "listening on \\S+", timeoutMs: 8000 });
		expect(hit).toEqual({ reason: "match", line: "Listening on http://localhost:5173" });
		expect(Date.now() - startedAt).toBeLessThan(6000);
		expect(await manager.wait("bg-1", { pattern: "never printed", timeoutMs: 120 })).toEqual({ reason: "timeout" });
		const abort = new AbortController();
		setTimeout(() => abort.abort(), 50);
		expect(await manager.wait("bg-1", { timeoutMs: 8000, signal: abort.signal })).toEqual({ reason: "aborted" });
		// A line that is already there counts, as does one without a newline yet (a prompt).
		expect((await manager.wait("bg-1", { pattern: "booting", since: 0, timeoutMs: 50 })).reason).toBe("match");
	});

	it("stops the whole process tree, not just the shell", async () => {
		const { manager, events } = create();
		manager.start({
			command: `${node} -e 'console.log("child", process.pid); setInterval(() => {}, 1000)' & ${node} -e 'console.log("parent", process.pid); setInterval(() => {}, 1000)'; wait`,
			cwd: tmpdir(),
		});
		await manager.wait("bg-1", { pattern: "child", timeoutMs: 8000, since: 0 });
		await manager.wait("bg-1", { pattern: "parent", timeoutMs: 8000, since: 0 });
		const text = manager.read("bg-1", { since: 0, maxChars: 1000 }).text;
		const pids = [...text.matchAll(/(?:child|parent) (\d+)/g)].map((match) => Number(match[1]));
		expect(pids).toHaveLength(2);
		expect(pids.every(alive)).toBe(true);

		const stopped = await manager.stop("bg-1", "model");
		expect(stopped).toMatchObject({ state: "exited", stoppedBy: "model", lingering: false });
		await vi.waitFor(() => expect(pids.some(alive)).toBe(false), { timeout: 3000 });
		expect(events.map((event) => event.type)).toEqual(["start", "exit", "stop"]);
		expect(manager.runningCount()).toBe(0);
	});

	it("asks first and forces after the grace period", async () => {
		const steps: KillStep[] = [];
		const { manager } = create({
			killGraceMs: 200,
			kill: (step) => {
				steps.push(step);
				runKillStep(step);
			},
		});
		manager.start({
			command: `exec ${node} -e 'process.on("SIGTERM", () => console.log("ignoring")); console.log("ready"); setInterval(() => {}, 1000)'`,
			cwd: tmpdir(),
		});
		await manager.wait("bg-1", { pattern: "ready", timeoutMs: 8000 });
		const stopped = await manager.stop("bg-1", "user");
		expect(steps.map((step) => (step.kind === "signal" ? step.signal : step.kind))).toEqual(["SIGTERM", "SIGKILL"]);
		expect(stopped).toMatchObject({ state: "exited", exitCode: 137, stoppedBy: "user" });
		expect(manager.read("bg-1", { since: 0, maxChars: 1000 }).text).toContain("ignoring");
	});

	it("uses taskkill for the same sequence on Windows", async () => {
		const steps: KillStep[] = [];
		const { manager } = create({
			platform: "win32",
			killGraceMs: 100,
			kill: (step) => {
				steps.push(step);
				// There is no taskkill here: the forced step is played by a real signal so that the job ends.
				if (step.kind === "exec" && step.args.includes("/F")) process.kill(Number(step.args.at(-1)), "SIGKILL");
			},
		});
		const job = manager.start({ command: `exec ${node} -e 'setInterval(() => {}, 1000)'`, cwd: tmpdir() });
		const stopped = await manager.stop("bg-1", "model");
		expect(steps.map((step) => (step.kind === "exec" ? step.args.join(" ") : step.kind))).toEqual([
			`/T /PID ${job.pid}`,
			`/T /F /PID ${job.pid}`,
		]);
		expect(stopped.state).toBe("exited");
	});

	it("reports a command that backgrounded its own child as lingering, and still stops it", async () => {
		const { manager } = create();
		manager.start({
			command: `${node} -e 'console.log("server", process.pid); setInterval(() => {}, 1000)' & sleep 0.2; echo started`,
			cwd: tmpdir(),
		});
		await manager.wait("bg-1", { pattern: "server \\d+", timeoutMs: 8000, since: 0 });
		await manager.wait("bg-1", { timeoutMs: 8000 });
		const info = manager.read("bg-1", { since: 0, maxChars: 1000 });
		const pid = Number(/server (\d+)/.exec(info.text)?.[1]);
		expect(info.job).toMatchObject({ state: "exited", exitCode: 0, lingering: true });
		expect(alive(pid)).toBe(true);
		expect(manager.runningCount()).toBe(1);
		expect(await manager.stop("bg-1", "model")).toMatchObject({ lingering: false });
		await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 });
	});

	it("caps concurrent jobs, refuses a missing directory, and reports a shell that cannot start", async () => {
		const { manager, dir } = create({ maxJobs: 1 });
		manager.start({ command: "sleep 5", cwd: tmpdir() });
		expect(() => manager.start({ command: "sleep 5", cwd: tmpdir() })).toThrow(JobError);
		expect(() => manager.start({ command: "sleep 5", cwd: tmpdir() })).toThrow(/limit.*bg-1/);
		await manager.stop("bg-1", "model");
		expect(() => manager.start({ command: "true", cwd: join(dir, "nowhere") })).toThrow(/does not exist/);
		expect(() => manager.start({ command: "  ", cwd: tmpdir() })).toThrow(/empty/);

		const broken = create({ plan: () => ({ file: join(dir, "no-such-shell"), args: [], detached: true }) });
		broken.manager.start({ command: "anything", cwd: tmpdir() });
		expect(await broken.manager.wait("bg-1", { timeoutMs: 5000 })).toEqual({ reason: "exit" });
		const result = broken.manager.read("bg-1", { maxChars: 1000 });
		expect(result.job).toMatchObject({ state: "exited", exitCode: 127 });
		expect(result.text).toContain("could not be started");
	});

	it("keeps the newest output in memory and all of it in the log", async () => {
		const { manager } = create({ bufferChars: 60 });
		manager.start({ command: `for i in $(seq 1 40); do echo "line $i of the build"; done`, cwd: tmpdir() });
		await manager.wait("bg-1", { timeoutMs: 8000 });
		const result = manager.read("bg-1", { since: 0, maxChars: 25 });
		expect(result.missed).toBeGreaterThan(500);
		expect(result.text.length).toBe(25);
		expect(result.skipped).toBe(35);
		expect(result.text.endsWith("line 40 of the build\n")).toBe(true);
		const log = readFileSync(result.job.logPath, "utf8");
		expect(log.split("\n").filter(Boolean)).toHaveLength(40);
		expect(log).toContain("line 1 of the build");
	});

	it("reports a watched line once per reading", async () => {
		const { manager, events } = create();
		manager.start({
			command: `echo fine; echo "ERROR one"; echo "ERROR two"; sleep 0.3; echo "ERROR three"; sleep 5`,
			cwd: tmpdir(),
			watch: "^error",
		});
		await manager.wait("bg-1", { pattern: "ERROR two", timeoutMs: 8000, since: 0 });
		const matches = () => events.filter((event) => event.type === "match");
		expect(matches()).toHaveLength(1);
		expect(matches()[0]).toMatchObject({ line: "ERROR one" });
		manager.read("bg-1", { maxChars: 1000 });
		await manager.wait("bg-1", { pattern: "ERROR three", timeoutMs: 8000 });
		expect(matches().map((event) => (event.type === "match" ? event.line : ""))).toEqual([
			"ERROR one",
			"ERROR three",
		]);
	});

	it("marks a watched line as observed while a wait on the job runs", async () => {
		const { manager, events } = create();
		manager.start({
			command: `sleep 0.2; echo "ERROR one"; sleep 1; echo "ERROR two"; sleep 5`,
			cwd: tmpdir(),
			watch: "^error",
		});
		const matches = () => events.filter((event) => event.type === "match");
		// Nobody waits on the job: the line is news to whoever hears of it.
		await vi.waitFor(() => expect(matches()).toHaveLength(1), { timeout: 5000 });
		manager.read("bg-1", { maxChars: 1000 });
		// A wait is running when the next one comes: its caller reads the line in its own output.
		await manager.wait("bg-1", { timeoutMs: 8000, pattern: "ERROR two" });
		expect(matches().map((event) => (event.type === "match" ? [event.line, event.observed] : []))).toEqual([
			["ERROR one", false],
			["ERROR two", true],
		]);
	});

	it("stops every job on shutdown and as a last resort", async () => {
		const { manager } = create();
		const pids = [
			manager.start({ command: "sleep 30", cwd: tmpdir() }).pid as number,
			manager.start({ command: "sleep 30", cwd: tmpdir() }).pid as number,
		];
		expect(await manager.shutdown(200)).toBe(2);
		await vi.waitFor(() => expect(pids.some(alive)).toBe(false), { timeout: 3000 });
		expect(manager.list().every((job) => job.stoppedBy === "shutdown")).toBe(true);

		const last = create();
		const pid = last.manager.start({ command: "sleep 30", cwd: tmpdir() }).pid as number;
		last.manager.killAllNow();
		await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 });
	});

	it("can have a job write straight to its log, read it from there, and leave it running on release", async () => {
		const { manager } = create({ outputToFile: true });
		manager.start({ command: "echo one; sleep 0.2; echo two >&2; exit 4", cwd: tmpdir() });
		expect(await manager.wait("bg-1", { pattern: "two", timeoutMs: 5000, since: 0 })).toEqual({
			reason: "match",
			line: "two",
		});
		await manager.wait("bg-1", { timeoutMs: 5000 });
		const done = manager.read("bg-1", { since: 0, maxChars: 1000 });
		expect(done.text).toBe("one\ntwo\n");
		expect(done.job).toMatchObject({ state: "exited", exitCode: 4 });
		expect(readFileSync(done.job.logPath, "utf8")).toBe("one\ntwo\n");

		const server = manager.start({
			command: `${node} -e 'setInterval(() => console.log("tick"), 50)'`,
			cwd: tmpdir(),
		});
		await manager.wait("bg-2", { pattern: "tick", timeoutMs: 5000 });
		const kept = await manager.release();
		expect(kept.map((job) => job.id)).toEqual(["bg-2"]);
		const size = statSync(server.logPath).size;
		try {
			await vi.waitFor(() => expect(statSync(server.logPath).size).toBeGreaterThan(size), { timeout: 3000 });
			expect(alive(server.pid as number)).toBe(true);
		} finally {
			process.kill(-(server.pid as number), "SIGKILL");
		}
	});

	it("clears out the logs of sessions that ended long ago", () => {
		const { dir } = create();
		const old = join(dir, "old-session");
		const fresh = join(dir, "fresh-session");
		mkdirSync(old);
		mkdirSync(fresh);
		const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
		utimesSync(old, tenDaysAgo, tenDaysAgo);
		expect(pruneLogDirs(dir, 7)).toBe(1);
		expect(pruneLogDirs(join(dir, "missing"), 7)).toBe(0);
		expect(() => readFileSync(join(old, "x"))).toThrow();
		expect(mkdirSync(fresh, { recursive: true })).toBeUndefined();
	});
});

describe.skipIf(!posix)("background feature", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) {
			const harness = harnesses.pop();
			// Shutting the session down is what stops the jobs.
			await harness?.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness?.cleanup();
		}
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	const pause: AgentTool = {
		name: "pause",
		label: "pause",
		description: "pause",
		parameters: Type.Object({ ms: Type.Number() }),
		execute: async (_id, params) => {
			await new Promise((resolve) => setTimeout(resolve, (params as { ms: number }).ms));
			return { content: [{ type: "text", text: "paused" }], details: {} };
		},
	};

	async function start(
		responder: MockResponder,
		extra: {
			mode?: DecisionMode;
			/** notify.routing's own mode; unset, it keeps its built-in default (shadow). */
			routing?: DecisionMode;
			features?: Record<string, unknown>;
			background?: Record<string, unknown>;
			tools?: AgentTool[];
		} = {},
	) {
		const dir = mkdtempSync(join(tmpdir(), "mu-bg-feature-"));
		dirs.push(dir);
		const presented: KyrnPresentationEvent[] = [];
		const harness = await createHarness({
			tools: [pause, ...(extra.tools ?? [])],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(responder),
					mode: extra.mode ?? "active",
					config: parseConfig({
						modes: extra.routing ? { "notify.routing": extra.routing } : {},
						features: {
							memory: false,
							// The harness runs like `mu --print`, where routing is not asked unless told to.
							notify: { unattended: true },
							background: {
								logDir: join(dir, "logs"),
								inheritShell: false,
								killGraceMs: 200,
								...extra.background,
							},
							...extra.features,
						},
					}),
					only: ["guard", "admission", "notify", "background"],
					onPresentation: (event) => presented.push(event),
				}),
			],
		});
		harnesses.push(harness);
		return { harness, presented, dir };
	}

	const results = (harness: Harness): string[] =>
		harness.session.messages
			.filter((message) => message.role === "toolResult")
			.map((message) =>
				((message as { content?: { text?: string }[] }).content ?? []).map((block) => block.text ?? "").join("\n"),
			);
	const notices = (harness: Harness): string[] =>
		harness.session.messages
			.filter(
				(message) => message.role === "custom" && (message as { customType?: string }).customType === "kyrn.notice",
			)
			.map((message) => String((message as { content?: unknown }).content));
	const call = (name: string, input: Record<string, string | number>) =>
		fauxAssistantMessage([fauxToolCall(name, input)], { stopReason: "toolUse" });
	const urgency =
		(choice: string): MockResponder =>
		(request): Record<string, Answer> =>
			"urgency" in request.questions
				? { urgency: { type: "choice", choice, probabilities: { [choice]: 0.95 } } }
				: {};

	it("starts a job, waits for it in one call and labels its output as untrusted", async () => {
		const { harness, presented } = await start(() => ({}));
		harness.setResponses([
			// The command is shown to the user; what it prints is not, so the two must differ here.
			call("bg_start", { command: "printf 'comp%s\\n' iled; exit 2", name: "build" }),
			call("bg_output", { id: "bg-1", timeout: 10 }),
			call("bg_output", {}),
			fauxAssistantMessage("The build failed."),
		]);

		await harness.session.prompt("Build it in the background.");

		const [started, output, list] = results(harness);
		expect(started).toContain("Started bg-1");
		expect(output).toContain('bg-1 "build" · printf');
		expect(output).toContain("· exited with code 2");
		expect(output).toContain("untrusted data from a command");
		expect(output).toContain("compiled");
		expect(output).toMatch(/next since: \d+/);
		expect(list).toContain("exited with code 2");
		expect(presented.filter((event) => event.kind.startsWith("background.")).map((event) => event.kind)).toEqual([
			"background.start",
			"background.exit",
		]);
		expect(JSON.stringify(presented)).not.toContain("compiled");
		// The model waited on the job itself, so nothing was routed.
		expect(notices(harness)).toEqual([]);
		expect(harness.session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["bg_start", "bg_output", "bg_stop"]),
		);
	});

	it("puts bg_start through the risk guard like a foreground command", async () => {
		const { harness, dir } = await start(
			(request): Record<string, Answer> =>
				"requested" in request.questions
					? {
							destructive: { type: "boolean", probability: 0.96 },
							requested: { type: "boolean", probability: 0.03 },
						}
					: {},
		);
		const marker = join(dir, "ran");
		harness.setResponses([
			call("bg_start", { command: `touch ${marker}; rm -rf ./cache-that-does-not-exist` }),
			fauxAssistantMessage("I could not clean up."),
		]);

		await harness.session.prompt("Why is the build slow?");

		expect(results(harness)[0]).toContain("needs confirmation");
		expect(() => readFileSync(marker)).toThrow();
	});

	it("routes the end of a job the model is not waiting on: now steers the running turn", async () => {
		const { harness } = await start(urgency("now"), { routing: "active" });
		let seen = "";
		harness.setResponses([
			call("bg_start", { command: "echo done; exit 1" }),
			call("pause", { ms: 900 }),
			(context) => {
				seen = JSON.stringify(context.messages);
				return fauxAssistantMessage("Noted.");
			},
		]);

		await harness.session.prompt("Run the long check while you refactor.");

		expect(notices(harness)).toHaveLength(1);
		expect(notices(harness)[0]).toMatch(/Background job bg-1 \(`echo done; exit 1`\) exited with code 1/);
		expect(notices(harness)[0]).toContain('bg_output({ id: "bg-1" })');
		expect(seen).toContain("exited with code 1");
	});

	it("routes it to the next turn, or nowhere", async () => {
		const later = await start(urgency("next_turn"), { routing: "active" });
		let seen = "";
		later.harness.setResponses([
			call("bg_start", { command: "echo done" }),
			call("pause", { ms: 900 }),
			fauxAssistantMessage("Refactored."),
			(context) => {
				seen = JSON.stringify(context.messages);
				return fauxAssistantMessage("It passed.");
			},
		]);
		await later.harness.session.prompt("Run the long check while you refactor.");
		expect(notices(later.harness)).toEqual([]);
		await later.harness.session.prompt("And the check?");
		expect(seen).toContain("exited with code 0");

		const never = await start(urgency("drop"), { routing: "active" });
		never.harness.setResponses([
			call("bg_start", { command: "echo done" }),
			call("pause", { ms: 900 }),
			fauxAssistantMessage("Refactored."),
			fauxAssistantMessage("Which check?"),
		]);
		await never.harness.session.prompt("Run the long check while you refactor.");
		await never.harness.session.prompt("And the check?");
		expect(notices(never.harness)).toEqual([]);
	});

	it("without a verdict (routing is in shadow by default) tells the model at once, within a single prompt", async () => {
		const asked: string[] = [];
		const { harness } = await start((request) => {
			if ("urgency" in request.questions) asked.push(JSON.stringify(request.state));
			// What the judge would say is recorded, not acted on.
			return urgency("drop")(request);
		});
		let seen = "";
		harness.setResponses([
			call("bg_start", { command: "echo done; exit 3" }),
			call("pause", { ms: 900 }),
			(context) => {
				seen = JSON.stringify(context.messages);
				return fauxAssistantMessage("The check failed with code 3.");
			},
		]);
		// One prompt and no other: a notice for the next turn would never be read.
		await harness.session.prompt("Run the long check while you refactor.");
		expect(notices(harness)).toHaveLength(1);
		expect(seen).toContain("exited with code 3");
		expect(asked).toHaveLength(1);
	});

	it("can still leave the notice for the next turn, as before", async () => {
		const { harness } = await start(urgency("now"), { background: { unjudged: "next_turn" } });
		harness.setResponses([
			call("bg_start", { command: "echo done" }),
			call("pause", { ms: 900 }),
			fauxAssistantMessage("Refactored."),
			fauxAssistantMessage("It passed."),
		]);
		await harness.session.prompt("Run the long check while you refactor.");
		expect(notices(harness)).toEqual([]);
		await harness.session.prompt("And the check?");
		expect(notices(harness)).toHaveLength(1);
	});

	it("says nothing of a watched line or an end the model is already waiting for", async () => {
		const { harness } = await start(urgency("now"), { routing: "active" });
		harness.setResponses([
			call("bg_start", { command: "sleep 0.3; echo ready; sleep 0.3", watch: "ready" }),
			call("bg_output", { id: "bg-1", timeout: 10 }),
			fauxAssistantMessage("It came up and finished."),
		]);
		await harness.session.prompt("Start it and wait until it is done.");
		expect(results(harness)[1]).toContain("ready");
		expect(notices(harness)).toEqual([]);
	});

	it("gives a long background test log the same admission treatment as a foreground one", async () => {
		const { harness, dir } = await start(() => ({}), {
			features: { admission: { enabled: true, testLog: "rules" } },
		});
		const dom = Array.from(
			{ length: 40 },
			(_, n) => `    <div class="row row-${n}" data-testid="item-${n}">item ${n}</div>\n`,
		).join("");
		const stack = Array.from(
			{ length: 7 },
			(_, n) => ` ❯ node_modules/@testing-library/dom/dist/query-helpers.js:${20 + n}:${5 + n}\n`,
		).join("");
		const failure = (name: string) =>
			` FAIL  test/sider.dom.test.tsx > sider > ${name}\nTestingLibraryElementError: Unable to find an element with the text: ${name}\n\n<body>\n${dom}</body>\n${stack}\n`;
		const log = [
			"\n RUN  v4.1.9 /tmp/synthetic\n\n ❯ test/sider.dom.test.tsx (4 tests | 3 failed) 40ms\n",
			"⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯\n\n",
			failure("shows the wordmark"),
			failure("links to the home route"),
			failure("collapses on a narrow window"),
			" Test Files  1 failed (1)\n      Tests  3 failed | 1 passed (4)\n",
		].join("");
		writeFileSync(join(dir, "log.txt"), log);
		harness.setResponses([
			call("bg_start", { command: `cat ${join(dir, "log.txt")} # vitest run test/sider.dom.test.tsx` }),
			call("bg_output", { id: "bg-1", timeout: 10 }),
			fauxAssistantMessage("Three tests fail."),
		]);

		await harness.session.prompt("Run the sider tests in the background.");

		const output = results(harness)[1];
		expect(output).toContain("exited with code 0");
		expect(output).toMatch(/\[mu: omitted \d+ lines: identical to lines/);
		expect(output).toContain("shows the wordmark");
		expect(output).toContain("collapses on a narrow window");
		expect(output.length).toBeLessThan(log.length * 0.7);
	});

	it("stops its jobs when the session shuts down", async () => {
		// The harness runs like `mu --print`, where jobs are left running by default (next test).
		const { harness } = await start(() => ({}), { background: { keepOnExit: "never" } });
		harness.setResponses([
			call("bg_start", { command: `${node} -e 'console.log("pid", process.pid); setInterval(() => {}, 1000)'` }),
			call("bg_output", { id: "bg-1", wait_for: "pid \\d+", timeout: 10 }),
			fauxAssistantMessage("Serving."),
		]);
		await harness.session.prompt("Serve it.");
		const pid = Number(/pid (\d+)/.exec(results(harness)[1])?.[1]);
		expect(alive(pid)).toBe(true);

		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });

		await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 });
	});

	it("leaves its jobs running after an unattended run, and says so when it starts one", async () => {
		const { harness } = await start(() => ({}));
		harness.setResponses([
			call("bg_start", { command: `${node} -e 'console.log("pid", process.pid); setInterval(() => {}, 1000)'` }),
			call("bg_output", { id: "bg-1", wait_for: "pid \\d+", timeout: 10 }),
			fauxAssistantMessage("Serving."),
		]);
		await harness.session.prompt("Serve it.");
		expect(results(harness)[0]).toContain("keeps running after the run ends");
		const pid = Number(/pid (\d+)/.exec(results(harness)[1])?.[1]);
		try {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(alive(pid)).toBe(true);
		} finally {
			process.kill(pid, "SIGKILL");
		}
	});
});
