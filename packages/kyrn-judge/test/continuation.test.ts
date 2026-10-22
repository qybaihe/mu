import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { CascadeJudge } from "../src/cascade.ts";
import { BUILT_IN_JUDGES, parseConfig } from "../src/config.ts";
import { DecisionEngine } from "../src/decision.ts";
import { turnContinue } from "../src/decisions/turn-continue.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { Judge } from "../src/judge.ts";
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
			beyond_request: /too\?$/.test(text) ? yes : no,
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
		extra: { features?: Record<string, unknown>; tools?: AgentTool[] } = {},
	): Promise<Harness> {
		const harness = await createHarness({
			tools: extra.tools,
			extensionFactories: [
				createKyrnJudgeExtension({
					provider,
					mode,
					config: parseConfig({ features: { memory: false, permissions: { mode: "full" }, ...extra.features } }),
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

	it("takes an offer of more than was asked for as the user's to accept, not as a go-ahead", async () => {
		const provider = stopJudge();
		const harness = await start(provider, [
			"Fixed the off-by-one in the pager. Should I apply the same fix to the other pagers too?",
		]);
		await harness.session.prompt("Fix the off-by-one in the pager.");
		await vi.waitFor(() => expect(continueCalls(provider)).toHaveLength(1));
		expect(continueCalls(provider)[0].questions).toHaveProperty("beyond_request");
		expect(nudges(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("never counts a go-ahead on the local judge, which does not answer how two messages relate", async () => {
		const goAhead = (request: JudgeRequest): Record<string, Answer> => ({
			promised: no,
			asks_go_ahead: yes,
			...("work_requested" in request.questions ? { work_requested: yes } : {}),
			...("beyond_request" in request.questions ? { beyond_request: no } : {}),
			irreversible: no,
		});
		const input = { userMessage: "Fix the pager.", finalMessage: "It is a one-line change. Should I apply it?" };
		const decide = async (profile?: (typeof BUILT_IN_JUDGES)["laya"]["profile"]) => {
			const provider = new MockJudgeProvider(goAhead);
			const engine = new DecisionEngine({
				judge: new CascadeJudge([{ judge: new Judge({ provider }), profile }]),
				defaultMode: "active",
			});
			const decision = await engine.decide(turnContinue, input);
			return { outcome: decision.outcome, asked: Object.keys(provider.calls[0]?.questions ?? {}) };
		};
		expect(await decide()).toMatchObject({ outcome: "go_ahead" });
		const laya = await decide(BUILT_IN_JUDGES.laya.profile);
		expect(laya.asked).not.toContain("beyond_request");
		expect(laya.outcome).toBe("end");
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

	it("sends a run that ended on thinking alone back to work, without a judge, and not forever", async () => {
		const silent = () => fauxAssistantMessage([fauxThinking("The tests pass, so the fix holds.")]);
		const provider = stopJudge();
		const harness = await start(provider, []);
		harness.setResponses([silent(), fauxAssistantMessage("Fixed: the parser accepts empty input."), silent()]);
		await harness.session.prompt("Fix the parser.");
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(1));
		expect(nudges(harness)).toEqual([expect.stringContaining("no message and no tool call")]);
		// The silent end has nothing to judge; the one that followed it does.
		expect(continueCalls(provider)).toHaveLength(1);

		const mute = await start(stopJudge(), []);
		mute.setResponses([silent(), silent(), silent(), silent()]);
		await mute.session.prompt("Fix the parser.");
		await vi.waitFor(() => expect(mute.getPendingResponseCount()).toBe(1));
		expect(nudges(mute)).toHaveLength(2);
	});

	it("stops waiting for a late verdict at the end of a run and cancels the call, so a one-shot run can exit", async () => {
		const signals: AbortSignal[] = [];
		// A judge that would take ten seconds, as a remote one can; like a real one, it stops when its call is aborted.
		const slow = new MockJudgeProvider(
			(request) =>
				new Promise<Record<string, Answer>>((resolve, reject) => {
					if (!("promised" in request.questions) && !("claims_done" in request.questions)) return resolve({});
					const signal = request.signal as AbortSignal;
					signals.push(signal);
					const timer = setTimeout(() => resolve({}), 10_000);
					signal.addEventListener("abort", () => {
						clearTimeout(timer);
						reject(new Error("aborted"));
					});
				}),
		);
		const edit: AgentTool = {
			name: "edit",
			label: "edit",
			description: "edit",
			parameters: Type.Object({}, { additionalProperties: true }),
			execute: async () => ({ content: [{ type: "text", text: "edited" }], details: {} }),
		};
		const harness = await start(slow, [], "active", {
			tools: [edit],
			features: { continuation: { waitMs: 100 }, completion: { waitMs: 100 } },
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("edit", { path: "src/login.ts" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Edited the login check. Let me run the tests next."),
			fauxAssistantMessage("unused"),
		]);
		const startedAt = Date.now();
		await harness.session.prompt("Fix the flaky login test.");
		// Both end-of-run checks asked, and neither held the run for longer than its wait.
		expect(Date.now() - startedAt).toBeLessThan(3000);
		expect(signals).toHaveLength(2);
		expect(signals.every((signal) => signal.aborted)).toBe(true);
		expect(nudges(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
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
