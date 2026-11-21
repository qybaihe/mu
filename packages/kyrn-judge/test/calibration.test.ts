import { describe, expect, it } from "vitest";
import { type Calibration, type Curve, checkCalibration, curveOf, readThrough } from "../src/calibration.ts";
import { CascadeJudge } from "../src/cascade.ts";
import { parseConfig } from "../src/config.ts";
import { ABSTAIN, DecisionEngine, defineDecision } from "../src/decision.ts";
import { Judge } from "../src/judge.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { threeZone } from "../src/policy.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import { buildJudge } from "../src/registry.ts";
import type { Answer, Questions } from "../src/types.ts";

/** A chat model that writes its probabilities down: what it puts at 0.9 was true 73 times in 100. */
const WRITTEN: Curve = [
	[0.5, 0.2],
	[0.95, 0.8],
];

describe("reading an answer through a curve", () => {
	it("reads a yes/no answer along the line between the two measured points around it, and keeps what was said", () => {
		const read = readThrough({ type: "boolean", probability: 0.9, confidence: 0.4 }, WRITTEN);
		expect(read).toMatchObject({ type: "boolean", said: 0.9, confidence: 0.4 });
		expect((read as { probability: number }).probability).toBeCloseTo(0.2 + (0.4 / 0.45) * 0.6);
		// A measured point is read as what was measured there.
		expect(readThrough({ type: "boolean", probability: 0.95 }, WRITTEN)).toMatchObject({ probability: 0.8 });
	});

	it("stays at the first and the last measured point outside them: nothing was measured there", () => {
		expect(readThrough({ type: "boolean", probability: 0.1 }, WRITTEN)).toMatchObject({
			probability: 0.2,
			said: 0.1,
		});
		expect(readThrough({ type: "boolean", probability: 1 }, WRITTEN)).toMatchObject({ probability: 0.8, said: 1 });
	});

	it("reads a choice by the probability of the option it picked, and leaves the others and the pick alone", () => {
		const answer: Answer = {
			type: "choice",
			choice: "needed",
			probabilities: { needed: 0.95, beyond: 0.05 },
			confidence: 0.5,
		};
		expect(readThrough(answer, WRITTEN)).toEqual({
			type: "choice",
			choice: "needed",
			probabilities: { needed: 0.8, beyond: 0.05 },
			confidence: 0.5,
			said: 0.95,
		});
		const bare: Answer = { type: "choice", choice: "needed" };
		expect(readThrough(bare, WRITTEN)).toBe(bare);
	});

	it("reads confidence when the distribution does not score the picked option", () => {
		const answer: Answer = { type: "choice", choice: "needed", probabilities: { beyond: 0.05 }, confidence: 0.95 };
		expect(readThrough(answer, WRITTEN)).toStrictEqual({ ...answer, confidence: 0.8, said: 0.95 });
	});

	it("leaves a score as it is: a place on a rubric is not a probability", () => {
		const score: Answer = { type: "score", score: 2.5 };
		expect(readThrough(score, WRITTEN)).toBe(score);
	});
});

describe("which curve an answer is read through", () => {
	const calibration: Calibration = {
		model: "chat-1",
		curves: { "tool.approval": { verdict: WRITTEN }, "skills.disclosure": { "*": WRITTEN } },
	};
	const asked = { decision: "tool.approval", question: "verdict", model: "chat-1" };

	it("is the one measured for that question of that decision point", () => {
		expect(curveOf(calibration, asked)).toBe(WRITTEN);
		expect(curveOf(calibration, { ...asked, question: "other" })).toBeUndefined();
		expect(curveOf(calibration, { ...asked, decision: "tool.risk" })).toBeUndefined();
		expect(curveOf(undefined, asked)).toBeUndefined();
	});

	it("is the decision's `*` curve for a question built per candidate, which no file can name", () => {
		expect(curveOf(calibration, { ...asked, decision: "skills.disclosure", question: "skill_7" })).toBe(WRITTEN);
	});

	it("is none for another model than the one measured, and none for a question nobody says the decision of", () => {
		expect(curveOf(calibration, { ...asked, model: "chat-2" })).toBeUndefined();
		expect(curveOf(calibration, { ...asked, model: undefined })).toBeUndefined();
		expect(curveOf(calibration, { ...asked, decision: undefined })).toBeUndefined();
		// With no model named, the curves hold for whatever answers.
		expect(curveOf({ curves: calibration.curves }, { ...asked, model: "chat-2" })).toBe(WRITTEN);
	});

	it("takes ids as names, not as what every object has", () => {
		expect(curveOf(calibration, { ...asked, decision: "constructor" })).toBeUndefined();
		expect(curveOf(calibration, { ...asked, question: "toString" })).toBeUndefined();
	});
});

