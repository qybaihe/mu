import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import type { Answer, JudgeRequest } from "../src/types.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import type { KyrnPresentationEvent } from "../src/extension/presentation.ts";
import { parseTeachingCard, TEACHING_PROMPT } from "../src/extension/features/teaching.ts";

const picked = (choice: string, probability: number): Answer => ({
	type: "choice",
	choice,
	probabilities: { [choice]: probability },
});

/** Answers the teaching question by what the turn was about; other questions get nothing. */
function judge(): MockJudgeProvider {
	return new MockJudgeProvider((request: JudgeRequest): Record<string, Answer> => {
		if (!("pivot" in request.questions)) return {};
		const state = request.state as { turn_digest?: string };
		const digest = state.turn_digest ?? "";
		if (digest.includes("beside the store")) return { pivot: picked("arch_weighing", 0.93) };
		if (digest.includes("the flag that does the reverse")) return { pivot: picked("counterintuitive_pitfall", 0.61) };
		if (digest.includes("worth a card")) return { pivot: picked("product_tradeoff", 0.9) };
		return { pivot: picked("routine", 0.97) };
	});
}

const CARD = JSON.stringify({ why: "The cache invalidates on the store's writes: two owners would race.", ruledOut: ["Inside the store", "Per-caller caches"], kind: "arch_weighing" });

/** One step: the writer's card when the writer is asking, else the agent's next reply. */
const step = (reply: string): FauxResponseFactory => (context) =>
	JSON.stringify(context.messages).includes("judged moment of a coding session")
		? fauxAssistantMessage(CARD)
		: fauxAssistantMessage(reply);

const teachingEvents = (events: KyrnPresentationEvent[]) => events.filter((event) => event.kind === "turn.teaching");

describe("the teaching card of a turn", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function start(
		provider: MockJudgeProvider,
		replies: string[],
		options: { mode?: "active" | "shadow"; writer?: string } = {},
	): Promise<{ harness: Harness; events: KyrnPresentationEvent[] }> {
		const events: KyrnPresentationEvent[] = [];
		const mode = options.mode ?? "active";
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider,
					mode,
					config: parseConfig({
						features: { memory: false },
						...(options.writer ? { writer: options.writer } : {}),
						// The point ships in shadow; the test of the applied state flips it on the way mu.json does.
						...(mode === "active" ? { modes: { "turn.teaching": "active" } } : {}),
					}),
					only: ["teaching"],
					onPresentation: (event) => events.push(event),
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			...replies.map(step),
			...Array.from({ length: 4 }, () => step("unused")),
		]);
		return { harness, events };
	}

	/** One turn whose answer weighed where a cache belongs. */
	const TRADEOFF = "I put the cache beside the store, not in it: it invalidates on the store's writes.";

	it("presents the writer's card for a turn that weighed something, applied in active mode", async () => {
		const { harness, events } = await start(judge(), [TRADEOFF], { writer: "faux/faux-1" });
		await harness.session.prompt("Should the cache live in the store or beside it?");
		await vi.waitFor(() => expect(teachingEvents(events)).toHaveLength(1));
		expect(teachingEvents(events)[0].payload).toEqual({
			kind: "arch_weighing",
			why: "The cache invalidates on the store's writes: two owners would race.",
			ruledOut: ["Inside the store", "Per-caller caches"],
			state: "applied",
		});
	});

	it("asks in shadow mode too, and the card is presented as shadow, so no client shows it in the reply", async () => {
		const { harness, events } = await start(judge(), [TRADEOFF], { mode: "shadow", writer: "faux/faux-1" });
		await harness.session.prompt("Should the cache live in the store or beside it?");
		await vi.waitFor(() => expect(teachingEvents(events)).toHaveLength(1));
		expect(teachingEvents(events)[0].payload).toMatchObject({ state: "shadow" });
		// The turn itself was not held or changed by the card.
		expect(harness.session.messages.at(-1)?.role).toBe("assistant");
	});

	it("says nothing for an ordinary turn", async () => {
		const provider = judge();
		const { harness, events } = await start(provider, ["Renamed the field everywhere it is used."], {
			writer: "faux/faux-1",
		});
		await harness.session.prompt("Rename the field to parseDuration.");
		await harness.session.prompt("And run the tests."); // A second turn, to let the first one settle.
		expect(teachingEvents(events)).toHaveLength(0);
		expect(provider.calls.filter((call) => "pivot" in call.questions)).toHaveLength(2);
	});

	it("shows nothing without a writer configured", async () => {
		const { harness, events } = await start(judge(), [TRADEOFF]);
		await harness.session.prompt("Should the cache live in the store or beside it?");
		await harness.session.prompt("Anything else?");
		expect(teachingEvents(events)).toHaveLength(0);
	});

	it("shows nothing when the picked option is not sharp enough", async () => {
		const { harness, events } = await start(
			judge(),
			["The flag that does the reverse: I switched it off."],
			{ writer: "faux/faux-1" },
		);
		await harness.session.prompt("Why is the build still failing?");
		await harness.session.prompt("Anything else?");
		expect(teachingEvents(events)).toHaveLength(0);
	});
});

describe("parsing the writer's card", () => {
	it("keeps the card when the writer answers in shape, and at most two ruled-out options", () => {
		expect(
			parseTeachingCard(
				JSON.stringify({ why: "So later runs skip the bad path.", ruledOut: ["a", "b", "c"], kind: "product_tradeoff" }),
				"product_tradeoff",
			),
		).toEqual({ kind: "product_tradeoff", why: "So later runs skip the bad path.", ruledOut: ["a", "b"] });
	});

	it("drops the card on a kind the judge did not pick, empty words, or no JSON at all", () => {
		expect(parseTeachingCard(JSON.stringify({ why: "Why.", kind: "routine" }), "product_tradeoff")).toBeUndefined();
		expect(parseTeachingCard('{"why":"  "}', "product_tradeoff")).toBeUndefined();
		expect(parseTeachingCard("no json here", "product_tradeoff")).toBeUndefined();
	});

	it("asks the writer with the moment's kind and what happened", () => {
		expect(TEACHING_PROMPT).toContain("strict JSON");
		expect(TEACHING_PROMPT).toContain("at most 120 characters");
	});
});
