import { defineDecision } from "../decision.ts";
import { pickChoice, threeZone } from "../policy.ts";
import type { Answer, Question, Questions } from "../types.ts";

/**
 * The plain-language board. Its reader is the judge on purpose: what the
 * agent is doing now is a choice among a handful of phases, which acceptance
 * item it works on is a choice among the open ones, and whether the board is
 * worth writing again is a yes or no. Those answers are cheap, so the board
 * can look often; the model that writes the words for a person is only
 * called when the judge sees something new.
 */
export type BoardPhase =
	| "understanding"
	| "planning"
	| "changing"
	| "checking"
	| "fixing"
	| "waiting"
	| "wrapping_up"
	| "stuck";

export interface BoardStep {
	readonly tool: string;
	/** The command or the path, short. */
	readonly what: string;
	readonly failed: boolean;
	/** A test run, build, type check or linter. */
	readonly check: boolean;
}

/** Something that happened, for the judge to weigh: a step, something the agent said, an item ticked. */
export interface BoardEvent {
	readonly kind: "step" | "said" | "ticked";
	/** One line: `edit src/a.ts -> ok`, what the agent said, the item and its evidence. */
	readonly text: string;
	readonly failed?: boolean;
	readonly check?: boolean;
}

export interface BoardItem {
	readonly id: string;
	readonly text: string;
	readonly done: boolean;
}

export interface BoardInput {
	readonly goal: string;
	readonly items: readonly BoardItem[];
	/** The latest tool calls, oldest first. */
	readonly steps: readonly BoardStep[];
	/** The latest thing the agent said. */
	readonly latest: string;
	/** The agent stopped: its run ended and it waits for the user. */
	readonly ended: boolean;
	/**
	 * What happened since the board last spoke, or over the whole run once it ended: the candidates the judge
	 * picks the news from. Routine reading is left out before it gets here.
	 */
	readonly events?: readonly BoardEvent[];
	/** What the board said last time, when it said anything. */
	readonly last?: { readonly phase?: BoardPhase; readonly focus?: string; readonly now: string };
	/** Sub-agents at work right now, one line each: while they work the agent takes no step of its own. */
	readonly swarm?: string;
}

export type BoardReading = {
	/** By the judge, or by rule when it could not tell. */
	readonly phase: BoardPhase;
	/** The id of the acceptance item being worked on. */
	readonly focus: string | null;
	readonly needsUser: boolean;
	/** Worth writing the board again. */
	readonly update: boolean;
	/** Indexes into `events` the person would miss if the update left them out, oldest first. */
	readonly key: readonly number[];
};

/** Candidates asked about per look: one question each. */
export const MAX_EVENTS = 16;
/** The most the writer is given. */
export const MAX_KEY = 6;

/** One line, as the judge and the writer read it. */
export const describeEvent = (event: BoardEvent): string =>
	`${event.kind === "said" ? "the agent said: " : event.kind === "ticked" ? "item done: " : ""}${event.text}`;
const eventLine = (event: BoardEvent, index: number) => `${index + 1}. ${describeEvent(event)}`;

/** By rule, when the judge cannot pick: failures, checks, items done, and the last thing the agent said. */
export function keyByRule(events: readonly BoardEvent[]): number[] {
	const lastSaid = events.map((event) => event.kind).lastIndexOf("said");
	const picked = events.flatMap((event, index) =>
		event.failed || event.check || event.kind === "ticked" || index === lastSaid ? [index] : [],
	);
	return picked.slice(-MAX_KEY);
}

const MAX_ITEMS = 8;
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "web_fetch", "web_search", "browse", "locate"]);
const CHANGE_TOOLS = new Set(["edit", "write", "sg_rewrite", "conflicts_resolve", "apply_patch_from"]);

const PHASES: Record<BoardPhase | "other", string> = {
	understanding: "Reading code, files or pages to understand the task",
	planning: "Working out how to do it, nothing changed yet",
	changing: "Changing code or files",
	checking: "Running tests, a build or another check",
	fixing: "Fixing what a check, an error or the user reported",
	waiting: "Stopped, waiting for the user",
	wrapping_up: "Finished its work and summing up",
	stuck: "Repeating itself or going in circles",
	other: "Cannot tell",
};

const stepLine = (step: BoardStep) => `${step.tool} ${step.what} -> ${step.failed ? "error" : "ok"}`;
const choiceOf = (answer: Answer | undefined) => (answer?.type === "choice" ? pickChoice(answer) : undefined);
const EVENT_KINDS = {
	key: "News the person would want: a result, a finding, a decision, a failure, a check passing or failing, an item done",
	routine: "A routine step that tells them nothing new",
	unclear: "Cannot tell",
};
const verdict = (answer: Answer | undefined) => (answer?.type === "boolean" ? threeZone(answer) : "unsure");

/** Asks like a person would: questions end with a question mark, in either script. */
export function asksSomething(text: string): boolean {
	return /[?？]\s*$/.test(text.trim());
}

/** The phase by rule, when there is no judge: the kind of the last step, or how the run ended. */
export function phaseByRule(input: BoardInput): BoardPhase {
	if (input.ended) return asksSomething(input.latest) ? "waiting" : "wrapping_up";
	const last = input.steps.at(-1);
	if (!last) return "understanding";
	if (last.check) return last.failed ? "fixing" : "checking";
	if (CHANGE_TOOLS.has(last.tool))
		return input.steps.some((step) => step.check && step.failed) ? "fixing" : "changing";
	if (READ_ONLY_TOOLS.has(last.tool)) return "understanding";
	return "changing";
}

