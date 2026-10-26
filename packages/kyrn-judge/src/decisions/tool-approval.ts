import { defineDecision } from "../decision.ts";
import { isEscapeOption } from "../policy.ts";

/**
 * The judge approves for the user. In judge mode a call that would otherwise
 * ask the user (a command, a change outside the project, an action on the
 * outside world, a sub-agent) is put to the judge first: is it a step the task
 * needs, done the way the user would expect? Only a sure yes lets it run.
 * Anything else, and no verdict at all, goes to the user, with what the judge
 * saw.
 *
 * One choice question rather than booleans: choice distributions are sharp on
 * clear cases, and "beyond" versus "unrelated" tells the user why they are
 * being asked.
 */
export interface ToolApprovalInput {
	/** The task as the frame has it: goal, and the current subgoal when there is one. */
	readonly task: string;
	readonly userMessage: string;
	/** "bash: npm install lodash", "write /etc/hosts". */
	readonly call: string;
	/** Where the call acts, said plainly: "inside the project folder" or where else. */
	readonly where: string;
	/** The call runs a check in the project and otherwise only looks (`isCheckChain`). Not shown to the judge. */
	readonly check?: boolean;
}

export type ToolApprovalOutcome = "approve" | "beyond" | "unrelated" | "unsure";

/** How sure the judge has to be that a step is needed before it runs without the user. */
export const APPROVE_AT = 0.8;
/**
 * The same for a check: a test run, build, type check or linter in the project, with nothing else but looking. The
 * judge often lands just under 0.8 on one the task plainly needs (`npm run check`, `./test.sh`), and on mubench's
 * real requests none it put at 0.7 or more needed the user. A "beyond" or "unrelated" verdict still asks.
 */
export const CHECK_APPROVE_AT = 0.7;

export const toolApproval = defineDecision({
	id: "tool.approval",
	version: 2,
	cacheImpact: "none",
	latency: "inline",
	capabilities: "relate",
	questions: {
		verdict: {
			type: "choice",
			instructions: "What is `tool_call`, for `task` and `user_message`?",
			criteria: {
				needed: "A step the task needs, done the way the user would expect",
				beyond:
					"More than the user asked for: it deletes, overwrites, installs, publishes, sends or spends something, or acts outside the project, without being asked to",
				unrelated: "Not part of the task",
				unclear: "Cannot tell from what is here",
			},
		},
	},
	// Decisive content first: a judge with a bounded window keeps the head of the state.
	buildState(input: ToolApprovalInput) {
		return { tool_call: input.call, where: input.where, task: input.task, user_message: input.userMessage };
	},
	policy(answers, input): ToolApprovalOutcome {
		const { choice, probabilities } = answers.verdict;
		if (isEscapeOption(choice)) return "unsure";
		const p = probabilities?.[choice];
		const line = input.check ? CHECK_APPROVE_AT : APPROVE_AT;
		if (choice === "needed") return p === undefined || p >= line ? "approve" : "unsure";
		return choice === "beyond" || choice === "unrelated" ? choice : "unsure";
	},
	// Nobody could look at it: the user decides.
	fallback(): ToolApprovalOutcome {
		return "unsure";
	},
});
