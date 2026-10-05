import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer, JudgeRequest } from "../src/types.ts";

const yes: Answer = { type: "boolean", probability: 0.95 };
const no: Answer = { type: "boolean", probability: 0.03 };

/** Reads the closing message the way a judge would for these few sentences. */
function stopJudge(): MockJudgeProvider {
	return new MockJudgeProvider((request: JudgeRequest): Record<string, Answer> => {
		if (!("promised" in request.questions)) return {};
		const state = request.state as { final_message?: string };
		const text = state.final_message ?? "";
		return {
			promised: /Let me run the tests next/.test(text) ? yes : no,
			asks_go_ahead: /Should I apply/.test(text) ? yes : no,
			work_requested: /^(Fix|Ship)/.test((request.state as { user_message?: string }).user_message ?? "") ? yes : no,
			irreversible: /push/.test(text) ? yes : no,
		};
	});
}

const continueCalls = (provider: MockJudgeProvider) => provider.calls.filter((call) => "promised" in call.questions);

function nudges(harness: Harness): string[] {
	return harness.session.messages
		.filter(
			(message) => message.role === "custom" && (message as { customType?: string }).customType === "kyrn.nudge",
		)
		.map((message) => String((message as { content?: unknown }).content));
}

describe("carrying on after stopping short", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function start(
		provider: MockJudgeProvider,
		replies: string[],
		mode: "active" | "shadow" = "active",
	): Promise<Harness> {
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider,
					mode,
					config: parseConfig({ features: { memory: false, permissions: { mode: "full" } } }),
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([...replies.map((reply) => fauxAssistantMessage(reply)), fauxAssistantMessage("unused")]);
		return harness;
	}

	it("sends the agent back to what it said it would do, once, and lets a finished run end", async () => {
		const provider = stopJudge();
		const harness = await start(provider, ["I found the bug. Let me run the tests next.", "Ran them: all 212 pass."]);
		await harness.session.prompt("Fix the flaky login test.");
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(1));
		expect(nudges(harness)).toHaveLength(1);
		expect(nudges(harness)[0]).toContain("Do it now");
		// The judge read the end of the message, with what the user asked.
		expect(continueCalls(provider)[0].state).toMatchObject({ user_message: "Fix the flaky login test." });
		expect(continueCalls(provider)).toHaveLength(2);
	});

	it("does the work instead of asking for a go-ahead the user already gave, and only then", async () => {
		const harness = await start(stopJudge(), [
			"The fix is a one-line change. Should I apply it?",
			"Applied and tested.",
		]);
		await harness.session.prompt("Fix the off-by-one in the pager.");
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(1));
		expect(nudges(harness)).toEqual([expect.stringContaining("without asking for a go-ahead")]);

		// Asked only how: the offer to apply it is the user's to take.
		const asked = await start(stopJudge(), ["Change `<=` to `<` on line 40. Should I apply it?"]);
		await asked.session.prompt("How would you fix the off-by-one in the pager?");
		await vi.waitFor(() => expect(asked.getPendingResponseCount()).toBe(1));
		expect(nudges(asked)).toEqual([]);
	});

	it("never pushes a step that reaches beyond this machine, and stops nudging after the limit", async () => {
		const pushed = await start(stopJudge(), ["Ready. Let me run the tests next and push to main."]);
		await pushed.session.prompt("Ship the fix.");
		await vi.waitFor(() => expect(pushed.getPendingResponseCount()).toBe(1));
		expect(nudges(pushed)).toEqual([]);

		const stuck = "Let me run the tests next.";
		const looping = await start(stopJudge(), [stuck, stuck, stuck]);
		await looping.session.prompt("Fix the flaky login test.");
		await vi.waitFor(() => expect(looping.getPendingResponseCount()).toBe(1));
		expect(nudges(looping)).toHaveLength(2);
	});

	it("only records its verdict in shadow", async () => {
		const provider = stopJudge();
		const harness = await start(provider, ["Let me run the tests next."], "shadow");
		await harness.session.prompt("Fix the flaky login test.");
		await vi.waitFor(() => expect(continueCalls(provider)).toHaveLength(1));
		expect(nudges(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});
