import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { DEADLINE_MESSAGE, deadlineNotice, registerDeadline, runDeadline } from "../src/extension/features/deadline.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { KyrnRuntime } from "../src/extension/runtime.ts";
import { Judge } from "../src/judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface Sent {
	message: { customType: string; content: unknown; details?: unknown };
	options?: { deliverAs?: string; triggerTurn?: boolean };
}

/** Just enough of pi to register the feature, fire its events and see what it sends. */
function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const sent: Sent[] = [];
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		sendMessage: (message: Sent["message"], options?: Sent["options"]) => {
			sent.push({ message, options });
		},
		appendEntry: () => {},
		getCommands: () => [],
	} as unknown as ExtensionAPI;
	const emit = async (event: string) => {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event }, {} as ExtensionContext);
	};
	return { pi, emit, sent };
}

function start(features: Record<string, unknown> = {}) {
	const fake = fakePi();
	const runtime = new KyrnRuntime(
		fake.pi,
		parseConfig({ features }),
		new Judge({ provider: new MockJudgeProvider() }),
	);
	registerDeadline(runtime);
	return { ...fake, runtime };
}

const said = (sent: Sent[]) => sent.map((entry) => String(entry.message.content));

describe("the run deadline", () => {
	it("takes the budget from MU_TIME_BUDGET_S, else from the option, counted from the start", () => {
		expect(runDeadline("900", 60, 1_000)).toBe(901_000);
		expect(runDeadline(" 1.5 ", undefined, 0)).toBe(1_500);
		expect(runDeadline(undefined, 60, 1_000)).toBe(61_000);
		// Not a positive number of seconds: no budget from there.
		expect(runDeadline("soon", 60, 0)).toBe(60_000);
		expect(runDeadline("", 0, 0)).toBeUndefined();
		expect(runDeadline("0", -5, 0)).toBeUndefined();
		expect(runDeadline(undefined, "300", 0)).toBe(300_000);
	});

	it("says how much time is left, and at 80% asks for the result first", () => {
		expect(deadlineNotice(50, 450_000)).toBe("Time check: 50% of this run's time budget is gone, 7 minutes left.");
		expect(deadlineNotice(80, 180_000)).toBe(
			"Time check: 80% of this run's time budget is gone, 3 minutes left. Make sure the requested result is in place (files written, services running) before you polish anything.",
		);
		expect(deadlineNotice(80, 30_000)).toContain("less than a minute left");
		expect(deadlineNotice(50, 60_000)).toContain(" 1 minute left");
	});
});

