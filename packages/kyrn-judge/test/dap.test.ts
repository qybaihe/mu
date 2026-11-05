import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { Harness } from "../../coding-agent/test/suite/harness.ts";
import {
	type AdapterSpec,
	adaptersFor,
	builtInAdapters,
	launchArguments,
	pickAdapter,
	projectInterpreter,
} from "../src/dap/adapters.ts";
import { DapClient } from "../src/dap/client.ts";
import { DebugSession, type Where } from "../src/dap/session.ts";
import { confinedPlan, launchExtra } from "../src/extension/features/packs/debugger.ts";
import { tempArea } from "./fixtures/git-repo.ts";
import { active, call, disclosing, registered, startPacks, toolResults } from "./packs-helpers.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/fake-dap-adapter.mjs");
const LIMITS = { maxFrames: 20, maxVariables: 50, outputChars: 4000, stopTimeoutMs: 5000 };

const cleanup: (() => unknown)[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
	while (cleanup.length > 0) await cleanup.pop()?.();
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

/** A directory with a space and Chinese characters in its path, holding one fake program. */
function programFile(lines: string[], name = "prog.fake"): { dir: string; program: string } {
	const { root, dir } = tempArea("mu-dap-");
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const program = join(dir, name);
	writeFileSync(program, `${lines.join("\n")}\n`);
	return { dir, program };
}

async function fakeSession(
	cwd: string,
	options: { flags?: string[]; tcp?: boolean; stopTimeoutMs?: number } = {},
): Promise<{ session: DebugSession; client: DapClient }> {
	const args = [FAKE, ...(options.tcp ? ["--port", "{port}"] : []), ...(options.flags ?? [])];
	const client = new DapClient({
		plan: { command: process.execPath, args },
		transport: options.tcp ? "tcp" : "stdio",
		cwd,
	});
	const session = new DebugSession(client, {
		...LIMITS,
		stopTimeoutMs: options.stopTimeoutMs ?? LIMITS.stopTimeoutMs,
	});
	cleanup.push(() => session.end());
	await client.start();
	return { session, client };
}

function stopped(where: Where) {
	if (where.state !== "stopped") throw new Error(`expected a stop, got ${JSON.stringify(where)}`);
	return where;
}

const PROGRAM = ["x = 1", "items = [4, 5]", "print hello from the program", "y = 2", "x = 3"];

describe("debug adapters", () => {
	it("picks by id, then by the program's ending, then the catch-all, with the user's adapters first", () => {
		const builtIn = builtInAdapters("darwin");
		expect(pickAdapter("app.py", builtIn)?.id).toBe("debugpy");
		expect(pickAdapter("MAIN.GO", builtIn)?.id).toBe("delve");
		expect(pickAdapter("./build/app", builtIn)?.id).toBe("lldb-dap");
		expect(pickAdapter("app.py", builtIn, "lldb-dap")?.id).toBe("lldb-dap");
		expect(pickAdapter("app.py", builtIn, "js-debug")).toBeUndefined();
		expect(builtInAdapters("win32")[0].command).toBe("python");
		expect(builtIn[0].command).toBe("python3");

		const adapters = adaptersFor("linux", {
			mine: { command: "my-py-debugger", extensions: [".py"] },
			debugpy: { launch: { justMyCode: false } },
			delve: { command: "/opt/go/bin/dlv" },
			broken: { args: ["no command, no built-in"] },
			nonsense: 3,
		});
		expect(adapters.map((spec) => spec.id)).toEqual(["mine", "debugpy", "delve", "lldb-dap"]);
		expect(pickAdapter("app.py", adapters)?.id).toBe("mine");
		const debugpy = adapters.find((spec) => spec.id === "debugpy") as AdapterSpec;
		// Changed launch arguments keep the built-in's command, and so its probe.
		expect(debugpy.launch).toEqual({ justMyCode: false });
		expect(debugpy.probe).toEqual(["-c", "import debugpy"]);
		const delve = adapters.find((spec) => spec.id === "delve") as AdapterSpec;
		expect(delve.transport).toBe("tcp");
		expect(delve.install).toContain("go install");
		// A command of the user's own is not probed or looked for elsewhere.
		expect(adaptersFor("darwin", { "lldb-dap": { command: "/x/lldb-dap" } }).at(-1)?.fallbacks).toBeUndefined();
		expect(builtInAdapters("darwin").at(-1)?.fallbacks?.[0]).toContain("CommandLineTools");
	});

	it("builds launch arguments with the call's additions and its program, arguments and directory", () => {
		const [debugpy] = builtInAdapters("linux");
		expect(
			launchArguments(debugpy, {
				args: ["-k", "slow"],
				cwd: "/w",
				extra: { module: "pytest", request: "attach", name: "x", stopOnEntry: true },
			}),
		).toEqual({
			type: "python",
			console: "internalConsole",
			justMyCode: true,
			redirectOutput: true,
			module: "pytest",
			stopOnEntry: true,
			request: "launch",
			name: "mu",
			args: ["-k", "slow"],
			cwd: "/w",
		});
		expect(launchArguments(debugpy, { program: "/w/a.py", args: [], cwd: "/w" })).toMatchObject({
			program: "/w/a.py",
			stopOnEntry: false,
		});
		expect(launchExtra(undefined)).toEqual({});
		expect(launchExtra(' {"mode": "test"} ')).toEqual({ mode: "test" });
		expect(() => launchExtra("{mode: test}")).toThrow("not JSON");
		expect(() => launchExtra('["a"]')).toThrow("JSON object");
	});

	it("finds the project's virtual environment for Python only", () => {
		const { root, dir } = tempArea("mu-venv-");
		cleanup.push(() => rmSync(root, { recursive: true, force: true }));
		// Where this machine's venv keeps its interpreter: Scripts\python.exe on Windows, bin/python elsewhere.
		const python =
			process.platform === "win32"
				? join(dir, ".venv", "Scripts", "python.exe")
				: join(dir, ".venv", "bin", "python");
		mkdirSync(dirname(python), { recursive: true });
		writeFileSync(python, "#!/bin/sh\n");
		chmodSync(python, 0o755);
		const [debugpy, delve] = builtInAdapters(process.platform);
		const executable = (path: string) => path === python;
		expect(projectInterpreter(debugpy, dir, process.platform, executable)).toBe(python);
		expect(projectInterpreter(delve, dir, process.platform, executable)).toBeUndefined();
		expect(projectInterpreter(debugpy, "/w", "linux", (path) => path === "/w/.venv/bin/python")).toBe(
			"/w/.venv/bin/python",
		);
		expect(projectInterpreter(debugpy, "C:\\w", "win32", (path) => path === "C:\\w\\venv\\Scripts\\python.exe")).toBe(
			"C:\\w\\venv\\Scripts\\python.exe",
		);
	});
});

describe("debug session", () => {
	it("launches to a breakpoint, reads locals and members, evaluates, steps and runs to the end (debugpy's order)", async () => {
		const { dir, program } = programFile(PROGRAM);
		const { session, client } = await fakeSession(dir, { flags: ["--reverse"] });
		const launched = await session.launch("fake", { request: "launch", program }, [
			{ file: program, line: 4 },
			{ file: program, line: 40 },
			{ file: join(dir, "other.fake"), line: 1 },
		]);
		expect(launched.breakpoints.map((point) => [point.line, point.verified, point.message])).toEqual([
			[4, true, undefined],
			[40, false, "no code at line 40"],
			[1, false, "unknown source"],
		]);
		const where = stopped(launched.where);
		expect(where.reason).toBe("breakpoint");
		expect(where.threadId).toBe(7);
		expect(where.frames.map((frame) => [frame.name, frame.file, frame.line])).toEqual([
			["work", program, 4],
			["<module>", program, 1],
		]);
		expect(where.scope).toBe("Locals");
		expect(where.locals.map((variable) => `${variable.name}=${variable.value}:${variable.type}`)).toEqual([
			"x=1:int",
			"items=[4,5]:list",
		]);
		const items = where.locals.find((variable) => variable.name === "items");
		expect(items?.reference).toBeGreaterThan(0);
		expect(
			(await session.variables(items?.reference ?? 0)).map((member) => `${member.name}=${member.value}`),
		).toEqual(["0=4", "1=5"]);
		expect(await session.evaluate("x")).toMatchObject({ value: "1", type: "int" });
		await expect(session.evaluate("nope")).rejects.toThrow("NameError");
		expect((await session.locals(1)).variables.map((variable) => variable.name)).toEqual(["__name__"]);
		await expect(session.locals(5)).rejects.toThrow("no frame 5");

		// What the program printed is there; telemetry is not, and the refused reverse request kept things going.
		const output = session.output();
		expect(output).toContain("hello from the program");
		expect(output).toContain("reverse request answered: false not supported by this client");
		expect(output).not.toContain("telemetry-noise");
		expect(session.output()).toBe("");

		const next = stopped(await session.step("next"));
		expect(next.reason).toBe("step");
		expect(next.frames[0].line).toBe(5);
		expect(next.locals.find((variable) => variable.name === "y")?.value).toBe("2");
		await expect(session.step("wait")).rejects.toThrow("nothing to wait for");

		expect(await session.step("continue")).toEqual({ state: "ended", exitCode: 0 });
		expect(session.ended).toBe(true);
		expect(await session.step("next")).toEqual({ state: "ended" });
		expect(client.events.some((event) => event.event === "exited")).toBe(true);
	});

	it("speaks over TCP to an adapter that answers launch first, and passes breakpoint conditions on", async () => {
		const { dir, program } = programFile(["x = 1", "x = 2", "x = 3", "x = 4"]);
		const { session } = await fakeSession(dir, { tcp: true, flags: ["--answer-launch-first"] });
		const launched = await session.launch("fake", { request: "launch", program }, [
			{ file: program, line: 2, condition: "x == 5" },
			{ file: program, line: 3, condition: "x == 2" },
		]);
		const where = stopped(launched.where);
		expect(where.frames[0].line).toBe(3);
		expect(where.locals).toEqual([{ name: "x", value: "2", type: "int", reference: 0 }]);
	});

	it("stops where an uncaught exception is thrown, says what it was, and ends with its exit code", async () => {
		const { dir, program } = programFile(["a = 1", "raise division by zero", "b = 2"]);
		const { session } = await fakeSession(dir);
		const where = stopped((await session.launch("fake", { request: "launch", program }, [])).where);
		expect(where.reason).toBe("exception");
		expect(where.exception).toBe("ValueError: division by zero");
		expect(where.frames[0].line).toBe(2);
		expect(await session.step("continue")).toEqual({ state: "ended", exitCode: 1 });
		expect(session.output()).toContain("ValueError: division by zero");
	});

	it("reports a program that does not stop as running, and pauses it to show where it is", async () => {
		const { dir, program } = programFile(["n = 1", "loop", "n = 2"]);
		const { session } = await fakeSession(dir, { stopTimeoutMs: 300 });
		expect((await session.launch("fake", { request: "launch", program }, [])).where).toEqual({ state: "running" });
		await expect(session.step("next")).rejects.toThrow("pause it or wait first");
		expect(await session.step("wait")).toEqual({ state: "running" });
		const paused = stopped(await session.step("pause"));
		expect(paused.reason).toBe("pause");
		expect(paused.frames[0].line).toBe(2);
		await expect(session.step("pause")).rejects.toThrow("already stopped");
	});

	it("gives up on waiting when the call is aborted", async () => {
		const { dir, program } = programFile(["loop"]);
		const { session } = await fakeSession(dir, { stopTimeoutMs: 20_000 });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		const started = Date.now();
		expect((await session.launch("fake", { request: "launch", program }, [], controller.signal)).where).toEqual({
			state: "running",
		});
		expect(Date.now() - started).toBeLessThan(5000);
	});

	it("says why when the adapter refuses the launch or is not the protocol", async () => {
		const { dir } = programFile(["x = 1"]);
		const { session } = await fakeSession(dir);
		await expect(
			session.launch("fake", { request: "launch", program: join(dir, "missing.fake") }, []),
		).rejects.toThrow("launch failed: program not found");

		const client = new DapClient({
			plan: { command: process.execPath, args: ["-e", "console.error('bad things'); process.exit(3)"] },
			transport: "stdio",
			cwd: dir,
		});
		cleanup.push(() => client.stop());
		await client.start().catch(() => undefined);
		await expect(new DebugSession(client, LIMITS).launch("x", {}, [])).rejects.toThrow(
			/exited \(code 3\)|bad things/,
		);
	});
});

describe("pack:debugger", () => {
	const adapters = (extra: Record<string, unknown> = {}) => ({
		debugAdapters: {
			fake: { command: process.execPath, args: [FAKE], extensions: [".fake"], title: "Fake debugger" },
			...extra,
		},
	});

	it("stays closed until disclosed, then debugs a program through its four tools", async () => {
		const { harness } = await startPacks(harnesses, { responder: disclosing("Debugger"), packs: adapters() });
		writeFileSync(join(harness.tempDir, "prog.fake"), `${PROGRAM.join("\n")}\n`);
		expect(registered(harness)).not.toContain("debug_start");
		harness.setResponses([
			call("debug_start", { program: "prog.fake", breakpoints: [{ file: "prog.fake", line: 4 }] }),
			call("debug_inspect", { expression: "items" }),
			call("debug_inspect", { frame: 1 }),
			call("debug_step", { action: "next" }),
			call("debug_step", { action: "continue" }),
			call("debug_stop", {}),
			fauxAssistantMessage("x is 1 at line 4 and becomes 3 by the end."),
		]);

		await harness.session.prompt("Why is x wrong in prog.fake? Debug it.");

		expect(active(harness)).toEqual(
			expect.arrayContaining(["debug_start", "debug_step", "debug_inspect", "debug_stop"]),
		);
		const [start, evaluated, frame, next, end, stop] = toolResults(harness);
		// The results are JSON, where the backslashes of a Windows path come doubled.
		expect(start).toContain(JSON.stringify(`Fake debugger, ${process.execPath}`).slice(1, -1));
		expect(start).toContain("Stopped (breakpoint) at prog.fake:4.");
		expect(start).toContain("#0 work at prog.fake:4");
		expect(start).toContain("come from the program being debugged");
		expect(start).toContain("x = 1 (int)");
		expect(start).toMatch(/items = \[4,5\] \(list\) \[ref \d+\]/);
		expect(start).toContain("prog.fake:4 set");
		expect(start).toContain("Program output:");
		expect(start).toContain("hello from the program");
		expect(evaluated).toContain("items = [4,5] (list)");
		expect(frame).toContain("Locals of #1:");
		expect(frame).toContain("__name__");
		expect(next).toContain("Stopped (step) at prog.fake:5.");
		expect(end).toContain("The program ended with exit code 0. The debugging run is over.");
		// The run ended with its program: there is nothing left to stop.
		expect(stop).toContain("No debugging run to end.");
	});

	it("names the install command when the adapter is missing, and needs a program", async () => {
		const { harness } = await startPacks(harnesses, {
			responder: disclosing("Debugger"),
			packs: adapters({ delve: { command: join(nowhere(), "no-such-dlv") } }),
		});
		harness.setResponses([
			call("debug_start", { program: "main.go", breakpoints: [] }),
			call("debug_start", { breakpoints: [] }),
			call("debug_step", { action: "next" }),
			fauxAssistantMessage("Delve is not installed."),
		]);
		await harness.session.prompt("Debug main.go under a debugger.");
		const [missing, noProgram, noRun] = toolResults(harness);
		expect(missing).toContain("is not on this machine's PATH. Install it with: go install github.com/go-delve/delve");
		expect(noProgram).toContain("Name the program to run");
		expect(noRun).toContain("No debugging run. Start one with debug_start.");
	});

	describe.skipIf(process.platform === "win32")("with the write sandbox on", () => {
		/** Another platform's floor: its runner is not on this machine, so an adapter started inside it cannot start. */
		const elsewhere: NodeJS.Platform = process.platform === "darwin" ? "linux" : "darwin";

		it("starts the adapter inside the floor, or nothing when the floor cannot start", async () => {
			expect(
				confinedPlan(
					{ command: "/usr/bin/python3", args: ["-m", "debugpy.adapter"] },
					{ runner: "bwrap", args: ["--ro-bind", "/", "/", "--"] },
				),
			).toEqual({
				command: "bwrap",
				args: ["--ro-bind", "/", "/", "--", "/usr/bin/python3", "-m", "debugpy.adapter"],
			});

			const inside = await startPacks(harnesses, {
				responder: disclosing("Debugger"),
				packs: adapters(),
				confine: { probe: async () => ({ ok: true }), tmp: [], platform: elsewhere },
			});
			writeFileSync(join(inside.harness.tempDir, "prog.fake"), `${PROGRAM.join("\n")}\n`);
			inside.harness.setResponses([
				call("debug_start", { program: "prog.fake", breakpoints: [{ file: "prog.fake", line: 4 }] }),
				fauxAssistantMessage("It did not start."),
			]);
			await inside.harness.session.prompt("Debug prog.fake.");
			const runner = elsewhere === "linux" ? "bwrap" : "/usr/bin/sandbox-exec";
			expect(toolResults(inside.harness)[0]).toContain(
				`the debug adapter could not be started: spawn ${runner} ENOENT`,
			);

			const closed = await startPacks(harnesses, {
				responder: disclosing("Debugger"),
				packs: adapters(),
				confine: { probe: async () => ({ ok: false, reason: "no runner here" }), tmp: [] },
			});
			writeFileSync(join(closed.harness.tempDir, "prog.fake"), `${PROGRAM.join("\n")}\n`);
			closed.harness.setResponses([
				call("debug_start", { program: "prog.fake", breakpoints: [] }),
				fauxAssistantMessage("The sandbox cannot start."),
			]);
			await closed.harness.session.prompt("Debug prog.fake.");
			expect(toolResults(closed.harness)[0]).toContain(
				"mu: the write sandbox is on but cannot start here (no runner here). Nothing ran.",
			);
		});

		it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))(
			"runs the program where it can write only the project, and says so of a write it refused (macOS Seatbelt)",
			async () => {
				const away = realpathSync(mkdtempSync(join(tmpdir(), "mu-floor-dap-")));
				cleanup.push(() => rmSync(away, { recursive: true, force: true }));
				const { harness } = await startPacks(harnesses, {
					responder: disclosing("Debugger"),
					packs: adapters(),
					confine: { tmp: [] },
				});
				const outside = join(away, "made.txt");
				writeFileSync(
					join(harness.tempDir, "prog.fake"),
					["x = 1", "write inside.txt", `write ${outside}`, "print done", ""].join("\n"),
				);
				harness.setResponses([
					call("debug_start", { program: "prog.fake", breakpoints: [] }),
					fauxAssistantMessage("It ran."),
				]);
				await harness.session.prompt("Debug prog.fake.");
				const [result] = toolResults(harness);
				expect(result).toContain("The program ended");
				expect(existsSync(join(harness.tempDir, "inside.txt"))).toBe(true);
				expect(existsSync(outside)).toBe(false);
				expect(result).toContain("operation not permitted");
				expect(result).toContain(`[mu write sandbox: ${outside} is outside what commands may write here`);
				// mu's note comes before the program's output, which is not to be trusted.
				expect(result.indexOf("[mu write sandbox:")).toBeLessThan(result.indexOf("come from the program"));
			},
			30_000,
		);
	});

	it("ends a run that is still stopped when the session shuts down", async () => {
		const { root, dir } = tempArea("mu-dap-pid-");
		cleanup.push(() => rmSync(root, { recursive: true, force: true }));
		const pidfile = join(dir, "adapter.pid");
		const { harness } = await startPacks(harnesses, {
			responder: disclosing("Debugger"),
			packs: adapters({
				fake: { command: process.execPath, args: [FAKE, "--pidfile", pidfile], extensions: [".fake"] },
			}),
		});
		writeFileSync(join(harness.tempDir, "prog.fake"), `${PROGRAM.join("\n")}\n`);
		harness.setResponses([
			call("debug_start", { program: "prog.fake", breakpoints: [{ file: "prog.fake", line: 2 }] }),
			fauxAssistantMessage("Stopped at line 2."),
		]);
		await harness.session.prompt("Debug prog.fake.");
		expect(toolResults(harness)[0]).toContain("Stopped (breakpoint) at prog.fake:2.");
		const pid = Number(readFileSync(pidfile, "utf8"));
		const alive = () => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		expect(alive()).toBe(true);
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		for (let wait = 0; wait < 40 && alive(); wait++) await new Promise((resolve) => setTimeout(resolve, 50));
		expect(alive()).toBe(false);
	});

	it.skipIf(process.platform === "win32")(
		"ends the debugged program too when the adapter itself is already gone",
		async () => {
			const { root, dir } = tempArea("mu-dap-stray-");
			cleanup.push(() => rmSync(root, { recursive: true, force: true }));
			const strayFile = join(dir, "stray.pid");
			const pidfile = join(dir, "adapter.pid");
			const { harness } = await startPacks(harnesses, {
				responder: disclosing("Debugger"),
				packs: adapters({
					fake: {
						command: process.execPath,
						args: [FAKE, "--pidfile", pidfile, "--stray", strayFile],
						extensions: [".fake"],
					},
				}),
			});
			writeFileSync(join(harness.tempDir, "prog.fake"), `${PROGRAM.join("\n")}\n`);
			harness.setResponses([
				call("debug_start", { program: "prog.fake", breakpoints: [{ file: "prog.fake", line: 2 }] }),
				fauxAssistantMessage("Stopped at line 2."),
			]);
			await harness.session.prompt("Debug prog.fake.");
			const alive = (pid: number) => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			};
			const adapter = Number(readFileSync(pidfile, "utf8"));
			const stray = Number(readFileSync(strayFile, "utf8"));
			try {
				// The adapter dies on its own and leaves the program it started behind.
				process.kill(adapter, "SIGKILL");
				for (let wait = 0; wait < 40 && alive(adapter); wait++)
					await new Promise((resolve) => setTimeout(resolve, 50));
				await new Promise((resolve) => setTimeout(resolve, 100));
				expect(alive(stray)).toBe(true);

				await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				for (let wait = 0; wait < 40 && alive(stray); wait++)
					await new Promise((resolve) => setTimeout(resolve, 50));
				expect(alive(stray)).toBe(false);
			} finally {
				if (alive(stray)) process.kill(stray, "SIGKILL");
			}
		},
	);
});

