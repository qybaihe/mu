import {
	type AcceptanceItem,
	applyLimit,
	changesWork,
	constraintId,
	type Frame,
	flat,
	limitQuotes,
	MAX_ACCEPTANCE,
	MAX_OPEN_QUESTIONS,
	noteUnresolved,
	quoteWords,
	type UserText,
} from "./frame.ts";

/**
 * The contract with the writer model. A judge cannot write, so a generative
 * model produces the new frame, and this file is what keeps it honest: its
 * reply is parsed strictly. The writer may select an exact new quote only
 * when the independent limit verdict permits it, and cannot remove a rule.
 */
export const WRITER_SYSTEM = `You maintain the task frame of a coding agent: a short, exact record of what the user wants. You get the current frame and what the user just said. Reply with the new frame as one JSON object and nothing else:
{"goal": string, "constraints": string[], "current_subgoal": string | null, "acceptance": [{"id": string, "text": string}], "open_questions": string[]}

- goal: one or two sentences. Keep the current goal unless the user replaced the task.
- constraints: an array of STRINGS, not objects. Return only NEW limits, never the existing_limits from the input. For limit: add or replace, copy each complete new limit clause WORD FOR WORD from that user message, including qualifiers and exceptions. For replace, return just the new limit, not words granting permission. For all other verdicts return []. Example: for “Rename the file, but do not change its contents.” with limit: add, return ["do not change its contents."], not the rename.
- current_subgoal: the work wanted right now, or null. Do not include limits here; a message that only changes a limit does not change the work.
- acceptance: what must be true for the task to be finished, as the user said or clearly implied. Keep existing items with their "id"; leave "id" out of new ones. At most 8.
- open_questions: what is still undecided. If you cannot tell whether the message replaces the task or adds to it, keep the goal and put that question here.`;

export interface WriterFrame {
	readonly goal: string;
	readonly constraints: readonly string[];
	readonly currentSubgoal?: string;
	readonly acceptance: readonly { readonly id?: string; readonly text: string }[];
	readonly openQuestions: readonly string[];
}

export function writerRequest(frame: Frame, said: readonly UserText[]): { system: string; user: string } {
	const current = {
		goal: frame.goal,
		existing_limits: frame.constraints.map(({ text }) => text),
		current_subgoal: frame.currentSubgoal ?? null,
		acceptance: frame.acceptance.map((item) => ({ id: item.id, text: item.text, done: item.done })),
		open_questions: frame.openQuestions,
	};
	const messages = said.map((each) => {
		const limit = each.limit;
		const oldRule =
			limit?.kind === "replace" ? frame.constraints.find(({ text }) => constraintId(text) === limit.id) : undefined;
		return `USER MESSAGE (turn ${each.turn}, work: ${each.change ?? "none"}, limit: ${limit?.kind ?? "none"}${oldRule ? `, replacing ${JSON.stringify(oldRule.text)}` : ""}):\n${each.text}`;
	});
	return {
		system: WRITER_SYSTEM,
		user: `CURRENT FRAME:\n${JSON.stringify(current, null, 1)}\n\n${messages.join("\n\n")}`,
	};
}

const isText = (value: unknown): value is string => typeof value === "string";

/** Strict: anything that is not exactly the asked-for shape is refused, and the caller keeps the last valid frame. */
export function parseWriterReply(reply: string): { ok: true; value: WriterFrame } | { ok: false; problem: string } {
	const start = reply.indexOf("{");
	const end = reply.lastIndexOf("}");
	if (start === -1 || end <= start) return { ok: false, problem: "no JSON object in the reply" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(reply.slice(start, end + 1));
	} catch {
		return { ok: false, problem: "the reply is not valid JSON" };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, problem: "the reply is not an object" };
	}
	const record = parsed as Record<string, unknown>;
	if (!isText(record.goal) || !record.goal.trim()) return { ok: false, problem: "goal is missing" };
	if (!Array.isArray(record.constraints) || !record.constraints.every(isText)) {
		return { ok: false, problem: "constraints is not a list of strings" };
	}
	if (record.current_subgoal !== undefined && record.current_subgoal !== null && !isText(record.current_subgoal)) {
		return { ok: false, problem: "current_subgoal is not a string or null" };
	}
	if (!Array.isArray(record.acceptance)) return { ok: false, problem: "acceptance is not a list" };
	const acceptance: { id?: string; text: string }[] = [];
	for (const item of record.acceptance) {
		// A bare string is an item without an id; anything else must be the asked-for object.
		if (isText(item)) acceptance.push({ text: item });
		else if (typeof item === "object" && item !== null && isText((item as { text?: unknown }).text)) {
			const id = (item as { id?: unknown }).id;
			if (id !== undefined && id !== null && !isText(id))
				return { ok: false, problem: "an acceptance id is not a string" };
			acceptance.push({ id: isText(id) ? id : undefined, text: (item as { text: string }).text });
		} else return { ok: false, problem: "an acceptance item has no text" };
	}
	if (!Array.isArray(record.open_questions) || !record.open_questions.every(isText)) {
		return { ok: false, problem: "open_questions is not a list of strings" };
	}
	return {
		ok: true,
		value: {
			goal: record.goal,
			constraints: record.constraints,
			currentSubgoal: isText(record.current_subgoal) ? record.current_subgoal : undefined,
			acceptance,
			openQuestions: record.open_questions,
		},
	};
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where `needle` stands in `haystack`, as the haystack spells it. Line breaks,
 * runs of spaces, wrapping quotes and a closing full stop do not count as a
 * difference; any other difference does. This locates words, not clause
 * boundaries: a found fragment is not enough to add a limit.
 */