describe("time notices", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		// The process starts now, as far as the budget is concerned.
		vi.spyOn(process, "uptime").mockReturnValue(0);
		vi.stubEnv("MU_TIME_BUDGET_S", "");
		vi.stubEnv("KYRN_TIME_BUDGET_S", "");
		vi.stubEnv("KYRN_SWARM_DEPTH", "");
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("tells the model at 50% and at 80% of the budget, as a steer, and nothing more", async () => {
		vi.stubEnv("MU_TIME_BUDGET_S", "600");
		const { emit, sent, runtime } = start();
		expect(runtime.deadlineAt).toBe(Date.now() + 600_000);
		await emit("agent_start");

		await vi.advanceTimersByTimeAsync(299_999);
		expect(sent).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(said(sent)).toEqual(["Time check: 50% of this run's time budget is gone, 5 minutes left."]);
		expect(sent[0].message).toMatchObject({
			customType: DEADLINE_MESSAGE,
			details: { percent: 50, leftMs: 300_000 },
		});
		expect(sent[0].options).toEqual({ deliverAs: "steer" });

		await vi.advanceTimersByTimeAsync(180_000);
		expect(sent).toHaveLength(2);
		expect(said(sent)[1]).toBe(
			"Time check: 80% of this run's time budget is gone, 2 minutes left. Make sure the requested result is in place (files written, services running) before you polish anything.",
		);
		expect(sent[1].options).toEqual({ deliverAs: "steer" });

		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(sent).toHaveLength(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reads the budget from mu.json when the variable is not set, and the variable wins over it", async () => {
		const fromOption = start({ deadline: { budgetS: 100 } });
		expect(fromOption.runtime.deadlineAt).toBe(Date.now() + 100_000);
		vi.stubEnv("MU_TIME_BUDGET_S", "200");
		const fromEnv = start({ deadline: { budgetS: 100 } });
		expect(fromEnv.runtime.deadlineAt).toBe(Date.now() + 200_000);
	});

	it("says nothing once the run has ended, and stops for good when the session does", async () => {
		vi.stubEnv("MU_TIME_BUDGET_S", "600");
		const { emit, sent } = start();
		await emit("agent_start");
		await vi.advanceTimersByTimeAsync(100_000);
		await emit("agent_end");
		await vi.advanceTimersByTimeAsync(600_000);
		expect(sent).toEqual([]);
		await emit("session_shutdown");
		expect(vi.getTimerCount()).toBe(0);
		// A run after the session ended hears nothing either.
		await emit("agent_start");
		expect(sent).toEqual([]);
	});

	it("tells a level reached between runs when the next run starts, and only the latest of two", async () => {
		vi.stubEnv("MU_TIME_BUDGET_S", "600");
		const { emit, sent } = start();
		await vi.advanceTimersByTimeAsync(310_000);
		expect(sent).toEqual([]);
		await emit("agent_start");
		expect(said(sent)).toEqual(["Time check: 50% of this run's time budget is gone, 4 minutes left."]);
		await emit("agent_end");

		await vi.advanceTimersByTimeAsync(200_000);
		await emit("agent_start");
		expect(sent).toHaveLength(2);
		expect(sent[1].message.details).toMatchObject({ percent: 80 });

		// Both levels passed while idle: one notice, the later one.
		const late = start();
		await vi.advanceTimersByTimeAsync(500_000);
		await late.emit("agent_start");
		expect(late.sent.map((entry) => entry.message.details)).toEqual([{ percent: 80, leftMs: 100_000 }]);
	});

	it("keeps the deadline but says nothing with notices off", async () => {
		vi.stubEnv("MU_TIME_BUDGET_S", "600");
		const { emit, sent, runtime } = start({ deadline: { notices: false } });
		expect(runtime.deadlineAt).toBe(Date.now() + 600_000);
		await emit("agent_start");
		await vi.advanceTimersByTimeAsync(600_000);
		expect(sent).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does nothing at all without a budget, or in a sub-agent, or when switched off", async () => {
		for (const features of [{}, { deadline: { budgetS: 0 } }, { deadline: false }]) {
			const { emit, sent, runtime } = start(features);
			expect(runtime.deadlineAt).toBeUndefined();
			await emit("agent_start");
			await vi.advanceTimersByTimeAsync(24 * 3_600_000);
			expect(sent).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
		}
		vi.stubEnv("MU_TIME_BUDGET_S", "600");
		vi.stubEnv("KYRN_SWARM_DEPTH", "1");
		const child = start();
		expect(child.runtime.deadlineAt).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("time notices in a session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		vi.restoreAllMocks();
	});

	it("never keeps the process alive", () => {
		vi.stubEnv("MU_TIME_BUDGET_S", "600");
		vi.stubEnv("KYRN_SWARM_DEPTH", "");
		const timers: NodeJS.Timeout[] = [];
		const real = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
			const timer = real(...args);
			timers.push(timer);
			return timer;
		}) as typeof setTimeout);
		const { emit } = start();
		expect(timers).toHaveLength(1);
		expect(timers[0].hasRef()).toBe(false);
		void emit("session_shutdown");
	});

	it("reaches the model before its next step, after the tool call under way has finished", async () => {
		vi.stubEnv("MU_TIME_BUDGET_S", "");
		vi.stubEnv("KYRN_TIME_BUDGET_S", "");
		vi.stubEnv("KYRN_SWARM_DEPTH", "");
		// The process starts with the harness: 50% of a 4-second budget is at 2 s, 80% at 3.2 s.
		vi.spyOn(process, "uptime").mockReturnValue(0);
		let session: Harness["session"] | undefined;
		// A build that is still running when the notice comes, and ends a moment after it is queued.
		const build: AgentTool = {
			name: "build",
			label: "build",
			description: "build",
			parameters: Type.Object({}, { additionalProperties: true }),
			execute: async () => {
				const until = Date.now() + 8_000;
				while (!session?.agent.hasQueuedMessages() && Date.now() < until) {
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
				return { content: [{ type: "text", text: "built" }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [build],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					mode: "active",
					config: parseConfig({ features: { memory: false, deadline: { budgetS: 4 } } }),
					only: ["deadline"],
				}),
			],
		});
		harnesses.push(harness);
		session = harness.session;
		const seen: string[][] = [];
		/** The text of every user-role message the model was sent: a custom message reaches it as one. */
		const read = (context: Context): string[] =>
			context.messages.flatMap((message): string[] => {
				if (message.role !== "user") return [];
				if (typeof message.content === "string") return [message.content];
				return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
			});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("build", {})], { stopReason: "toolUse" }),
			(context) => {
				seen.push(read(context));
				return fauxAssistantMessage([fauxToolCall("build", {})], { stopReason: "toolUse" });
			},
			(context) => {
				seen.push(read(context));
				return fauxAssistantMessage("Built twice.");
			},
			fauxAssistantMessage("unused"),
		]);
		await harness.session.prompt("Build it.");

		const kinds = harness.session.messages
			.filter((message) => message.role !== "system")
			.map((message) => (message.role === "custom" ? (message as { customType: string }).customType : message.role));
		expect(kinds).toEqual([
			"user",
			"assistant",
			"toolResult",
			DEADLINE_MESSAGE,
			"assistant",
			"toolResult",
			DEADLINE_MESSAGE,
			"assistant",
		]);
		// Neither tool call was cut short by a notice.
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results.map((message) => (message as { isError?: boolean }).isError)).toEqual([false, false]);
		// The model read the 50% notice before its second step and the 80% one before its third.
		expect(seen[0].some((text) => text.includes("50% of this run's time budget is gone"))).toBe(true);
		expect(seen[0].some((text) => text.includes("80%"))).toBe(false);
		expect(seen[1].some((text) => text.includes("Make sure the requested result is in place"))).toBe(true);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});
});
