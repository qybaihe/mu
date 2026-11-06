import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { say } from "../../language.ts";
import { failOpen, type KyrnRuntime } from "../runtime.ts";

export const QUESTION_ENTRY = "kyrn.question";
export const PENDING_STATUS = "mu.ask.pending";
/** How the message /answer sends begins. */
const LATE_ANSWER = "[My answer to what you asked with ask_user";

export interface QuestionOption {
	readonly label: string;
	readonly description?: string;
}

export interface Question {
	readonly question: string;
	readonly header?: string;
	readonly options: readonly QuestionOption[];
	readonly multiSelect?: boolean;
}

/** One question's answer: the labels picked, or the user's own words, or nothing yet. */
export interface QuestionAnswer {
	readonly question: string;
	readonly selected: readonly string[];
	readonly custom?: string;
}

/**
 * `answered`: every question has an answer. `partly`: some do, and the user skipped the rest. `skipped`: none does.
 * `pending`: nobody answered within the wait, and the questions stay open. `stopped`: the run was stopped while asking.
 * `nobody`: there is no one to ask in this session.
 */
export type QuestionOutcome = "answered" | "partly" | "skipped" | "pending" | "stopped" | "nobody";

export interface QuestionRecord {
	readonly toolCallId: string;
	readonly count: number;
	readonly outcome: QuestionOutcome;
	readonly answered: number;
	readonly waitedMs: number;
	/** The answer came after the call had returned `pending`, through /answer. */
	readonly late?: true;
}

export interface QuestionDetails {
	readonly outcome: QuestionOutcome;
	readonly answers: readonly QuestionAnswer[];
}

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;

/** What the select dialog shows for an option: its label, and what it means when there is a description. */
export function choiceText(option: QuestionOption): string {
	const description = option.description?.trim();
	return description ? `${option.label} — ${description}` : option.label;
}

/**
 * What the user typed into a pick-any question: the numbers of the options they picked ("1,3", "2 4"), or, when it is
 * not only numbers of options, their own answer.
 */
export function readPicks(text: string, options: readonly QuestionOption[]): QuestionAnswer["selected"] | string {
	const tokens = text
		.split(/[\s,，、;]+/)
		.map((token) => token.trim())
		.filter(Boolean);
	if (tokens.length === 0) return [];
	const picked = new Set<number>();
	for (const token of tokens) {
		if (!/^\d+$/.test(token)) return text.trim();
		const index = Number(token) - 1;
		if (index < 0 || index >= options.length) return text.trim();
		picked.add(index);
	}
	return [...picked].sort((a, b) => a - b).map((index) => options[index].label);
}

/** The questions as the model gave them, cut to the sizes the tool takes. A question with no option keeps none. */
export function normalized(questions: readonly Question[]): Question[] {
	return questions.slice(0, MAX_QUESTIONS).map((question) => ({
		question: question.question.trim(),
		...(question.header?.trim() ? { header: question.header.trim() } : {}),
		options: (question.options ?? [])
			.filter((option) => option.label?.trim())
			.slice(0, MAX_OPTIONS)
			.map((option) => ({
				label: option.label.trim(),
				...(option.description?.trim() ? { description: option.description.trim() } : {}),
			})),
		...(question.multiSelect ? { multiSelect: true } : {}),
	}));
}

/** The answers as the model reads them, one line a question. */
export function answerLines(questions: readonly Question[], answers: readonly QuestionAnswer[]): string[] {
	return answers.map((answer, index) => {
		const header = questions[index]?.header;
		const asked = header ? `${header}: ${answer.question}` : answer.question;
		if (answer.custom !== undefined) return `- ${asked} → in their own words: ${JSON.stringify(answer.custom)}`;
		if (answer.selected.length === 0) return `- ${asked} → none of the options`;
		return `- ${asked} → ${answer.selected.join(", ")}`;
	});
}

const unanswered = (questions: readonly Question[], from: number): string[] =>
	questions.slice(from).map((question) => `- ${question.header ? `${question.header}: ` : ""}${question.question}`);

