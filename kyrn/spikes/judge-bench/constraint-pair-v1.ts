// The v1 decisions at 54ae53f45, kept here so the paired run doesn't depend on a second checkout.
import { defineDecision } from "../../../packages/kyrn-judge/src/decision.ts";
import type { TaskFrameInput } from "../../../packages/kyrn-judge/src/decisions/task-frame.ts";
import { isEscapeOption, threeZone } from "../../../packages/kyrn-judge/src/policy.ts";
import type { Questions } from "../../../packages/kyrn-judge/src/types.ts";

export const toolConstraintV1 = defineDecision({
	id: "tool.constraint",
	version: 1,
	cacheImpact: "none",
	latency: "inline",
	capabilities: "relate",
	questions: {} as Questions,
	questionsFor(input: { path: string; constraints: readonly string[] }): Questions {
		return Object.fromEntries(
			input.constraints.map((constraint, index) => [
				`constraint_${index}`,
				{
					type: "boolean" as const,
					instructions: `Does \`tool_call\` go against this instruction from the user? "${constraint.slice(0, 300)}"`,
				},
			]),
		);
	},
	buildState(input) {
		// Fixture paths are nonempty. V1 describeCall flattened them and only looked for replacement text at the top level.
		const path = input.path.replace(/\s+/g, " ").trim();
		return { tool_call: `edit: ${path.length <= 500 ? path : `${path.slice(0, 499)}…`}` };
	},
	policy(answers, input) {
		const broken: number[] = [];
		input.constraints.forEach((_constraint, index) => {
			const answer = answers[`constraint_${index}`];
			if (answer?.type === "boolean" && threeZone(answer) === "yes") broken.push(index);
		});
		return { broken };
	},
	fallback: () => ({ broken: [] }),
});

type FrameChangeV1 = "new_task" | "constraint" | "correction" | "subgoal" | "unclear" | "none";

export const taskFrameV1 = defineDecision({
	id: "task.frame",
	version: 1,
	cacheImpact: "append-only",
	latency: "inline",
	capabilities: "relate",
	questions: {
		change: {
			type: "choice",
			instructions: "What does `user_message` change in `task_frame`?",
			criteria: {
				new_task: "It starts a different task",
				constraint: "It adds a rule the work must follow",
				correction: "It says the current approach is wrong",
				subgoal: "It moves on to the next step of the same task",
				none: "Nothing: it is chat, a question or a go-ahead",
			},
		},
	},
	buildState(input: TaskFrameInput) {
		return {
			user_message: input.userMessage,
			task_frame: {
				goal: input.frame.goal,
				constraints: input.frame.constraints ?? [],
				current_subgoal: input.frame.currentSubgoal ?? null,
			},
			recent_turns: input.recentTurns,
		};
	},
	policy(answers): FrameChangeV1 {
		const { choice, probabilities } = answers.change;
		if (!probabilities) return isEscapeOption(choice) ? "none" : choice;
		const p = (option: keyof typeof probabilities) => probabilities[option] ?? 0;
		const limiting = p("constraint") + p("correction");
		const kinds: [FrameChangeV1, number][] = [
			["new_task", p("new_task")],
			[p("correction") > p("constraint") ? "correction" : "constraint", limiting],
			["subgoal", p("subgoal")],
		];
		const [kind, weight] = kinds.reduce((best, each) => (each[1] > best[1] ? each : best));
		if (weight >= 0.6) return kind;
		const changed = kinds.reduce((sum, each) => sum + each[1], 0);
		return changed >= 0.7 ? "unclear" : "none";
	},
	fallback: () => "none",
});
