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
 *
 * Version 3: `call` is the whole call with its line breaks, and a tool other
 * than a shell shows its whole input. Version 2 read the first 400 characters
 * of a short description, run into one line.
 *
 * Version 4: the line a step has to reach can be the one the user accepted for
 * the project (`approveAt`, from `/evolve accept`). It only ever lowers the
 * built-in line, and never below `LOWEST_APPROVE_AT`.
 */
export interface ToolApprovalInput {
	/** The task as the frame has it: goal, and the current subgoal when there is one. */
	readonly task: string;
	readonly userMessage: string;
	/** `bash: npm install lodash`, `write: {"path":"/etc/hosts","content":"…"}`: all of it (`approvalCall`). */
	readonly call: string;
	/** Where the call acts, said plainly: "inside the project folder" or where else. */
	readonly where: string;
	/** The call runs a check in the project and otherwise only looks (`isCheckChain`). Not shown to the judge. */
	readonly check?: boolean;
	/** The line the user accepted for this project, in place of the built-in one. Not shown to the judge. */
	readonly approveAt?: number;
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
/**
 * The lowest line an accepted adaptation can set. Under it the judge's "needed" is closer to a guess than to a
 * reading, whatever a user's answers so far say.
 */
export const LOWEST_APPROVE_AT = 0.6;

export const toolApproval = defineDecision({
	id: "tool.approval",
	version: 4,
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
		const builtIn = input.check ? CHECK_APPROVE_AT : APPROVE_AT;
		const line =
			input.approveAt === undefined ? builtIn : Math.min(builtIn, Math.max(LOWEST_APPROVE_AT, input.approveAt));
		if (choice === "needed") return p === undefined || p >= line ? "approve" : "unsure";
		return choice === "beyond" || choice === "unrelated" ? choice : "unsure";
	},
	// Nobody could look at it: the user decides.
	fallback(): ToolApprovalOutcome {
		return "unsure";
	},
});
