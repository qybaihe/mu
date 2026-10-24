import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type Context,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import type { SwarmRunner } from "../src/extension/features/swarm.ts";
import { cutUsage, registerWatchdog, WATCHDOG_MESSAGE } from "../src/extension/features/watchdog.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { KyrnRuntime } from "../src/extension/runtime.ts";
import { Judge } from "../src/judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import { type BeeRunner, SwarmRun, subagentUsage } from "../src/swarm/run.ts";
import type { BeeEvent } from "../src/swarm/state.ts";
import { REASONING_CHARS_PER_TOKEN, USAGE_ENTRY, type UsageEntry } from "../src/usage.ts";

const MIMO = { provider: "xiaomi", id: "mimo-v2.6-pro", cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0 } };

/** An aborted reply as an OpenAI-compatible provider leaves it: the reasoning that streamed, and no usage. */
function abortedReply(thinking: string, output = 0): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking }],
		api: "openai-completions",
		provider: "xiaomi",
		model: "mimo-v2.6-pro",
		usage: {
			input: 0,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "aborted",
		errorMessage: "Request was aborted",
		timestamp: 0,
	};
}

const usageEntries = (harness: Harness): UsageEntry[] =>
	harness.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === USAGE_ENTRY ? [entry.data as UsageEntry] : [],
		);

describe("what a cut reply spent", () => {
	it("is estimated from the reasoning that streamed, priced at the model's output rate", () => {
		// 27,000 thinking tokens' worth of reasoning, as in a typical Terminal-Bench cut.
		const chars = 27_000 * REASONING_CHARS_PER_TOKEN;
		const entry = cutUsage(abortedReply("x".repeat(chars)), chars, 600_000, MIMO as unknown as Model<Api>);
		expect(entry).toEqual({
			source: "watchdog-cut",
			model: "xiaomi/mimo-v2.6-pro",
			input: 0,
			output: 27_000,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 27_000 * (3 / 1_000_000),
			estimated: true,
			estimatedOutput: 27_000,
			thoughtChars: chars,
			thinkingMs: 600_000,
		});
	});

	it("never counts twice what the provider did report, and has no price for another model", () => {
		// 2,000 tokens estimated, 1,500 reported on the aborted message: 500 are added.
		expect(cutUsage(abortedReply("x".repeat(7000), 1500), 7000, 1000, undefined)).toMatchObject({
			output: 500,
			estimatedOutput: 500,
		});
		// The provider reported all of it, or more: nothing to add.
		expect(cutUsage(abortedReply("x".repeat(7000), 2000), 7000, 1000, undefined)).toBeUndefined();
		// The streamed count stands in for reasoning the message did not keep.
		expect(cutUsage(abortedReply(""), 7000, 1000, undefined)).toMatchObject({ output: 2000, thoughtChars: 7000 });
		// Priced only with the model that wrote it.
		const other = { ...MIMO, id: "mimo-v2.6-flash" } as unknown as Model<Api>;
		expect(cutUsage(abortedReply("x".repeat(7000)), 7000, 1000, other)).not.toHaveProperty("cost");
	});
});

describe("the watchdog records what a cut reply spent", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("as a kyrn.usage entry once the cut run has settled, before it asks again", async () => {
		vi.useFakeTimers();
		const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
		const calls: { what: string; type: string; data?: unknown }[] = [];
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			appendEntry: (type: string, data: unknown) => calls.push({ what: "entry", type, data }),
			sendMessage: (message: { customType: string }) => calls.push({ what: "message", type: message.customType }),
			getCommands: () => [],
		} as unknown as ExtensionAPI;
		const runtime = new KyrnRuntime(pi, parseConfig({}), new Judge({ provider: new MockJudgeProvider() }));
		registerWatchdog(runtime);
		const ctx = { abort: () => {}, model: MIMO } as unknown as ExtensionContext;
		const emit = async (type: string, event: Record<string, unknown>) => {
			for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, ctx);
		};

		await emit("message_start", { message: { role: "assistant" } });
		// More than the watchdog keeps of it for the retry: the estimate counts all of it.
		for (let at = 0; at < 7; at++) {
			await emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "y".repeat(1000) } });
		}
		await vi.advanceTimersByTimeAsync(600_000);
		await emit("message_end", { message: abortedReply("y".repeat(7000)) });
		expect(calls).toEqual([]);
		await emit("agent_settled", {});

		expect(calls.map((call) => [call.what, call.type])).toEqual([
			["entry", USAGE_ENTRY],
			["message", WATCHDOG_MESSAGE],
		]);
		expect(calls[0].data).toMatchObject({
			source: "watchdog-cut",
			model: "xiaomi/mimo-v2.6-pro",
			output: 2000,
			estimated: true,
			thoughtChars: 7000,
			thinkingMs: 600_000,
		});

		// The retry is never cut, and a reply that was not cut records nothing.
		calls.length = 0;
		await emit("message_start", { message: { role: "assistant" } });
		await vi.advanceTimersByTimeAsync(3_600_000);
		await emit("message_end", { message: { ...abortedReply("z"), stopReason: "stop" } });
		await emit("agent_settled", {});
		expect(calls).toEqual([]);
	});

	it("adds nothing when the aborted message already carries the output", async () => {
		const harness = await createHarness({
			tokensPerSecond: 200,
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					mode: "active",
					config: parseConfig({ features: { memory: false, watchdog: { thinkingMs: 300 } } }),
					only: ["watchdog"],
				}),
			],
		});
		try {
			const long = `Start with the parser. ${"Consider the next case and what it implies. ".repeat(28)}`;
			harness.setResponses([
				fauxAssistantMessage([fauxThinking(long), fauxText("never sent")]),
				fauxAssistantMessage("Fixed the tokenizer."),
			]);
			await harness.session.prompt("Fix the parser.");
			expect(harness.faux.state.callCount).toBe(2);
			// The faux provider reports the whole reply's output even on the aborted message: more than streamed.
			const aborted = harness.session.messages.find(
				(message): message is AssistantMessage => message.role === "assistant" && message.stopReason === "aborted",
			);
			expect(aborted?.usage.output).toBeGreaterThan(0);
			expect(usageEntries(harness)).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});
});

