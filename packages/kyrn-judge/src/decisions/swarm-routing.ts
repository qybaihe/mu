import { defineDecision } from "../decision.ts";
import { pickChoice } from "../policy.ts";
import type { Questions } from "../types.ts";

/**
 * C1-C3, sub-agent routing: which role takes a task, on which model, thinking
 * how hard. A sub-agent starts with an empty context, so all three are chosen
 * per task at no prompt-cache cost. This is where cheap models can take the
 * mechanical work.
 */
export interface RoutingInput {
	readonly task: string;
	/** Roles to choose from: name -> what kind of task it takes. Empty or absent means the role is already settled. */
	readonly agents?: Readonly<Record<string, string>>;
	/**
	 * Ask how hard the task is and how much reasoning it needs. False when the answer could change nothing: with no
	 * model ladder every sub-agent runs on the session's model with the session's thinking. Absent means ask.
	 */
	readonly rate?: boolean;
}

export type RoutingOutcome = {
	/** 0 = cheapest model of the ladder, 1 = strongest. */
	readonly strength: number;
	readonly thinking: "low" | "medium" | "high";
	/** The role that fits, or null when none clearly does and the default role should take it. */
	readonly agent: string | null;
};

const SCORES = {
	difficulty: {
		type: "score",
		instructions: "How hard is `task`?",
		criteria: [
			"Mechanical, no judgment needed",
			"Routine engineering",
			"Needs careful design",
			"Hard even for an expert",
		],
	},
	reasoning: {
		type: "score",
		instructions: "How much reasoning does `task` need?",
		criteria: ["Almost none", "Some", "A lot", "Deep multi-step reasoning"],
	},
} satisfies Questions;

export const swarmRouting = defineDecision({
	id: "swarm.routing",
	// 3: the ratings are asked only when they can pick a model or a thinking level.
	version: 3,
	cacheImpact: "none",
	latency: "inline",
	// A delegated task has no "unchanged behaviour" to fall back to: the judge routes in shadow too.
	actsInShadow: true,
	// "What kind of task is this" is a classification of one text, which even a small judge does well.
	capabilities: { agent: "classify", difficulty: "rate", reasoning: "rate" },
	questions: SCORES as Questions,
	questionsFor(input: RoutingInput): Questions {
		const scores = input.rate === false ? {} : SCORES;
		if (!input.agents || Object.keys(input.agents).length === 0) return scores;
		return {
			agent: {
				type: "choice",
				instructions: "What kind of work is `task`?",
				criteria: { ...input.agents, other: "None of these" },
			},
			...scores,
		};
	},
	buildState(input: RoutingInput) {
		return { task: input.task };
	},
	policy(answers): RoutingOutcome {
		const { agent, difficulty, reasoning } = answers;
		const hardness = difficulty?.type === "score" ? difficulty.score : 1.5;
		const depth = reasoning?.type === "score" ? reasoning.score : 1.5;
		return {
			strength: Math.min(1, Math.max(0, hardness / 3)),
			thinking: depth >= 2.2 ? "high" : depth >= 1.1 ? "medium" : "low",
			agent: agent?.type === "choice" ? (pickChoice(agent, { minProbability: 0.5 }) ?? null) : null,
		};
	},
	fallback(): RoutingOutcome {
		return { strength: 0.5, thinking: "medium", agent: null };
	},
});