/** What the model is told, for each way asking can end. */
export function resultText(
	outcome: QuestionOutcome,
	questions: readonly Question[],
	answers: readonly QuestionAnswer[],
): string {
	const given = answerLines(questions, answers);
	switch (outcome) {
		case "answered":
			return ["The user answered:", ...given].join("\n");
		case "partly":
			return [
				"The user answered:",
				...given,
				"They skipped the rest:",
				...unanswered(questions, answers.length),
				"Do not ask those again, and do not take skipping as permission: carry on with what is settled, and say what you assumed.",
			].join("\n");
		case "skipped":
			return "The user skipped these questions. Do not ask them again, and do not take skipping as permission: carry on with what is settled, and say what you assumed.";
		case "pending":
			return [
				...(given.length > 0 ? ["The user answered:", ...given] : []),
				given.length > 0 ? "They have not answered yet:" : "The user has not answered yet:",
				...unanswered(questions, answers.length),
				"This is pending, not a skipped answer, and not permission. Carry on with work that does not depend on the answer. The questions stay open for them: if they answer, the answer comes as a message of theirs.",
			].join("\n");
		case "stopped":
			return "The user stopped the run while you were asking; nothing was answered.";
		case "nobody":
			return "Nobody can answer questions in this session. Take the choice that is easiest to undo, say which you took and why, and carry on.";
	}
}

interface Asked {
	readonly toolCallId: string;
	readonly questions: readonly Question[];
	/** The answers given before the wait ran out. */
	readonly answers: readonly QuestionAnswer[];
	readonly askedAt: number;
}

/** How asking ended: every question answered, or the first one skipped, out of time, or stopped. */
export type AskEnded = "answered" | "skipped" | "timeout" | "stopped";

/** Numbers the questions asked in this process, for the frames' ids. */
let asked = 0;

/**
 * Asks `questions` from the first one `from` does not answer on, one dialog each, each waiting `waitMs` (0: until
 * answered), with a `question.asked` frame before each dialog and a `question.resolved` one after it. Stops at the first
 * question skipped, out of time or stopped (`signal`), and says which of those it was. ask_user asks with it, and so
 * does plan mode, for its approval (features/plan.ts).
 */
export async function askQuestions(
	runtime: KyrnRuntime,
	ctx: ExtensionContext,
	questions: readonly Question[],
	options: {
		readonly toolCallId?: string;
		readonly from?: readonly QuestionAnswer[];
		readonly waitMs: number;
		readonly signal?: AbortSignal;
	},
): Promise<{ answers: QuestionAnswer[]; ended: AskEnded }> {
	const { toolCallId, waitMs, signal } = options;
	const answers = [...(options.from ?? [])];
	const other = say({ zh: "都不是，我自己写", en: "Something else (type it)" });
	for (let index = answers.length; index < questions.length; index++) {
		const question = questions[index];
		const id = `question-${++asked}`;
		const position = questions.length > 1 ? ` (${index + 1}/${questions.length})` : "";
		const title = `${question.header ? `${question.header}: ` : ""}${question.question}${position}`;
		const choices = question.options.map(choiceText);
		const pickAny = question.multiSelect === true && question.options.length > 0;
		runtime.present("question.asked", {
			id,
			...(toolCallId ? { toolCallId } : {}),
			index,
			count: questions.length,
			question: question.question,
			...(question.header ? { header: question.header } : {}),
			options: question.options,
			multiSelect: pickAny,
			// What the dialog that follows offers, in its order: a client that shows this as a card answers the dialog
			// with one of these, or, for a pick-any question, with the numbers of the options picked.
			dialog: pickAny ? "input" : "select",
			...(pickAny ? {} : { choices: [...choices, other] }),
		});
		const startedAt = Date.now();
		const timedOut = () => waitMs > 0 && Date.now() - startedAt >= waitMs - 50;
		const dialog = { ...(signal ? { signal } : {}), ...(waitMs > 0 ? { timeout: waitMs } : {}) };
		let answer: QuestionAnswer | undefined;
		if (pickAny) {
			const typed = await ctx.ui.input(
				[
					`${title} ${say({ zh: "（可多选）", en: "(pick any)" })}`,
					...choices.map((choice, at) => `${at + 1}. ${choice}`),
					say({
						zh: "输入选项编号，比如 1,3；也可以直接写你的回答。",
						en: "Type the numbers, like 1,3, or your own answer.",
					}),
				].join("\n"),
				"1,3",
				dialog,
			);
			if (typed?.trim()) {
				const picks = readPicks(typed, question.options);
				answer =
					typeof picks === "string"
						? { question: question.question, selected: [], custom: picks }
						: { question: question.question, selected: picks };
			}
		} else {
			const picked = await ctx.ui.select(title, question.options.length > 0 ? [...choices, other] : [other], dialog);
			if (picked !== undefined && picked !== other) {
				const at = choices.indexOf(picked);
				if (at >= 0) answer = { question: question.question, selected: [question.options[at].label] };
			} else if (picked === other) {
				const typed = await ctx.ui.input(title, undefined, dialog);
				if (typed?.trim()) {
					answer = { question: question.question, selected: [], custom: typed.trim() };
				}
			}
		}
		const ended = answer
			? undefined
			: signal?.aborted
				? ("stopped" as const)
				: timedOut()
					? ("timeout" as const)
					: ("skipped" as const);
		runtime.present("question.resolved", {
			id,
			...(toolCallId ? { toolCallId } : {}),
			index,
			outcome: answer ? "answered" : ended,
			...(answer ? { answer } : {}),
		});
		if (!answer) return { answers, ended: ended ?? "skipped" };
		answers.push(answer);
	}
	return { answers, ended: "answered" };
}

