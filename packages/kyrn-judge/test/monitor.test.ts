import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";
import { turnDrift } from "../src/decisions/turn-drift.ts";
import {
	actionLine,
	DriftWatch,
	type ObservedCall,
	Progress,
	testCounts,
	type WatchOptions,
	writtenPaths,
} from "../src/extension/features/monitor.ts";
import { createKyrnJudgeExtension, type FeatureName } from "../src/extension/kyrn-judge.ts";
import type { LedgerRecord } from "../src/ledger.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import type { Answer, JudgeRequest } from "../src/types.ts";

const MINUTE = 60_000;
const OPTIONS: WatchOptions = {
	every: 6,
	minMinutes: 3,
	maxMinutes: 10,
	stuckMinutes: 10,
	cooldownMinutes: 15,
	window: 8,
};

const read = (path: string): ObservedCall => ({ toolName: "read", input: { path }, isError: false, text: "x" });
const make = (lastLine: string, exitCode = 2): ObservedCall => ({
	toolName: "bash",
	input: { command: "make" },
	isError: exitCode !== 0,
	text: `cc -c main.c\n${lastLine}\n\nCommand exited with code ${exitCode}`,
	exitCode,
	durationMs: 14_000,
});

/** A watch at minute 0, with `count` reads observed at the given minute. */
function watchWith(count: number, atMinute = 0, options: WatchOptions = OPTIONS): DriftWatch {
	const watch = new DriftWatch(options, 0);
	for (let index = 0; index < count; index++) watch.observe(read(`/src/${index}.ts`), atMinute * MINUTE);
	return watch;
}

describe("turn.drift v2: when the monitor asks", () => {
	it("asks after 6 results once 3 minutes have passed, and after 10 minutes whatever happened", () => {
		const busy = watchWith(6);
		expect(busy.due(2.9 * MINUTE)).toBe(false);
		expect(busy.due(3 * MINUTE)).toBe(true);

		const quiet = watchWith(5);
		expect(quiet.due(9.9 * MINUTE)).toBe(false);
		expect(quiet.due(10 * MINUTE)).toBe(true);
		expect(quiet.untilDue(4 * MINUTE)).toBe(6 * MINUTE);
	});

	it("counts both from the last check", () => {
		const watch = watchWith(6);
		watch.ask({ goal: "Fix the build" }, 4 * MINUTE);
		expect(watch.due(4 * MINUTE)).toBe(false);
		for (let index = 0; index < 6; index++) watch.observe(read(`/lib/${index}.ts`), 5 * MINUTE);
		expect(watch.due(6.9 * MINUTE)).toBe(false);
		expect(watch.due(7 * MINUTE)).toBe(true);
		expect(watch.untilDue(4 * MINUTE)).toBe(10 * MINUTE);
	});

	it("does not count the time between runs", () => {
		const watch = watchWith(1);
		watch.pause(2 * MINUTE);
		watch.resume(62 * MINUTE);
		expect(watch.due(69.9 * MINUTE)).toBe(false);
		expect(watch.due(70 * MINUTE)).toBe(true);
		expect(watch.ask({ goal: "Fix the build" }, 70 * MINUTE)).toMatchObject({
			elapsedMinutes: 10,
			minutesSinceProgress: 10,
		});
	});
});

