import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { registerDeadline } from "../src/extension/features/deadline.ts";
import { cutAfterMs, registerWatchdog, WATCHDOG_MESSAGE } from "../src/extension/features/watchdog.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { KyrnRuntime } from "../src/extension/runtime.ts";
import { Judge } from "../src/judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";

/** About 1.5 seconds of thinking at the speed below: well past the watchdog's limit in these tests. */
const LONG = `Start with the parser. ${"Consider the next case and what it implies. ".repeat(28)}So the bug is in the tokenizer.`;

describe("the long-thinking watchdog", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function start(): Promise<Harness> {
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
		harnesses.push(harness);
		return harness;
	}

	const retries = (harness: Harness): string[] =>
		harness.session.messages
			.filter(
				(message) =>
					message.role === "custom" && (message as { customType?: string }).customType === WATCHDOG_MESSAGE,
			)
			.map((message) => String((message as { content?: unknown }).content));

	it("cuts a reply that only thinks, asks again with where it got to, and lets the retry take its time", async () => {
		const harness = await start();
		harness.setResponses([
			fauxAssistantMessage([fauxThinking(LONG), fauxText("never sent")]),
			fauxAssistantMessage([fauxThinking(LONG), fauxText("Fixed the tokenizer.")]),
			fauxAssistantMessage("unused"),
		]);
		await harness.session.prompt("Fix the parser.");
		expect(harness.faux.state.callCount).toBe(2);
		expect(retries(harness)).toHaveLength(1);
		expect(retries(harness)[0]).toContain("without a message or a tool call");
		// Where the cut reasoning had got to, which is its beginning here: it was cut early.
		expect(retries(harness)[0]).toContain("Start with the parser.");
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("leaves a reply alone once it writes", async () => {
		const harness = await start();
		harness.setResponses([
			fauxAssistantMessage([fauxThinking("Short."), fauxText(LONG)]),
			fauxAssistantMessage("unused"),
		]);
		await harness.session.prompt("Explain the parser.");
		expect(harness.faux.state.callCount).toBe(1);
		expect(retries(harness)).toEqual([]);
	});
});

describe("when the watchdog cuts", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("waits thinkingMs without a deadline, and at most half the time left with one, never under a minute", () => {
		// No deadline: exactly as before.
		expect(cutAfterMs(600_000, undefined)).toBe(600_000);
		// Plenty of time left: the deadline changes nothing.
		expect(cutAfterMs(600_000, 3_600_000)).toBe(600_000);
		expect(cutAfterMs(600_000, 1_200_000)).toBe(600_000);
		// Terminal-Bench, adaptive-rejection-sampler: thinking began 283 s into 900 s. Cut 308.5 s later, at 591.5 s,
		// with 308.5 s left for the retry, instead of at 883 s.
		expect(cutAfterMs(600_000, 617_000)).toBe(308_500);
		expect(cutAfterMs(600_000, 90_000)).toBe(60_000);
		expect(cutAfterMs(600_000, -30_000)).toBe(60_000);
		// A shorter thinkingMs is never lengthened.
		expect(cutAfterMs(300, 10_000)).toBe(300);
	});

	/**
	 * How long after it started a reply that only thinks is cut, with the run's deadline this far off when it starts.
	 * "env" leaves the deadline to the deadline feature.
	 */
	async function cutAfter(deadlineInMs: number | undefined | "env"): Promise<number | undefined> {
		vi.useFakeTimers();
		const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			appendEntry: () => {},
			getCommands: () => [],
		} as unknown as ExtensionAPI;
		const runtime = new KyrnRuntime(pi, parseConfig({}), new Judge({ provider: new MockJudgeProvider() }));
		if (deadlineInMs === "env") registerDeadline(runtime);
		registerWatchdog(runtime);
		if (typeof deadlineInMs === "number") runtime.deadlineAt = Date.now() + deadlineInMs;
		const startedAt = Date.now();
		let cutAt: number | undefined;
		const ctx = {
			abort: () => {
				cutAt ??= Date.now() - startedAt;
			},
		} as unknown as ExtensionContext;
		for (const handler of handlers.get("message_start") ?? []) {
			await handler({ type: "message_start", message: { role: "assistant" } }, ctx);
		}
		await vi.advanceTimersByTimeAsync(3_600_000);
		return cutAt;
	}

	it("cuts after 10 minutes of thinking without a deadline, and sooner when the deadline is near", async () => {
		expect(await cutAfter(undefined)).toBe(600_000);
		expect(await cutAfter(3_600_000)).toBe(600_000);
		expect(await cutAfter(617_000)).toBe(308_500);
		expect(await cutAfter(30_000)).toBe(60_000);
	});

	it("takes the deadline from MU_TIME_BUDGET_S, counted from when mu started", async () => {
		vi.stubEnv("KYRN_SWARM_DEPTH", "");
		vi.stubEnv("KYRN_TIME_BUDGET_S", "");
		vi.stubEnv("MU_TIME_BUDGET_S", "900");
		// mu has been running for 283 s when the reply starts: 617 s are left.
		vi.spyOn(process, "uptime").mockReturnValue(283);
		expect(await cutAfter("env")).toBe(308_500);
		vi.stubEnv("MU_TIME_BUDGET_S", "");
		expect(await cutAfter("env")).toBe(600_000);
	});
});