describe("a sub-agent's spend", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});
	const tempDir = () => {
		const dir = mkdtempSync(join(tmpdir(), "kyrn-usage-test-"));
		dirs.push(dir);
		return dir;
	};

	const reply = (usage: Record<string, unknown>): BeeEvent => ({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "Found it." }], stopReason: "stop", usage },
	});
	/** What a child's own watchdog records, as its JSON stream shows it. */
	const childCut: BeeEvent = {
		type: "entry_appended",
		entry: {
			type: "custom",
			customType: USAGE_ENTRY,
			data: {
				source: "watchdog-cut",
				input: 0,
				output: 2000,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0.006,
				estimated: true,
				estimatedOutput: 2000,
			},
		},
	};

	it("is recorded for every bee that ran, partial for one that was stopped, with its own cuts counted", async () => {
		const controller = new AbortController();
		const run = new SwarmRun<string>({
			kind: "hive",
			title: "why",
			dir: tempDir(),
			limits: { concurrency: 1 },
			bees: ["repro", "history", "late"].map((name) => ({
				name,
				task: { title: name, instructions: name },
				assignment: "a",
				role: "investigator",
				model: "xiaomi/mimo-v2.6-pro",
			})),
		});
		const ended: UsageEntry[] = [];
		run.onBeeEnd = (bee) => {
			const entry = subagentUsage(run.kind, bee);
			if (entry) ended.push(entry);
		};
		const runner: BeeRunner<string> = (task, _assignment, signal, _env, observer) =>
			new Promise((resolve, reject) => {
				observer?.event({ type: "agent_start" });
				observer?.event(
					reply({ input: 1000, output: 300, cacheRead: 4000, cacheWrite: 50, cost: { total: 0.002 } }),
				);
				if (task.title === "repro") {
					observer?.event(childCut);
					observer?.event({ type: "agent_settled" });
					resolve("Found it.");
					return;
				}
				// Stopped mid-request: what that request used is never reported.
				signal?.addEventListener("abort", () => reject(new Error("the subagent was stopped")), { once: true });
			});
		const finished = run.run(runner, controller.signal);
		await vi.waitFor(() => expect(run.bees[1].status).toBe("thinking"));
		controller.abort();
		await finished;

		expect(ended).toEqual([
			{
				source: "subagent",
				kind: "hive",
				name: "repro",
				role: "investigator",
				model: "xiaomi/mimo-v2.6-pro",
				input: 1000,
				output: 2300,
				cacheRead: 4000,
				cacheWrite: 50,
				cost: 0.008,
				estimated: true,
				estimatedOutput: 2000,
				status: "done",
				turns: 0,
			},
			expect.objectContaining({ name: "history", output: 300, partial: true, status: "stopped" }),
		]);
		// "late" never started: it spent nothing, and nothing is recorded for it.
		expect(run.bees[2].status).toBe("stopped");
	});

	it("goes into the parent's session as a kyrn.usage entry the model never reads", async () => {
		const runner: SwarmRunner = async (_task, _assignment, _signal, _env, observer) => {
			observer?.event({ type: "agent_start" });
			observer?.event(reply({ input: 1200, output: 300, cacheRead: 5000, cacheWrite: 100, cost: { total: 0.004 } }));
			observer?.event({ type: "agent_settled" });
			return "Found it.";
		};
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					mode: "active",
					config: parseConfig({ features: { memory: false, swarm: { isolation: "none" } } }),
					only: ["swarm"],
					swarmRunner: runner,
				}),
			],
		});
		try {
			let seen = "";
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("delegate", { tasks: [{ title: "look", instructions: "Find it" }] })], {
					stopReason: "toolUse",
				}),
				(context: Context) => {
					seen = JSON.stringify(context);
					return fauxAssistantMessage("Done.");
				},
			]);
			await harness.session.prompt("Find it.");

			const model = harness.getModel();
			expect(usageEntries(harness)).toEqual([
				{
					source: "subagent",
					kind: "delegate",
					name: "look",
					role: "worker",
					model: `${model.provider}/${model.id}`,
					input: 1200,
					output: 300,
					cacheRead: 5000,
					cacheWrite: 100,
					cost: 0.004,
					status: "done",
					turns: 0,
				},
			]);
			expect(seen).toContain("Found it.");
			expect(seen).not.toContain(USAGE_ENTRY);
			expect(seen).not.toContain('"subagent"');
		} finally {
			harness.cleanup();
		}
	});
});