/** A directory that surely holds no dlv. */
function nowhere(): string {
	return join(dirname(FAKE), "nowhere");
}

const python = spawnSync("python3", ["-c", "import debugpy"], { encoding: "utf8" }).status === 0;

describe.skipIf(!python)("pack:debugger with the real debugpy on this machine", () => {
	it("stops in a function twice, evaluates there, and stops again where an uncaught exception is raised", async () => {
		const { dir } = programFile([], "unused.fake");
		writeFileSync(
			join(dir, "app.py"),
			[
				"def area(width, height):",
				"    result = width * height",
				"    return result",
				"",
				"total = 0",
				"for size in [2, 3]:",
				"    total += area(size, size + 1)",
				'print("total", total)',
				"print(1 / (total - 18))",
				"",
			].join("\n"),
		);
		const client = new DapClient({
			plan: { command: "python3", args: ["-m", "debugpy.adapter"] },
			transport: "stdio",
			cwd: dir,
		});
		const session = new DebugSession(client, { ...LIMITS, stopTimeoutMs: 20_000 });
		cleanup.push(() => session.end());
		await client.start();
		const [debugpy] = builtInAdapters(process.platform);
		const program = join(dir, "app.py");
		const launched = await session.launch("debugpy", launchArguments(debugpy, { program, args: [], cwd: dir }), [
			{ file: program, line: 3 },
		]);
		expect(launched.breakpoints[0].verified).toBe(true);
		const first = stopped(launched.where);
		expect(first.frames[0]).toMatchObject({ name: "area", line: 3 });
		expect(first.frames[1]).toMatchObject({ name: "<module>", line: 7 });
		const values = Object.fromEntries(first.locals.map((variable) => [variable.name, variable.value]));
		expect(values).toMatchObject({ width: "2", height: "3", result: "6" });
		expect(await session.evaluate("width + height")).toMatchObject({ value: "5", type: "int" });
		expect((await session.evaluate("total", 1)).value).toBe("0");
		await expect(session.evaluate("result", 1)).rejects.toThrow("not defined");

		const second = stopped(await session.step("continue"));
		expect(Object.fromEntries(second.locals.map((variable) => [variable.name, variable.value]))).toMatchObject({
			width: "3",
			result: "12",
		});
		const crash = stopped(await session.step("continue"));
		expect(crash.reason).toBe("exception");
		expect(crash.exception).toContain("ZeroDivisionError");
		expect(crash.frames[0].line).toBe(9);
		expect(session.output()).toContain("total 18");
		await session.end();
	}, 60_000);
});
