import { defineDecision } from "../decision.ts";
import { type Constraint, constraintId, type LimitIntent, type WorkChange } from "../frame/frame.ts";
import { hasChoiceEvidence } from "../policy.ts";
import { environmentSecrets, redactSecrets } from "../redact.ts";
import type { ChoiceAnswer, Questions } from "../types.ts";
import type { TaskFrame } from "./input-preflight.ts";

export interface TaskFrameInput {
	readonly userMessage: string;
	/** The frame as it stands before this message. */
	readonly frame: TaskFrame;
	/** Full active rules in /frame display order, including known failed adds. Only these can be targeted. */
	readonly activeConstraints?: readonly Constraint[];
	/** Short digests of the latest turns, oldest first: a bare "yes" or "the second one" only means something after them. */
	readonly recentTurns: readonly string[];
}

export type TaskFrameOutcome = { readonly change: WorkChange; readonly limit: LimitIntent };

const SURE = 0.6;
const CHANGED = 0.7;
const MAX_MESSAGE_CHARS = 600;
const MAX_TARGETS = 8;
const MAX_TARGET_CHARS = 1000;
const WORK_CHANGES = ["new_task", "correction", "subgoal"] as const;

const questions = {
	change: {
		type: "choice",
		instructions:
			"What work, if any, does `user_message` ask for now? A requested action within the current task is a subgoal even if the same message changes permission. Classify only the work here.",
		criteria: {
			new_task: "Replaces the overall goal with a different task.",
			correction: "Rejects or corrects the work the assistant was doing or planned to do.",
			subgoal: "Asks for a concrete step within this task, such as renaming a file or fixing an example.",
			none: "No new or corrected work: chat, a go-ahead for an already proposed step, or a change to limits alone.",
		},
	},
	limit: {
		type: "choice",
		instructions:
			"What limit does `user_message` explicitly add, lift, replace, or make an exception to? " +
			"Match rule N to the entry with `position: N` in `task_frame.constraints`. Positions refer to the full /frame list, not the order of the rows shown here. " +
			"Choose `unclear` if the intended rule is omitted or you cannot identify it unambiguously. Never substitute a shown rule for an omitted one. " +
			"If a rule pauses work until approval and the user now grants that approval, choose `withdraw_N`: the hold is over. " +
			"Permission limited to one act under a continuing rule is `once_N`, not `withdraw_N`. A generic go-ahead for a review does not authorize edits.",
		criteria: {
			none: "The user neither changes a limit nor explicitly permits an otherwise forbidden action.",
			add: "Adds an explicit limit on what work may do. This can be a separate clause of a request for work.",
			unclear:
				"A limit may change, but the change or its target is not clear, or multiple existing limits would change.",
		},
	},
} as const satisfies Questions;

function targetList(input: TaskFrameInput) {
	const seen = new Set<string>();
	const complete: { position: number; text: string }[] = [];
	for (const { text, partial } of input.activeConstraints ?? []) {
		// /frame shows the first occurrence of each text. Even an unusable row takes up its position there.
		if (seen.has(text)) continue;
		seen.add(text);
		// A prefix is neither safe to send as a quote nor enough to tell what the rule permits.
		if (!partial && text.length > 0 && text.length <= MAX_TARGET_CHARS) {
			complete.push({ position: seen.size, text });
		}
	}
	return { count: seen.size, targets: complete.slice(-MAX_TARGETS) };
}

function workVerdict({ choice, probabilities }: ChoiceAnswer<keyof typeof questions.change.criteria>): WorkChange {
	if (!probabilities) return choice;
	const ranked = WORK_CHANGES.map((kind) => ({ kind, weight: probabilities[kind] ?? 0 }));
	const best = ranked.reduce((a, b) => (a.weight >= b.weight ? a : b));
	if (best.weight >= SURE) return best.kind;
	// A partial distribution is not evidence that the remaining probability belongs to work changes.
	return ranked.reduce((sum, option) => sum + option.weight, 0) >= CHANGED ? "unclear" : "none";
}

function limitVerdict(answer: ChoiceAnswer, input: TaskFrameInput): LimitIntent {
	const { choice } = answer;
	if (choice === "none" || choice === "unclear") return { kind: choice };
	// The omitted part of a long message could qualify or reverse the apparent limit change.
	if (input.userMessage.length > MAX_MESSAGE_CHARS) return { kind: "unclear" };
	if (!hasChoiceEvidence(answer, SURE)) return { kind: "unclear" };
	if (choice === "add") return { kind: "add" };
	for (const { position, text } of targetList(input).targets) {
		if (choice === `withdraw_${position}`) return { kind: "withdraw", id: constraintId(text) };
		if (choice === `replace_${position}`) return { kind: "replace", id: constraintId(text) };
		if (choice === `once_${position}`) return { kind: "allow_once", id: constraintId(text) };
	}
	return { kind: "unclear" };
}

export const taskFrame = defineDecision({
	id: "task.frame",
	version: 7,
	cacheImpact: "append-only",
	latency: "inline",
	capabilities: "relate",
	questions,
	questionsFor(input: TaskFrameInput): Questions {
		const criteria: Record<string, string> = { ...questions.limit.criteria };
		// Keep rule text in state, where the engine can redact it before any quoting or serialization.
		for (const { position } of targetList(input).targets) {
			criteria[`withdraw_${position}`] =
				`Lifts rule ${position} for the work, including permission to start what this rule held until approval.`;
			criteria[`replace_${position}`] = `Explicitly replaces rule ${position} with a new ongoing limit.`;
			criteria[`once_${position}`] =
				`Grants only a single exception to recurring rule ${position}; keep the rule for the next call.`;
		}
		return { change: questions.change, limit: { ...questions.limit, criteria } };
	},
	// Decisive content first: a judge with a bounded window keeps the head of the state and cuts the tail.
	buildState(input: TaskFrameInput) {
		const { count, targets } = targetList(input);
		const long = input.userMessage.length > MAX_MESSAGE_CHARS;
		// Only a long message is shortened before engine redaction: take out its whole credentials first.
		const message = long ? redactSecrets(input.userMessage, environmentSecrets()) : input.userMessage;
		return {
			user_message: long ? `${message.slice(0, MAX_MESSAGE_CHARS - 1)}…` : message,
			task_frame: {
				goal: input.frame.goal,
				...(input.activeConstraints
					? { constraint_count: count, omitted_constraint_count: count - targets.length, constraints: targets }
					: { constraint_summary: input.frame.constraints ?? [] }),
				current_subgoal: input.frame.currentSubgoal ?? null,
			},
			recent_turns: input.recentTurns,
		};
	},
	policy(answers, input): TaskFrameOutcome {
		return { change: workVerdict(answers.change), limit: limitVerdict(answers.limit, input) };
	},
	fallback(): TaskFrameOutcome {
		return { change: "none", limit: { kind: "none" } };
	},
});