describe("a calibration written in mu.json", () => {
	it("is kept when every curve can be read", () => {
		const written = {
			model: "chat-1",
			curves: {
				"tool.approval": {
					verdict: [
						[0.5, 0.2],
						[0.95, 0.8],
					],
				},
			},
		};
		expect(checkCalibration(written)).toEqual({ calibration: written, rejected: [] });
		expect(checkCalibration(undefined)).toEqual({ calibration: undefined, rejected: [] });
	});

	it("loses a curve that falls, repeats a point, leaves the range or has one point, and says which", () => {
		const { calibration, rejected } = checkCalibration({
			curves: {
				"tool.approval": {
					verdict: [
						[0.5, 0.2],
						[0.95, 0.8],
					],
					// The surer answer would read as the less likely one.
					falls: [
						[0.5, 0.8],
						[0.95, 0.2],
					],
					repeats: [
						[0.5, 0.2],
						[0.5, 0.8],
					],
					outside: [
						[0.5, 0.2],
						[1.2, 0.8],
					],
					single: [[0.5, 0.2]],
					text: "0.5:0.2",
				},
				"tool.risk": [[0.5, 0.2]],
			},
		});
		expect(calibration).toEqual({
			curves: {
				"tool.approval": {
					verdict: [
						[0.5, 0.2],
						[0.95, 0.8],
					],
				},
			},
		});
		expect(rejected).toHaveLength(6);
		expect(rejected[0]).toBe(
			"the curve for tool.approval falls is not a list of [said, was] pairs between 0 and 1, with said rising and was not falling",
		);
		expect(rejected.at(-1)).toBe("the curves for tool.risk are not listed by question");
	});

	it("is not used at all when it names no curves, or a model that cannot be read", () => {
		expect(checkCalibration({ model: "chat-1" })).toEqual({
			calibration: undefined,
			rejected: ["its calibration has no `curves` by decision point"],
		});
		// Read without its model, the curves would hold for every model.
		const unnamed = checkCalibration({
			model: 3,
			curves: {
				"tool.approval": {
					verdict: [
						[0.5, 0.2],
						[0.95, 0.8],
					],
				},
			},
		});
		expect(unnamed.calibration).toBeUndefined();
		expect(unnamed.rejected).toEqual(["its calibration's `model` is not text"]);
	});
});

const questions = {
	needed: { type: "boolean", instructions: "Does `task` need `call`?" },
} satisfies Questions;

/** Runs a call when the judge is sure the task needs it; anything else asks the user, as with no judge. */
const approve = defineDecision({
	id: "test.approve",
	version: 1,
	cacheImpact: "none",
	latency: "inline",
	questions,
	buildState: (call: string) => ({ task: "fix the failing test", call }),
	policy(answers) {
		const verdict = threeZone(answers.needed);
		return verdict === "unsure" ? ABSTAIN : verdict === "yes" ? "run" : "refuse";
	},
	fallback: () => "ask" as const,
});

