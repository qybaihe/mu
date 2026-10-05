import { defineDecision } from "../decision.ts";
import { threeZone } from "../policy.ts";

/**
 * The run ended on a message that made no call and did not finish the work: "Let me run the tests next." and then
 * nothing, or "Should I apply the fix?" when applying it was the request. The agent is sent back to it.
 *
 * After can1357/oh-my-pi's unexpected-stop detection (MIT, © 2025-2026 Can Bölük; `session/unexpected-stop-classifier.ts`), whose
 * question and examples these follow. mu splits off asking for a go-ahead: it counts only when the user already asked
 * for the work (mu never makes the model ask what it can decide itself), and a step that is hard to undo or reaches
 * beyond this machine is never pushed through.
 */
export interface ContinueInput {
	readonly userMessage: string;
	readonly finalMessage: string;
}

export type ContinueOutcome = "end" | "promised" | "go_ahead";

export const turnContinue = defineDecision({
	id: "turn.continue",
	version: 1,
	cacheImpact: "append-only",
	latency: "inline",
	capabilities: { work_requested: "meta" },
	questions: {
		promised: {
			type: "boolean",
			instructions:
				"Does `final_message` say the assistant will now act, continue working, or call a tool, and then end without doing so?",
			criteria: {
				true: 'Like:\n- "I should do the same for the JS worker. Doing that now."\n- "Let me run the tests next."\n- "I\'ll fix that now."',
				false: 'Like:\n- "I\'ve completed the task."\n- "The fix is done and tests pass."\n- "Is there anything else I can help with?"',
			},
		},
		// Two questions, not one: asked as one ("a go-ahead on work the user already asked for?"), "How would you fix it?"
		// followed by "Want me to apply it?" came out at 0.79 on Jev 1.13, a hair under the line. Apart, the request scores
		// 0.29 there (0.38 in Chinese) and 0.95 for "Fix it." (probed 2026-10-05 on the free Jev).
		asks_go_ahead: {
			type: "boolean",
			instructions:
				"Does `final_message` end by asking whether the assistant should go ahead with a change or a task?",
		},
		work_requested: {
			type: "boolean",
			instructions:
				"Does `user_message` ask the assistant to make a change or carry out a task, not only to explain, answer or propose?",
		},
		irreversible: {
			type: "boolean",
			instructions:
				"Is the next step `final_message` names hard to undo, or does it reach beyond this machine (push, deploy, publish, send, delete, pay)?",
		},
	},
	buildState(input: ContinueInput) {
		return { user_message: input.userMessage, final_message: input.finalMessage };
	},
	policy(answers): ContinueOutcome {
		// A pause before a step that cannot be taken back is the one the user wants, whatever else was said.
		if (threeZone(answers.irreversible) !== "no") return "end";
		if (threeZone(answers.promised) === "yes") return "promised";
		if (threeZone(answers.asks_go_ahead) === "yes" && threeZone(answers.work_requested) === "yes") return "go_ahead";
		return "end";
	},
	fallback(): ContinueOutcome {
		return "end";
	},
});
