import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { WATCHDOG_MESSAGE } from "../src/extension/features/watchdog.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
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