describe("a judge read through its calibration", () => {
	const says = (probability: number, id: string) =>
		new MockJudgeProvider(() => ({ needed: { type: "boolean", probability } }), id);
	const curves = { curves: { "test.approve": { needed: WRITTEN } } };

	it("turns a 0.9 that was true 73 times in 100 into an unsure answer, where an uncalibrated judge's 0.9 acts", async () => {
		const ledger = new MemoryLedger();
		const chat = says(0.9, "chat");
		const engine = new DecisionEngine({
			judge: new CascadeJudge([{ judge: new Judge({ provider: chat }), profile: { calibration: curves } }]),
			defaultMode: "active",
			ledger,
		});

		const decision = await engine.decide(approve, "rm -rf build");

		// Under the policy's line of 0.8: the user is asked, as with no verdict.
		expect(decision).toMatchObject({ outcome: "ask", source: "fallback", reason: "abstain" });
		const recorded = ledger.records[0].answers?.needed;
		expect(recorded).toMatchObject({ type: "boolean", said: 0.9, judge: "chat" });
		expect((recorded as { probability: number }).probability).toBeCloseTo(0.733, 3);

		const trained = new DecisionEngine({
			judge: new CascadeJudge([{ judge: new Judge({ provider: says(0.9, "trained") }) }]),
		});
		trained.setDefaultMode("active");
		expect(await trained.decide(approve, "rm -rf build")).toMatchObject({ outcome: "run", source: "judge" });
	});

	it("reads each judge of an order through its own curves, by the judge that answered", async () => {
		const down = new MockJudgeProvider(() => {
			throw new Error("not running");
		}, "local");
		const cascade = new CascadeJudge([
			{ judge: new Judge({ provider: down }) },
			{ judge: new Judge({ provider: says(0.95, "chat") }), profile: { calibration: curves } },
		]);

		const result = await cascade.evaluate({ state: "x", questions, decision: "test.approve" });

		expect(result.answers.needed).toMatchObject({ probability: 0.8, said: 0.95, judge: "chat" });
		// Asked outside a decision point, nothing says which curve applies: the answer is as the judge gave it.
		const probe = await cascade.evaluate({ state: "x", questions });
		expect(probe.answers.needed).toEqual({ type: "boolean", probability: 0.95, judge: "chat" });
	});

	it("leaves another model's answers as they are", async () => {
		const cascade = new CascadeJudge([
			{
				judge: new Judge({ provider: says(0.9, "chat") }),
				// The mock judge reports the model "mock".
				profile: { calibration: { model: "chat-1", ...curves } },
			},
		]);
		const result = await cascade.evaluate({ state: "x", questions, decision: "test.approve" });
		expect(result.answers.needed).toEqual({ type: "boolean", probability: 0.9, judge: "chat" });
	});
});

describe("a judge's calibration in mu.json", () => {
	const config = (calibration: unknown) =>
		parseConfig({ tiers: ["chat"], judges: { chat: { type: "mock", profile: { calibration } } } });

	it("is what the judge built from it reads its answers through", async () => {
		// The mock judge answers 0.5 to everything; this curve reads that as a sure no.
		const built = buildJudge(
			config({
				model: "mock",
				curves: {
					"test.approve": {
						"*": [
							[0.5, 0.1],
							[0.9, 0.8],
						],
					},
				},
			}),
		);
		expect(built.problems).toEqual([]);
		const result = await built.judge.evaluate({ state: "x", questions, decision: "test.approve" });
		expect(result.answers.needed).toMatchObject({ probability: 0.1, said: 0.5 });
	});

	it("is reported, not followed, where a curve cannot be read", async () => {
		const built = buildJudge(
			config({
				curves: {
					"test.approve": {
						needed: [
							[0.9, 0.8],
							[0.5, 0.1],
						],
					},
				},
			}),
		);
		expect(built.problems).toEqual([
			'judge "chat": the curve for test.approve needed is not a list of [said, was] pairs between 0 and 1, with said rising and was not falling, so it is not used',
		]);
		const result = await built.judge.evaluate({ state: "x", questions, decision: "test.approve" });
		expect(result.answers.needed).toEqual({ type: "boolean", probability: 0.5, judge: "mock" });
	});
});
