import { describe, expect, it } from "vitest";
import type { Calibration } from "../src/calibration.ts";
import { CascadeJudge } from "../src/cascade.ts";
import { DecisionEngine } from "../src/decision.ts";
import { notifyRouting } from "../src/decisions/notify-routing.ts";
import { taskFrame } from "../src/decisions/task-frame.ts";
import { toolConstraint } from "../src/decisions/tool-constraint.ts";
import { constraintId } from "../src/frame/frame.ts";
import { Judge } from "../src/judge.ts";
import { LlmJudgeProvider } from "../src/providers/llm.ts";

const rule = "Do not modify AGENTS.md.";
const toolCall = { toolName: "edit", call: "AGENTS.md", constraints: [rule] };
const frameInput = {
	userMessage: "You can modify AGENTS.md now.",
	frame: { goal: "Update the project docs", constraints: [rule] },
	activeConstraints: [{ text: rule, source: { turn: 2 } }],
	recentTurns: [],
};

function engine(answers: Record<string, object>, calibration?: Calibration): DecisionEngine {
	const provider = new LlmJudgeProvider({
		id: "llm:test/model",
		complete: async () => ({ text: JSON.stringify({ answers }) }),
	});
	const judge = new Judge({ provider });
	return new DecisionEngine({
		judge: calibration ? new CascadeJudge([{ judge, profile: { calibration } }]) : judge,
		defaultMode: "active",
	});
}

describe("LLM choices through DecisionEngine", () => {
	it("does not block a tool call on an unscored violation", async () => {
		const decision = await engine({ constraint_0: { choice: "violates" } }).decide(toolConstraint, toolCall);
		expect(decision).toMatchObject({ outcome: { broken: [] }, source: "judge" });
		expect(decision.answers?.constraint_0).toStrictEqual({ type: "choice", choice: "violates" });
	});

	it("does not withdraw a rule on an unscored withdrawal", async () => {
		const decision = await engine({
			change: { choice: "none" },
			limit: { choice: "withdraw_1" },
		}).decide(taskFrame, frameInput);
		expect(decision).toMatchObject({ outcome: { change: "none", limit: { kind: "unclear" } }, source: "judge" });
		expect(decision.answers?.limit).toStrictEqual({ type: "choice", choice: "withdraw_1" });
	});

	it("still blocks a tool call and withdraws a rule when the respective picks are scored high enough", async () => {
		const violation = await engine({ constraint_0: { choice: "violates", p: 0.9 } }).decide(toolConstraint, toolCall);
		expect(violation).toMatchObject({ outcome: { broken: [0] }, source: "judge" });
		expect(violation.answers?.constraint_0).toMatchObject({ probabilities: { violates: 0.9 } });

		const withdrawal = await engine({
			change: { choice: "none", p: 0.9 },
			limit: { choice: "withdraw_1", p: 0.9 },
		}).decide(taskFrame, frameInput);
		expect(withdrawal).toMatchObject({
			outcome: { change: "none", limit: { kind: "withdraw", id: constraintId(rule) } },
			source: "judge",
		});
	});

	it("still routes a notification on a bare choice", async () => {
		const decision = await engine({ urgency: { choice: "now" } }).decide(notifyRouting, {
			event: "The test suite finished",
			goal: "Fix the failing test",
			currentAction: "Wait for test results",
		});
		expect(decision).toMatchObject({ outcome: "now", source: "judge" });
		expect(decision.answers?.urgency).toStrictEqual({ type: "choice", choice: "now" });
	});

	it.each(["0.9", -0.1, 1.1])("ignores invalid confidence %s without losing the choice", async (confidence) => {
		const decision = await engine({ constraint_0: { choice: "violates", p: "0.9", confidence } }).decide(
			toolConstraint,
			toolCall,
		);
		expect(decision).toMatchObject({ outcome: { broken: [] }, source: "judge" });
		expect(decision.answers?.constraint_0).toStrictEqual({ type: "choice", choice: "violates" });
	});

	it("reads confidence alone as evidence, calibrated if there is a curve, without adding a probability", async () => {
		const answers = { constraint_0: { choice: "violates", confidence: 0.95 } };
		const raw = await engine(answers).decide(toolConstraint, toolCall);
		expect(raw.outcome.broken).toEqual([0]);
		expect(raw.answers?.constraint_0).toStrictEqual({ type: "choice", choice: "violates", confidence: 0.95 });

		const calibrated = await engine(answers, {
			model: "llm:test/model",
			curves: {
				"tool.constraint": {
					constraint_0: [
						[0.5, 0.4],
						[0.95, 0.7],
					],
				},
			},
		}).decide(toolConstraint, toolCall);
		expect(calibrated).toMatchObject({ outcome: { broken: [] }, source: "judge" });
		expect(calibrated.answers?.constraint_0).toStrictEqual({
			type: "choice",
			choice: "violates",
			confidence: 0.7,
			said: 0.95,
			judge: "llm:test/model",
		});
	});
});