describe("turn.drift v2: what the monitor does with a reading", () => {
	it("steers on drift only twice in a row, after 10 minutes without progress", () => {
		const once = watchWith(6);
		expect(once.read("drift", 12 * MINUTE)).toBeUndefined();
		expect(once.read("drift", 15 * MINUTE)).toMatchObject({ kind: "drift", minutes: 15 });

		const broken = watchWith(6);
		expect(broken.read("drift", 12 * MINUTE)).toBeUndefined();
		expect(broken.read("on_track", 15 * MINUTE)).toBeUndefined();
		expect(broken.read("drift", 18 * MINUTE)).toBeUndefined();
		// A check the judge did not answer breaks the run of drift readings too.
		expect(broken.read(undefined, 21 * MINUTE)).toBeUndefined();
		expect(broken.read("drift", 24 * MINUTE)).toBeUndefined();
		expect(broken.read("drift", 27 * MINUTE)).toMatchObject({ kind: "drift" });

		const moving = watchWith(6);
		moving.observe(make("error: missing header foo.h"), 8 * MINUTE);
		expect(moving.read("drift", 12 * MINUTE)).toBeUndefined();
		expect(moving.read("drift", 15 * MINUTE)).toBeUndefined();
		expect(moving.read("drift", 18 * MINUTE)).toMatchObject({ kind: "drift", minutes: 10 });
	});

	it("steers on a loop reading once per call, like the loop rule", () => {
		const watch = watchWith(2);
		watch.observe(make("error: missing header foo.h"), MINUTE);
		watch.observe(make("error: missing header foo.h"), 2 * MINUTE);
		watch.observe(make("error: missing header foo.h"), 3 * MINUTE);
		const steer = watch.read("loop", 4 * MINUTE);
		expect(steer).toMatchObject({ kind: "loop", times: 3 });
		expect(steer?.kind === "loop" && steer.action).toContain("bash: make -> exit 2");
		// Past the cool-down, the same call is not named again.
		expect(watch.read("loop", 30 * MINUTE)).toBeUndefined();
	});

	it("steers at most once per 15 minutes, the loop rule's steers included", () => {
		const watch = watchWith(6);
		watch.read("drift", 10 * MINUTE);
		expect(watch.read("drift", 13 * MINUTE)).toMatchObject({ kind: "drift" });
		expect(watch.read("drift", 16 * MINUTE)).toBeUndefined();
		expect(watch.read("drift", 27.9 * MINUTE)).toBeUndefined();
		expect(watch.read("drift", 28 * MINUTE)).toMatchObject({ kind: "drift" });

		const looping = watchWith(6);
		looping.read("drift", 10 * MINUTE);
		looping.read("drift", 13 * MINUTE);
		looping.observe(make("error: missing header foo.h"), 14 * MINUTE);
		looping.observe(make("error: missing header foo.h"), 15 * MINUTE);
		expect(looping.read("loop", 20 * MINUTE)).toBeUndefined();
		expect(looping.read("loop", 28 * MINUTE)).toMatchObject({ kind: "loop", times: 2 });

		const ruled = watchWith(6);
		ruled.steeredOnLoop(11 * MINUTE);
		ruled.read("drift", 12 * MINUTE);
		expect(ruled.read("drift", 15 * MINUTE)).toBeUndefined();
		expect(ruled.read("drift", 26 * MINUTE)).toMatchObject({ kind: "drift" });
	});

	it("reads drift at 0.9 and a loop at 0.8, not below", () => {
		const course = (choice: string, probability: number) =>
			turnDrift.policy(
				{ course: { type: "choice", choice, probabilities: { [choice]: probability } } } as never,
				undefined as never,
			);
		expect(turnDrift.version).toBe(2);
		expect(course("drift", 0.89)).toBe("unknown");
		expect(course("drift", 0.9)).toBe("drift");
		expect(course("loop", 0.79)).toBe("unknown");
		expect(course("loop", 0.8)).toBe("loop");
		expect(course("on_track", 0.7)).toBe("on_track");
		expect(course("other", 0.99)).toBe("unknown");
	});
});

