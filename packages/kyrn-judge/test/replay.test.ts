import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { DecisionEngine, defineDecision } from "../src/decision.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { LEDGER_ENTRY_TYPE } from "../src/extension/runtime.ts";
import { Judge } from "../src/judge.ts";
import { type LedgerRecord, MemoryLedger } from "../src/ledger.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import { ReplayJudgeProvider, replayCalls } from "../src/providers/replay.ts";
import type { Answer, JudgeProvider, Question } from "../src/types.ts";
import { GOLDEN_CASES } from "./golden/decision-inputs.ts";

/** Answers that differ from question to question, so a replay that gave one call another's answers would show. */
const varied: MockResponder = (request) =>
	Object.fromEntries(
		Object.entries(request.questions).map(([id, question], index): [string, Answer] => {
			const q = question as Question;
			if (q.type === "boolean") return [id, { type: "boolean", probability: index % 2 === 0 ? 0.92 : 0.12 }];
			if (q.type === "score") return [id, { type: "score", score: (q.criteria.length - 1) * (index % 2) }];
			const options = Object.keys(q.criteria);
			const choice = options[index % options.length] as string;
			return [id, { type: "choice", choice, probabilities: { [choice]: 0.9 } }];
		}),
	);

const engineWith = (provider: JudgeProvider, ledger = new MemoryLedger()) =>
	new DecisionEngine({ judge: new Judge({ provider }), defaultMode: "active", knownSecrets: () => [], ledger });

describe("replaying the judge from a ledger", () => {
	it("gives every decision the answers recorded for the same state, in any order", async () => {
		const ledger = new MemoryLedger();
		const recording = engineWith(new MockJudgeProvider(varied), ledger);
		const recorded = [];
		for (const { spec, input } of GOLDEN_CASES) recorded.push((await recording.decide(spec, input)).outcome);

		const replay = new ReplayJudgeProvider(replayCalls(ledger.records));
		const replaying = engineWith(replay);
		const replayed = new Array(GOLDEN_CASES.length);
		// Backwards and all at once: a call is found by what it asks, never by when.
		await Promise.all(
			[...GOLDEN_CASES.entries()].reverse().map(async ([index, { spec, input }]) => {
				replayed[index] = (await replaying.decide(spec, input)).outcome;
			}),
		);
		expect(replayed).toEqual(recorded);
		expect(replay.misses).toEqual([]);
		expect(replay.unused()).toEqual([]);
	});

	it("misses a request whose state changed, answers it as a judge that cannot tell, and leaves the recorded call unused", async () => {
		const spec = defineDecision({
			id: "test.replay",
			version: 1,
			cacheImpact: "none",
			latency: "inline",
			capabilities: "relate",
			questions: { relevant: { type: "boolean", instructions: "Is `item` relevant?" } },
			buildState: (input: { item: string }) => ({ item: input.item }),
			policy: (answers): string => (answers.relevant.probability >= 0.8 ? "yes" : "no"),
			fallback: (): string => "no",
		});
		const ledger = new MemoryLedger();
		await engineWith(
			new MockJudgeProvider(() => ({ relevant: { type: "boolean", probability: 0.95 } })),
			ledger,
		).decide(spec, { item: "parse.ts" });
		const replay = new ReplayJudgeProvider(replayCalls(ledger.records));
		const decision = await engineWith(replay).decide(spec, { item: "parse.ts, renamed" });
		expect(decision.outcome).toBe("no");
		expect(replay.misses).toEqual([{ digest: expect.any(String), questions: ["relevant"] }]);
		expect(replay.unused()).toHaveLength(1);
	});

	it("replays each item of a small batch by its own state", async () => {
		const spec = defineDecision({
			id: "test.batch",
			version: 1,
			cacheImpact: "none",
			latency: "background",
			capabilities: "classify",
			questions: { keep: { type: "boolean", instructions: "Keep `line`?" } },
			buildState: (input: string) => ({ line: input }),
			policy: (answers): boolean => answers.keep.probability >= 0.5,
			fallback: (): boolean => true,
		});
		const lines = ["ok 1", "FAIL parse", "ok 2"];
		const ledger = new MemoryLedger();
		const recorded = await engineWith(
			new MockJudgeProvider((request) => ({
				keep: { type: "boolean", probability: JSON.stringify(request.state).includes("FAIL") ? 0.9 : 0.1 },
			})),
			ledger,
		).decideMany(spec, lines);
		expect(ledger.records[0]?.batch?.digests).toHaveLength(3);

		const replay = new ReplayJudgeProvider(replayCalls(ledger.records));
		const replayed = await engineWith(replay).decideMany(spec, [...lines].reverse());
		expect(replayed.map((decision) => decision.outcome)).toEqual(
			recorded.map((decision) => decision.outcome).reverse(),
		);
		expect(replay.misses).toEqual([]);
	});
});

describe("replaying a conversation's judge", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** The tools a conversation calls, doing nothing: what runs is not what is replayed. */
	const tool = (name: string): AgentTool => ({
		name,
		label: name,
		description: name,
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	});

	/** One conversation in Judge mode, every feature of mu on: the judge is asked about the message, the frame, commands. */
	async function converse(provider: JudgeProvider) {
		const harness = await createHarness({
			tools: ["edit", "write", "bash"].map(tool),
			extensionFactories: [
				createKyrnJudgeExtension({
					provider,
					mode: "active",
					config: parseConfig({ features: { memory: false, permissions: { mode: "judge" } } }),
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "npm test -- parse" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("edit", { path: "src/parse.ts" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("bash", { command: "npm publish" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Fixed the hours and minutes in parseDuration; the test passes."),
		]);
		await harness.session.prompt("The parseDuration test fails for 1h30m, can you fix it?");
		return harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === LEDGER_ENTRY_TYPE)
			.map((entry) => (entry as { data: LedgerRecord }).data);
	}

	it("asks the same of the judge from one run to the next, so a recorded run replays", async () => {
		const mock = new MockJudgeProvider(varied);
		const recorded = await converse(mock);
		// The two commands put to the judge, and whether the finished turn should go on.
		expect(recorded.map((record) => record.specId)).toEqual(
			expect.arrayContaining(["tool.approval", "tool.approval", "turn.continue"]),
		);

		const replay = new ReplayJudgeProvider(replayCalls(recorded));
		const replayed = await converse(replay);
		expect(replay.misses).toEqual([]);
		expect(replay.unused()).toEqual([]);
		const outcomes = (records: readonly LedgerRecord[]) =>
			records.map((record) => `${record.specId} v${record.specVersion} ${JSON.stringify(record.outcome)}`).sort();
		expect(outcomes(replayed)).toEqual(outcomes(recorded));
	});
});
