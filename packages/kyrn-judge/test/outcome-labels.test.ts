import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { ENTRY_TYPES } from "../src/entries.ts";
import { OUTCOME_ENTRY } from "../src/extension/features/permissions.ts";
import type { Refetched } from "../src/extension/features/recall.ts";
import type { Returned } from "../src/extension/features/warming.ts";
import { createKyrnJudgeExtension, type FeatureName } from "../src/extension/kyrn-judge.ts";
import { LEDGER_ENTRY_TYPE } from "../src/extension/runtime.ts";
import type { LedgerRecord } from "../src/ledger.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";

const noise = Array.from(
	{ length: 120 },
	(_, index) => `npm warn deprecated left-pad@1.${index}.0: use String.prototype.padStart`,
);
const output = [
	"> npm test",
	...noise.slice(0, 60),
	"FAIL test/login.test.ts",
	...noise.slice(60),
	"Tests: 1 failed",
].join("\n");

const runTests: AgentTool = {
	name: "run_tests",
	label: "Run tests",
	description: "Run the test suite",
	parameters: Type.Object({ command: Type.String() }),
	execute: async () => ({ content: [{ type: "text", text: output }], details: {} }),
};

describe("what became of a verdict, kept beside it", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function start(responder: MockResponder, only: FeatureName[]) {
		const harness = await createHarness({
			tools: [runTests],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(responder),
					mode: "active",
					config: parseConfig({ features: { memory: false, permissions: { mode: "full" } } }),
					only,
				}),
			],
		});
		harnesses.push(harness);
		const custom = <T>(type: string): T[] =>
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === type)
				.map((entry) => (entry as { data: T }).data);
		return {
			harness,
			outcomes: <T>() => custom<T>(OUTCOME_ENTRY),
			records: () => custom<LedgerRecord>(LEDGER_ENTRY_TYPE),
		};
	}
	const schema = ENTRY_TYPES.find((type) => type.type === OUTCOME_ENTRY)?.schema;

	it("refetch: reading back what admission left out labels the verdict that left it out", async () => {
		// Every chunk without the failing test is called a repeated warning, one chunk per request or many.
		const session = await start(
			(request): Record<string, Answer> => {
				const state = request.state as Record<string, unknown>;
				const answers: Record<string, Answer> = {};
				for (const id of Object.keys(request.questions)) {
					const chunk = id === "kind" ? state.chunk : state[`c${id.slice(1)}`];
					if (typeof chunk !== "string") continue;
					const choice = chunk.includes("FAIL") ? "error" : "warning";
					answers[id] = { type: "choice", choice, probabilities: { [choice]: 0.95 } };
				}
				return answers;
			},
			["admission", "recall"],
		);
		session.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("run_tests", { command: "npm test" }, { id: "call-tests" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("recall", { id: "call-tests", offset: 0, limit: 500 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("The login test fails."),
		]);
		await session.harness.session.prompt("Run the tests.");

		const admitted = session.records().find((record) => record.specId.startsWith("tool.admission"));
		expect(admitted).toBeDefined();
		const outcomes = session.outcomes<Refetched>();
		expect(outcomes).toEqual([
			{
				kind: "refetch",
				source: "archive",
				tool: "run_tests",
				ledgerId: admitted?.id,
				specId: "tool.admission",
				chars: 500,
			},
		]);
		expect(schema && Value.Check(schema, outcomes[0])).toBe(true);
	});

	it("returned: the user's next message says how long they stayed away after a warming verdict", async () => {
		const yes: Answer = { type: "boolean", probability: 0.95 };
		const no: Answer = { type: "boolean", probability: 0.03 };
		const session = await start(
			(request): Record<string, Answer> => ("finished" in request.questions ? { finished: no, open: yes } : {}),
			["preflight", "warming"],
		);
		const event = {
			type: "cache_warming_decision" as const,
			warmCost: 0.01,
			missCost: 0.5,
			continuationProbability: 1,
			action: "warm" as const,
		};
		session.harness.setResponses([fauxAssistantMessage("Which file do you mean?"), fauxAssistantMessage("Done.")]);
		await session.harness.session.prompt("Fix the parser.");
		expect(session.outcomes()).toEqual([]);

		expect(await session.harness.session.extensionRunner.emitCacheWarmingDecision(event)).toBe("warm");
		const verdict = session.records().find((record) => record.specId === "cache.warming");
		await session.harness.session.prompt("src/parse.ts");

		const outcomes = session.outcomes<Returned>();
		expect(outcomes).toEqual([
			{
				kind: "returned",
				ledgerId: verdict?.id,
				specId: "cache.warming",
				judged: "warm",
				afterMs: expect.any(Number),
			},
		]);
		expect(schema && Value.Check(schema, outcomes[0])).toBe(true);
		// One label per verdict: a further message without a new verdict adds none.
		session.harness.setResponses([fauxAssistantMessage("Done.")]);
		await session.harness.session.prompt("Thanks.");
		expect(session.outcomes()).toHaveLength(1);
	});
});