export function findVerbatim(haystack: string, needle: string): string | undefined {
	const core = quoteWords(needle);
	if (!core) return undefined;
	const words = core.split(" ").map(escapeRegExp);
	return new RegExp(words.join("\\s+")).exec(haystack)?.[0];
}

/**
 * The writer's reply merged over the last valid frame.
 *
 * Work verdicts authorize changes to the task. Limit verdicts authorize exact
 * quotes or a targeted removal, never removal by omission. The acceptance
 * list still keeps ticks and evidence unless the writer rewords an item.
 */
export function mergeWriterFrame(frame: Frame, reply: WriterFrame, said: readonly UserText[]): Frame {
	const latest = said.at(-1);
	const newTask = said.some((each) => each.change === "new_task");
	const mayDrop = newTask || said.some((each) => each.change === "correction");
	const questions = reply.openQuestions.map((question) => flat(question, 300)).filter(Boolean);

	let nextItem = frame.nextItem;
	const seen = new Set<string>();
	const acceptance: AcceptanceItem[] = [];
	for (const wanted of reply.acceptance.slice(0, MAX_ACCEPTANCE)) {
		const text = flat(wanted.text, 300);
		if (!text) continue;
		const existing = frame.acceptance.find((item) => item.id === wanted.id?.trim().toLowerCase());
		if (existing && !seen.has(existing.id)) {
			seen.add(existing.id);
			// Reworded means the old tick was for something else.
			acceptance.push(
				existing.text === text ? existing : { id: existing.id, text, done: false, addedBy: existing.addedBy },
			);
		} else if (!acceptance.some((item) => item.text === text)) {
			acceptance.push({ id: `a${nextItem++}`, text, done: false, addedBy: "writer" });
		}
	}
	if (!mayDrop) acceptance.unshift(...frame.acceptance.filter((item) => !seen.has(item.id)));

	const workChanged = said.some((each) => changesWork(each.change));
	const workUnclear = said.some((each) => each.change === "unclear");
	let next: Frame = {
		...frame,
		version: frame.version + 1,
		goal: newTask ? flat(reply.goal, 600) : frame.goal,
		currentSubgoal:
			workChanged || (workUnclear && reply.currentSubgoal)
				? reply.currentSubgoal && flat(reply.currentSubgoal, 300)
				: frame.currentSubgoal,
		acceptance,
		openQuestions: [...new Set(questions)].slice(0, MAX_OPEN_QUESTIONS),
		updatedTurn: latest?.turn ?? frame.updatedTurn,
		source: "writer",
		change: latest?.change,
		nextItem,
	};
	const writerQuotes = new Set(reply.constraints.map(quoteWords).filter(Boolean));
	const subgoalWords = reply.currentSubgoal ? [quoteWords(reply.currentSubgoal)] : [];
	const taskWords = newTask ? [...subgoalWords, quoteWords(reply.goal)] : subgoalWords;
	for (const each of said) {
		if ((each.change === "unclear" && !reply.currentSubgoal) || each.change === "constraint")
			next = noteUnresolved(next, each);
		const workWords = each.change === "new_task" ? taskWords : changesWork(each.change) ? subgoalWords : [];
		const quotes = limitQuotes(each, writerQuotes, workWords);
		next = applyLimit(next, each, quotes);
	}
	return next;
}