describe("turn.drift v2: what the judge sees", () => {
	it("the goal, the open item, actions with exit code, time and last line, progress, time and repeats", () => {
		const watch = new DriftWatch(OPTIONS, 0);
		watch.observe(
			{
				toolName: "write",
				input: { path: "src/main.c", content: "int main() {}" },
				isError: false,
				text: "ok",
				durationMs: 20,
			},
			MINUTE,
		);
		for (const minute of [3, 9, 15]) watch.observe(make("error: missing header foo.h"), minute * MINUTE);
		const input = watch.ask(
			{ goal: "Build the project", subgoal: "Only the CLI", openItem: "make exits 0" },
			16 * MINUTE,
		);
		expect(input).toEqual({
			goal: "Build the project",
			subgoal: "Only the CLI",
			openItem: "make exits 0",
			recentActions: [
				"write: src/main.c -> ok in 0s",
				"bash: make -> exit 2 in 14s; last line: error: missing header foo.h",
				"bash: make -> exit 2 in 14s; last line: error: missing header foo.h",
				"bash: make -> exit 2 in 14s; last line: error: missing header foo.h",
			],
			// The first error was news; the same one twice more is not.
			minutesSinceProgress: 13,
			elapsedMinutes: 16,
			repeats: 3,
		});
		expect(turnDrift.buildState(input)).toEqual({
			goal: "Build the project",
			current_subgoal: "Only the CLI",
			open_item: "make exits 0",
			recent_actions: input.recentActions,
			minutes_since_progress: 13,
			elapsed_minutes: 16,
			repeats_in_window: 3,
		});
	});

	it("keeps the state small: the last 8 actions, each cut short", () => {
		const watch = new DriftWatch(OPTIONS, 0);
		for (let index = 0; index < 20; index++) {
			watch.observe(
				{
					toolName: "bash",
					input: { command: `${"x".repeat(5000)} ${index}` },
					isError: false,
					text: `${"y".repeat(50_000)}\nz${"w".repeat(5000)}`,
					exitCode: 0,
				},
				0,
			);
		}
		const state = JSON.stringify(turnDrift.buildState(watch.ask({ goal: "g".repeat(300) }, 0)));
		expect(watch.ask({ goal: "g" }, 0).recentActions).toHaveLength(8);
		expect(state.length).toBeLessThan(3500);
	});

	it("an action line names the tool, the call, how it ended, how long it took and, for a command, its last line", () => {
		expect(actionLine(make("ld: cannot find -lfoo", 1))).toBe(
			"bash: make -> exit 1 in 14s; last line: ld: cannot find -lfoo",
		);
		expect(
			actionLine({ toolName: "bash", input: { command: "sleep 200" }, isError: true, text: "Command aborted" }),
		).toBe("bash: sleep 200 -> error");
		expect(actionLine({ ...read("/app/vm.js"), durationMs: 150_000 })).toBe("read: /app/vm.js -> ok in 3 min");
		expect(
			actionLine({ toolName: "edit", input: { path: "a.ts" }, isError: true, text: "Could not find the text" }),
		).toBe("edit: a.ts -> error; last line: Could not find the text");
	});

	it("progress: a new file, more tests passing, a different error, a failing call passing, an item ticked", () => {
		const progress = new Progress();
		const bash = (command: string, text: string, exitCode = 0): ObservedCall => ({
			toolName: "bash",
			input: { command },
			isError: exitCode !== 0,
			text,
			exitCode,
		});
		expect(progress.observe(read("a.ts"))).toBe(false);
		expect(progress.observe({ toolName: "write", input: { path: "a.ts" }, isError: false, text: "ok" })).toBe(true);
		expect(progress.observe({ toolName: "edit", input: { path: "a.ts" }, isError: false, text: "ok" })).toBe(false);
		expect(progress.observe(bash("cat > b.py <<'EOF'\nif a > b:\n    pass\nEOF", ""))).toBe(true);
		expect(progress.observe(bash("pytest", "== 2 failed, 3 passed in 0.4s ==", 1))).toBe(true);
		expect(progress.observe(bash("pytest", "== 2 failed, 3 passed in 0.5s ==", 1))).toBe(false);
		expect(progress.observe(bash("pytest", "== 1 failed, 4 passed in 0.5s ==", 1))).toBe(true);
		expect(progress.observe(bash("make", "error: x.h", 2))).toBe(true);
		expect(progress.observe(bash("make", "error: x.h", 2))).toBe(false);
		expect(progress.observe(bash("make", "ok"))).toBe(true);
		// A long call that succeeds did work, whatever it wrote; the same one again is waiting.
		expect(progress.observe({ ...bash("./ocr-all-frames.sh", "190"), durationMs: 9 * MINUTE })).toBe(true);
		expect(progress.observe({ ...bash("./ocr-all-frames.sh", "190"), durationMs: 9 * MINUTE })).toBe(false);
		expect(progress.observe({ ...bash("sleep 5", ""), durationMs: 5000 })).toBe(false);
		expect(
			progress.observe({ toolName: "todo", input: { action: "done", id: "a1" }, isError: false, text: "" }),
		).toBe(true);

		expect(writtenPaths(bash("python gen.py > out.txt 2>/dev/null && tee -a log.txt < out.txt 2>&1", ""))).toEqual([
			"out.txt",
			"log.txt",
		]);
		expect(writtenPaths(bash("echo 'a > b' | grep a", ""))).toEqual([]);
		expect(testCounts("Tests:       2 failed, 5 passed, 7 total")).toEqual({ passed: 5, failed: 2 });
		expect(testCounts("FAILED (failures=3)")).toEqual({ passed: undefined, failed: 3 });
		expect(testCounts("test result: ok. 12 passed; 0 failed; 0 ignored")).toEqual({ passed: 12, failed: 0 });
	});
});