/**
 * `ask_user`: the model asks the user one to four questions, each with options to pick from and room for an answer of
 * their own. The terminal asks them one after another with the dialogs every client has (a select, or for a pick-any
 * question a line to type numbers into); before each one mu presents a `question.asked` frame with the question in
 * full, which a client can show as a card and answer the dialog from.
 *
 * Asking does not hold the run for long. Each question waits `waitMs` (0: until answered); when nobody answers in that
 * time the call returns that the questions are pending, the model carries on with what does not depend on them, and
 * `/answer` asks them again. That answer comes back as a message of the user's, steered into the run if one is going.
 * Esc skips the question and the ones after it; the model is told not to ask them again and not to take that as
 * permission, and a second ask_user in the same turn after a skip is answered with that at once.
 *
 * No person, no questions: the tool is left out of an unattended run (`catalog.unattendedHidden`), a sub-agent does not
 * have it, and without a UI it answers that nobody can answer. While questions are open, turn.continue does not send
 * the agent back for waiting on them (features/continuation.ts). Frames and the entry: kyrn/docs/features/ask-user.md.
 */
export function registerAskUser(runtime: KyrnRuntime): void {
	const options = runtime.options("askUser", {
		enabled: true,
		waitMs: 120_000,
	});
	if (!options.enabled || process.env.KYRN_SWARM_DEPTH) return;
	const { pi } = runtime;
	const waitMs = Math.max(0, Math.floor(Number(options.waitMs) || 0));
	/** Questions whose wait ran out, newest last, until /answer, or the next message of the user's, settles them. */
	const open: Asked[] = [];
	/** The turn in which the user skipped questions: asking again in it gets that answer at once. */
	let skippedTurn = -1;
	/** One set of questions at a time: two calls in one reply would otherwise open their dialogs over each other. */
	let queue: Promise<unknown> = Promise.resolve();

	const showOpen = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			PENDING_STATUS,
			open.length === 0
				? undefined
				: say({
						zh: "mu 有问题等你回答：输入 /answer",
						en: "mu has a question for you: type /answer",
					}),
		);
	};
	const settleOpen = (): void => {
		open.length = 0;
		runtime.questionsOpen = 0;
	};

	const askEach = (
		toolCallId: string,
		questions: readonly Question[],
		from: readonly QuestionAnswer[],
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
	) => askQuestions(runtime, ctx, questions, { toolCallId, from, waitMs, signal });

	const record = (data: QuestionRecord): void => pi.appendEntry(QUESTION_ENTRY, data);

	pi.registerTool({
		name: "ask_user",
		label: "Ask the user",
		description: `Ask the user one to four questions, each with options to pick from, when you need a decision only they can make and their request does not settle it. Not for a go-ahead on work they asked for, nor to confirm a plan you can carry out. Put the option you recommend first, with "(Recommended)" after its label. They can always answer in their own words.${waitMs > 0 ? ` If nobody answers within ${Math.round(waitMs / 1000)} seconds you are told so: carry on with work that does not depend on the answer.` : ""}`,
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					question: Type.String({ description: "The whole question" }),
					header: Type.Optional(Type.String({ description: "A short label for it, a few words" })),
					options: Type.Array(
						Type.Object({
							label: Type.String({ description: "The choice, in a few words" }),
							description: Type.Optional(Type.String({ description: "What picking it means" })),
						}),
						{ minItems: 2, maxItems: MAX_OPTIONS },
					),
					multiSelect: Type.Optional(Type.Boolean({ description: "They may pick more than one" })),
				}),
				{ minItems: 1, maxItems: MAX_QUESTIONS },
			),
		}),
		execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
			runtime.touch(ctx);
			const questions = normalized(params.questions as Question[]).filter((question) => question.question);
			if (questions.length === 0) throw new Error("ask_user needs at least one question.");
			const reply = (outcome: QuestionOutcome, answers: readonly QuestionAnswer[]) => ({
				content: [{ type: "text" as const, text: resultText(outcome, questions, answers) }],
				details: { outcome, answers } satisfies QuestionDetails,
			});
			if (!ctx.hasUI) {
				record({ toolCallId, count: questions.length, outcome: "nobody", answered: 0, waitedMs: 0 });
				return reply("nobody", []);
			}
			if (skippedTurn === runtime.userTurns) {
				return {
					content: [
						{
							type: "text" as const,
							text: "The user already skipped your questions in this turn. Do not ask again: carry on with what is settled, and say what you assumed.",
						},
					],
					details: { outcome: "skipped", answers: [] } satisfies QuestionDetails,
				};
			}
			const run = queue.then(async () => {
				const askedAt = Date.now();
				const { answers, ended } = await askEach(toolCallId, questions, [], ctx, signal ?? ctx.signal);
				const outcome: QuestionOutcome =
					ended === "answered"
						? "answered"
						: ended === "stopped"
							? "stopped"
							: ended === "timeout"
								? "pending"
								: answers.length > 0
									? "partly"
									: "skipped";
				if (outcome === "skipped" || outcome === "partly") skippedTurn = runtime.userTurns;
				if (outcome === "pending") {
					open.push({ toolCallId, questions, answers, askedAt });
					runtime.questionsOpen = open.length;
					showOpen(ctx);
				}
				record({
					toolCallId,
					count: questions.length,
					outcome,
					answered: answers.length,
					waitedMs: Date.now() - askedAt,
				});
				return reply(outcome, answers);
			});
			queue = run.catch(() => {});
			return run;
		},
	});

	pi.registerCommand("answer", {
		description: say({
			zh: "回答 mu 还在等你回答的问题",
			en: "Answer the questions mu is still waiting on",
		}),
		handler: async (_args, ctx) => {
			runtime.touch(ctx);
			const asking = open.shift();
			runtime.questionsOpen = open.length;
			if (!asking) {
				ctx.ui.notify(say({ zh: "没有等你回答的问题。", en: "No question is waiting for you." }), "info");
				return;
			}
			const { answers, ended } = await askEach(asking.toolCallId, asking.questions, asking.answers, ctx, undefined);
			if (ended === "timeout") {
				open.unshift({ ...asking, answers });
				runtime.questionsOpen = open.length;
				showOpen(ctx);
				return;
			}
			showOpen(ctx);
			const fresh = answers.slice(asking.answers.length);
			record({
				toolCallId: asking.toolCallId,
				count: asking.questions.length,
				outcome: ended === "answered" ? "answered" : fresh.length > 0 ? "partly" : "skipped",
				answered: answers.length,
				waitedMs: Date.now() - asking.askedAt,
				late: true,
			});
			const lines =
				fresh.length > 0
					? answerLines(asking.questions.slice(asking.answers.length), fresh)
					: [
							"I skipped them. Do not ask again, and do not take skipping as permission: carry on with what is settled, and say what you assumed.",
						];
			const skippedRest =
				fresh.length > 0 && answers.length < asking.questions.length
					? ["I skipped the rest; do not ask those again."]
					: [];
			pi.sendUserMessage(
				[`${LATE_ANSWER} (call ${asking.toolCallId}), after you carried on]`, ...lines, ...skippedRest].join("\n"),
				{ deliverAs: "steer" },
			);
		},
	});

	// The user wrote to the agent: what they say now is their answer, and what was still open is no longer waited on.
	// Not when the message is an answer /answer sent: the other open questions still wait for theirs.
	pi.on(
		"before_agent_start",
		failOpen((event, ctx) => {
			if (open.length === 0 || event.messageType !== "user" || event.prompt.startsWith(LATE_ANSWER))
				return undefined;
			settleOpen();
			showOpen(ctx);
			return undefined;
		}),
	);
	pi.on(
		"session_shutdown",
		failOpen(() => {
			settleOpen();
			return undefined;
		}),
	);

	runtime.catalog.register({
		id: "tool:ask_user",
		kind: "tool",
		title: "Ask the user",
		description:
			"Asks the user up to four questions with options to pick from when a decision is theirs to make; a question nobody answers in time stays open for /answer while the agent carries on.",
		tools: ["ask_user"],
		exposure: "always",
	});
}
