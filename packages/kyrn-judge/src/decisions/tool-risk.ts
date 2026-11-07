import { defineDecision } from "../decision.ts";
import { threeZone } from "../policy.ts";

/**
 * B3, the risk gate. Rules find the commands worth a second look; the judge
 * only answers whether the user asked for this. It can add a confirmation,
 * never remove one: without a verdict a flagged command is confirmed.
 *
 * Version 1 also asked whether `command` is destructive, and a "no" let it run.
 * The permission gate never took that answer, since a command can say anything
 * about itself, so in Judge mode it cost a judge answer and changed nothing. The
 * guard on its own (permission modes off) now reads the verdict the same way.
 */
export interface RiskInput {
	readonly command: string;
	readonly userMessage: string;
	/** Why a rule flagged the command, e.g. "recursive delete". */
	readonly flag: string;
}

export type RiskOutcome = "allow" | "confirm";

export const toolRisk = defineDecision({
	id: "tool.risk",
	version: 2,
	cacheImpact: "none",
	latency: "inline",
	capabilities: { requested: "relate" },
	questions: {
		requested: { type: "boolean", instructions: "Did `user_message` ask for what `command` does?" },
	},
	buildState(input: RiskInput) {
		return { command: input.command, flag: input.flag, user_message: input.userMessage };
	},
	policy(answers): RiskOutcome {
		return threeZone(answers.requested) === "yes" ? "allow" : "confirm";
	},
	// A rule flagged it and nobody could vouch for it.
	fallback(): RiskOutcome {
		return "confirm";
	},
});