describe("turn.drift v2 in a session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const drift: Answer = { type: "choice", choice: "drift", probabilities: { drift: 0.95, on_track: 0.05 } };
	const courseCalls = (provider: MockJudgeProvider): JudgeRequest[] =>
		provider.calls.filter((call) => "course" in call.questions);

	function tool(name: string, run: (params: Record<string, unknown>) => string): AgentTool {
		return {
			name,
			label: name,
			description: name,
			parameters: Type.Object({}, { additionalProperties: true }),
			execute: async (_id, params) => ({
				content: [{ type: "text", text: run((params ?? {}) as Record<string, unknown>) }],
				details: {},
			}),
		};
	}

	/** A shell that fails `make` the way pi's bash tool does, with the exit code at the end. */
	const bash = tool("bash", (params) => {
		if (params.command === "make")
			throw new Error("cc -c main.c\nerror: missing header foo.h\n\nCommand exited with code 2");
		return "Makefile\nmain.c";
	});

	async function start(
		responder: MockResponder,
		extra: {
			monitor?: Record<string, unknown>;
			modes?: Record<string, string>;
			only?: FeatureName[];
			tokensPerSecond?: number;
		} = {},
	) {
		const provider = new MockJudgeProvider(responder);
		const harness = await createHarness({
			tools: [bash, tool("read", (params) => `contents of ${String(params.path)}`)],
			tokensPerSecond: extra.tokensPerSecond,
			extensionFactories: [
				createKyrnJudgeExtension({
					provider,
					mode: "active",
					only: extra.only ?? ["preflight", "monitor"],
					config: parseConfig({
						modes: extra.modes,
						// `unattended`: the harness runs in print mode, where the drift check may be off by default.
						features: { memory: false, monitor: { unattended: true, ...extra.monitor } },
					}),
				}),
			],
		});
		harnesses.push(harness);
		const entries = <T>(customType: string): T[] =>
			harness.sessionManager
				.getBranch()
				.flatMap((entry) => (entry.type === "custom" && entry.customType === customType ? [entry.data as T] : []));
		const steers = () =>
			harness.session.messages
				.filter((message) => message.role === "custom" && message.customType === "kyrn.steer")
				.map((message) => String((message as { content?: unknown }).content));
		return { harness, provider, entries, steers };
	}

	const call = (name: string, params: Parameters<typeof fauxToolCall>[1]) =>
		fauxAssistantMessage([fauxToolCall(name, params)], { stopReason: "toolUse" });

	it("is in shadow by default", () => {
		expect(DEFAULT_CONFIG.modes["turn.drift"]).toBe("shadow");
	});

	it("shows the judge the open item and each action's exit code, time and last line, and records version 2", async () => {
		const { harness, provider, entries } = await start(() => ({}), {
			only: ["preflight", "frame", "monitor"],
			monitor: { every: 4, minMinutes: 0 },
			modes: { "turn.drift": "active" },
		});
		harness.setResponses([
			call("todo", { action: "add", text: "make builds without errors" }),
			call("bash", { command: "make" }),
			call("bash", { command: "make" }),
			call("bash", { command: "ls" }),
			fauxAssistantMessage("The header is missing."),
		]);

		await harness.session.prompt("Fix the build of this C project.");

		const [asked] = courseCalls(provider);
		expect(asked.state).toEqual({
			goal: "Fix the build of this C project.",
			open_item: "make builds without errors",
			// The time is measured from the call to its result: these tools answer at once.
			recent_actions: [
				expect.stringMatching(/^todo: \{"action":"add","text":"make builds without errors"\} -> ok in \d+s$/),
				expect.stringMatching(/^bash: make -> exit 2 in \d+s; last line: error: missing header foo\.h$/),
				expect.stringMatching(/^bash: make -> exit 2 in \d+s; last line: error: missing header foo\.h$/),
				expect.stringMatching(/^bash: ls -> exit 0 in \d+s; last line: main\.c$/),
			],
			minutes_since_progress: 0,
			elapsed_minutes: 0,
			repeats_in_window: 2,
		});
		const records = entries<LedgerRecord>("kyrn.decision").filter((record) => record.specId === "turn.drift");
		expect(records.map((record) => record.specVersion)).toEqual([2]);
	});

	it("asks on a timer while a long reply runs, with no new tool result", async () => {
		const asked: number[] = [];
		const { harness, provider } = await start(
			(request) => {
				if ("course" in request.questions) asked.push(harness.faux.state.callCount);
				return {};
			},
			{ monitor: { every: 100, maxMinutes: 0.01 }, tokensPerSecond: 200 },
		);
		harness.setResponses([
			call("bash", { command: "ls" }),
			fauxAssistantMessage([fauxText(`Reading the listing. ${"Each file and what it is for. ".repeat(60)}`)]),
		]);

		await harness.session.prompt("Look around this C project.");

		// Asked while the second reply was being written, when no tool result came: only the timer asks then.
		expect(asked).toContain(2);
		for (const call of courseCalls(provider)) {
			expect((call.state as { recent_actions: string[] }).recent_actions).toHaveLength(1);
		}
	});

	it("steers once on drift read twice in a row, then waits out the cool-down", async () => {
		const { harness, provider, entries, steers } = await start(
			(request): Record<string, Answer> => ("course" in request.questions ? { course: drift } : {}),
			{ monitor: { every: 2, minMinutes: 0, stuckMinutes: 0 }, modes: { "turn.drift": "active" } },
		);
		harness.setResponses([
			...Array.from({ length: 10 }, (_, index) => call("read", { path: `/src/${index}.c` })),
			fauxAssistantMessage("Read everything."),
		]);

		await harness.session.prompt("Fix the build of this C project.");

		expect(courseCalls(provider).length).toBeGreaterThanOrEqual(3);
		expect(steers()).toHaveLength(1);
		expect(steers()[0]).toMatch(
			/^Check your course: nothing has moved in 0 minutes, and the recent steps \(latest: read: /,
		);
		expect(steers()[0]).toContain("Try a different approach");
		// Not on the first drift reading: at least two checks, so at least four results, came before it.
		const messages = harness.session.messages;
		const at = messages.findIndex((message) => message.role === "custom" && message.customType === "kyrn.steer");
		expect(messages.slice(0, at).filter((message) => message.role === "toolResult").length).toBeGreaterThanOrEqual(4);
		expect(entries("kyrn.monitor")).toEqual([{ kind: "drift", judged: true, content: steers()[0] }]);
	});

	it("in shadow, records the steer it would have sent and sends nothing", async () => {
		const { harness, provider, entries, steers } = await start(
			(request): Record<string, Answer> => ("course" in request.questions ? { course: drift } : {}),
			{ monitor: { every: 2, minMinutes: 0, stuckMinutes: 0 } },
		);
		harness.setResponses([
			...Array.from({ length: 10 }, (_, index) => call("read", { path: `/src/${index}.c` })),
			fauxAssistantMessage("Read everything."),
		]);

		await harness.session.prompt("Fix the build of this C project.");

		expect(courseCalls(provider).length).toBeGreaterThanOrEqual(3);
		expect(steers()).toEqual([]);
		expect(entries("kyrn.monitor")).toEqual([
			{ kind: "drift", judged: true, shadow: true, content: expect.stringContaining("Check your course") },
		]);
	});
});