export const boardRead = defineDecision({
	id: "board.read",
	// 2: the judge also picks, among what happened, the news the writer is given. 3: it sees the sub-agents at work.
	// 4: needs_user only once the agent stopped; unsure about a change with nothing new is no change.
	version: 4,
	cacheImpact: "none",
	latency: "background",
	capabilities: "relate",
	questions: {} as Questions,
	questionsFor(input: BoardInput): Questions {
		const open = input.items.filter((item) => !item.done).slice(0, MAX_ITEMS);
		const questions: Record<string, Question> = {
			phase: {
				type: "choice",
				instructions:
					"What is the agent doing right now, judging by `steps`, `latest` and, when present, `sub_agents`?",
				criteria: PHASES,
			},
		};
		// Only once the agent stopped: a wait in the middle of a run is a permission request, and that is on the
		// board by rule the moment it is asked. Mid-run, the judge never put it above 0.3 in 82 looks.
		if (input.ended) {
			questions.needs_user = {
				type: "boolean",
				instructions: "Is the agent waiting for the user to confirm, decide or provide something?",
			};
		}
		if (open.length > 1) {
			questions.focus = {
				type: "choice",
				instructions: "Which open item of `items` are the latest `steps` working on?",
				criteria: {
					...Object.fromEntries(open.map((item) => [item.id, item.text.slice(0, 160)])),
					none: "None of them, or cannot tell",
				},
			};
		}
		// Asked as sufficiency, not relevance: the board shows the checklist and the phase anyway.
		(input.events ?? []).slice(-MAX_EVENTS).forEach((_event, index) => {
			questions[`event_${index}`] = {
				type: "choice",
				instructions: `A progress update for the person will show the checklist and what the agent is doing now. What is event ${index + 1} of \`events\` to that person?`,
				criteria: EVENT_KINDS,
			};
		});
		if (input.last) {
			questions.changed = {
				type: "boolean",
				instructions:
					"Compared with `last_board`, has something happened that the user would want to hear: a new phase, an item finished, a failure, a question to them?",
			};
		}
		return questions;
	},
	buildState(input: BoardInput) {
		return {
			goal: input.goal.slice(0, 600),
			items: input.items
				.slice(0, 20)
				.map((item) => `${item.id} [${item.done ? "done" : "open"}] ${item.text.slice(0, 160)}`)
				.join("\n"),
			steps: input.steps.map(stepLine).join("\n") || "(no tool calls yet)",
			latest: input.latest.slice(0, 800),
			agent_stopped: input.ended,
			...(input.swarm ? { sub_agents: input.swarm.slice(0, 1200) } : {}),
			...(input.events?.length
				? { events: input.events.slice(-MAX_EVENTS).map(eventLine).join("\n").slice(0, 6000) }
				: {}),
			...(input.last ? { last_board: `${input.last.phase ?? "?"}: ${input.last.now}`.slice(0, 400) } : {}),
		};
	},
	policy(answers, input): BoardReading {
		const picked = choiceOf(answers.phase) as BoardPhase | undefined;
		const open = input.items.filter((item) => !item.done);
		const focus = open.length === 1 ? open[0].id : (choiceOf(answers.focus) ?? null);
		const needsUser = input.ended && verdict(answers.needs_user) === "yes";
		const last = input.last;
		const told = verdict(answers.changed);
		// Unsure counts as changed when something happened or the run ended: a board one update late is worse than
		// one update too many. With nothing new it does not: a look on the clock while sub-agents worked wrote the
		// same board again every 20 s (unsure on 67 of 77 looks, 2026-10).
		const changed =
			!last ||
			told === "yes" ||
			(told === "unsure" && ((input.events?.length ?? 0) > 0 || input.ended)) ||
			(picked !== undefined && picked !== last.phase) ||
			focus !== (last.focus ?? null);
		const events = (input.events ?? []).slice(-MAX_EVENTS);
		// Picked when the judge said news or routine about any of them, not "cannot tell" about all.
		const answered = events.some((_event, index) => choiceOf(answers[`event_${index}`]) !== undefined);
		const key = answered
			? events
					.flatMap((_event, index) => (choiceOf(answers[`event_${index}`]) === "key" ? [index] : []))
					.slice(-MAX_KEY)
			: keyByRule(events);
		// A run that ended with work in it is always told once more, as a summing up; a chat reply is not work.
		const summingUp = input.ended && events.some((event) => event.kind !== "said");
		// News the judge picked is worth telling, whatever it said about the board as a whole.
		const news = answered && key.length > 0;
		return {
			phase: picked ?? phaseByRule(input),
			focus,
			needsUser,
			update: changed || needsUser || summingUp || news,
			key,
		};
	},
	fallback(input): BoardReading {
		const phase = phaseByRule(input);
		const open = input.items.filter((item) => !item.done);
		return {
			phase,
			focus: open.length === 1 ? open[0].id : null,
			needsUser: input.ended && asksSomething(input.latest),
			update: !input.last || input.last.phase !== phase || input.ended,
			key: keyByRule((input.events ?? []).slice(-MAX_EVENTS)),
		};
	},
});
