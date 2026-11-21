import { createHash } from "node:crypto";
import type { TaskFrame } from "../decisions/input-preflight.ts";

/**
 * The task frame (PRD FR-02): what the user wants, as the harness knows it.
 *
 * Everything here is pure, so it can be tested without a session. A frame is
 * never edited in place: a change of task makes a new version, progress on the
 * acceptance list makes a new object with the same version, and both are
 * stored as session entries by the feature.
 *
 * Hard constraints are the user's own words, copied out of their message with
 * a note of where they came from. Nothing in this file shortens or rephrases
 * one; the compact view for judges is the only lossy form, and it is derived.
 */
export type WorkChange = "new_task" | "correction" | "subgoal" | "unclear" | "none";
/** `constraint` remains readable in frames written before work and limits were split. */
export type FrameChange = Exclude<WorkChange, "none"> | "constraint";
export type LimitIntent =
	| { readonly kind: "none" | "add" | "unclear" }
	| { readonly kind: "withdraw" | "replace"; readonly id: string }
	/** A turn-local permission. It never changes the frame's rules. */
	| { readonly kind: "allow_once"; readonly id: string };

export interface FrameSource {
	/** The user turn as the runtime counted it. It restarts with the harness; the entry id is the durable reference. */
	readonly turn: number;
	/** The session entry of the user message, once the message is in the session. */
	readonly entryId?: string;
}

export interface Constraint {
	/** Copied from the user's message. Never a paraphrase. */
	readonly text: string;
	readonly source: FrameSource;
	/** Legacy truncated quote: `text` is its beginning, the entry holds the rest. */
	readonly partial?: boolean;
}

export interface AcceptanceItem {
	readonly id: string;
	readonly text: string;
	readonly done: boolean;
	readonly doneBy?: "model" | "user";
	/** One line on what showed the item was met. */
	readonly evidence?: string;
	readonly addedBy: "writer" | "model" | "user";
}

export interface Frame {
	readonly version: number;
	readonly goal: string;
	readonly constraints: readonly Constraint[];
	readonly currentSubgoal?: string;
	/** The acceptance criteria, which are also the to-do list. */
	readonly acceptance: readonly AcceptanceItem[];
	readonly openQuestions: readonly string[];
	/** The user turn that made this version. */
	readonly updatedTurn: number;
	readonly source: "first-message" | "writer" | "rules";
	/** What the judge called the message that made this version. */
	readonly change?: FrameChange;
	/** Number of the next acceptance item, so an id is never handed out twice. */
	readonly nextItem: number;
}

/** Something the user said, and where. */
export interface UserText {
	readonly text: string;
	readonly turn: number;
	readonly entryId?: string;
	readonly change?: FrameChange;
	/** The independent limit verdict; missing on entries from before task.frame v2. */
	readonly limit?: LimitIntent;
	/** Rules explicitly withdrawn after this message failed. Retrying it cannot add those quotes back. */
	readonly withdrawnQuoteIds?: readonly string[];
}

/**
 * - `failed`: the judge saw a change and the writer could not produce the new frame.
 * - `late`: the update is still running although the turn has started.
 * - `unjudged`: no verdict was to be had (decision off or in shadow, judge down).
 */
export type UnmergedReason = "failed" | "late" | "unjudged";

export interface UnmergedText extends UserText {
	readonly reason: UnmergedReason;
}

/** The last valid frame, plus what the user said since that it does not account for. */
export interface FrameState {
	readonly frame?: Frame;
	readonly unmerged: readonly UnmergedText[];
}

export const EMPTY_STATE: FrameState = { unmerged: [] };

const GOAL_CHARS = 600;
const SUBGOAL_CHARS = 300;
const ITEM_CHARS = 300;
const INHERITED_CONSTRAINT_CHARS = 1000;
export const MAX_OPEN_QUESTIONS = 8;
export const MAX_ACCEPTANCE = 12;

export function flat(text: string, length: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length <= length ? line : `${line.slice(0, length - 1)}…`;
}

function sourceOf(text: UserText): FrameSource {
	return text.entryId ? { turn: text.turn, entryId: text.entryId } : { turn: text.turn };
}

/** Stable ID of the full stored quote; provenance and position are not part of its identity. */
export function constraintId(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Remove one rule by exact ID, including duplicate copies. The caller owns versioning. */
export function removeConstraint(frame: Frame, id: string): Frame {
	const constraints = frame.constraints.filter(({ text }) => constraintId(text) !== id);
	return constraints.length === frame.constraints.length ? frame : { ...frame, constraints };
}

/** Version 1: the first message is the goal. No judge and no writer are needed to know that. */
export function createFrame(first: UserText): Frame {
	return {
		version: 1,
		goal: flat(first.text, GOAL_CHARS),
		constraints: [],
		acceptance: [],
		openQuestions: [],
		updatedTurn: first.turn,
		source: "first-message",
		nextItem: 1,
	};
}

/** A sub-agent works under its parent's constraints. Turn 0 marks them as handed down, not said in this session. */
export function inheritConstraints(frame: Frame, texts: readonly string[]): Frame {
	const known = new Set(frame.constraints.map((constraint) => constraint.text));
	const added: Constraint[] = [];
	for (const raw of texts) {
		const text = raw.trim().slice(0, INHERITED_CONSTRAINT_CHARS);
		if (text.length === 0 || known.has(text)) continue;
		known.add(text);
		added.push({ text, source: { turn: 0 } });
	}
	return added.length === 0 ? frame : { ...frame, constraints: [...frame.constraints, ...added] };
}

/** What the parent put into `KYRN_SWARM_CONSTRAINTS`: a JSON list of sentences. Anything else is nothing. */
export function parseInheritedConstraints(raw: string | undefined): readonly string[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string").slice(0, 12)
			: [];
	} catch {
		return [];
	}
}

/** The one open question the rules write, for a message whose effect on the task nobody could tell. */
function unclearChange(message: string): string {
	return `How does this change the task: "${message}"?`;
}

const UNCLEAR_CHANGE = /^How does this change the task: "([\s\S]*)"\?$/;

/**
 * An open question as a code, for a client that translates: `unclear_change` {message} for the rules' own
 * question, null for one the writer model wrote (its words are data).
 */
export function openQuestionCode(question: string): { code: "unclear_change"; params: { message: string } } | null {
	const match = UNCLEAR_CHANGE.exec(question);
	return match ? { code: "unclear_change", params: { message: match[1] } } : null;
}

const SENTENCE_BREAK = /(?<=[。！？])|(?<=[.!?])\s+|\n\s*\n/u;
const QUESTION_END = /[?？]$/;
const NEGATIVE_LIMIT =
	/^(?:(?:please\s+)?(?:do not\b|don['’]t\b|never\b(?!\s+mind\b)|you must not\b)|(?:请)?(?:不要|先别|别|不得|只能))/iu;
const KEEP_UNCHANGED =
	/^(?:(?:please\s+)?(?:keep|leave)\s+.+?\s+(?:unchanged|intact|as (?:is|it is))\b|(?:请)?(?:保持|维持).+?不变)/iu;
const SCOPE_START =
	/^(?:(?:if|unless|when|while|for|during|before|after|until|except|only)\b|如果|除非|只有|仅在|在.+[时前后])/iu;
const SCOPE_BREAK = /[,，:]\s*/u;

function explicitLimit(text: string): boolean {
	if (QUESTION_END.test(text)) return false;
	const startsLimit = (part: string) => NEGATIVE_LIMIT.test(part) || KEEP_UNCHANGED.test(part);
	if (startsLimit(text)) return true;
	// Recognize a directive under an introductory condition without discarding the condition.
	const boundary = SCOPE_START.test(text) && SCOPE_BREAK.exec(text);
	return Boolean(boundary && startsLimit(text.slice(boundary.index + boundary[0].length)));
}

/** Sentence boundaries, not every comma or conjunction: the rest of a sentence may qualify its rule. */
export function limitClauses(text: string): string[] {
	return text
		.split(SENTENCE_BREAK)
		.map((part) => part.trim())
		.filter(Boolean);
}

// Work cues help locate boundaries in the fallback. They don't authorize a limit.
const TASK_START =
	/^(?:(?:please\s+)?(?:rename|fix|add|run|review|implement|update|replace)\s+|(?:请)?(?:更新|修复|重命名|补充))/iu;
const JOIN = /,?\s+(?:but|and)\s+|[，,]\s*(?:但是|但|同时|并且|并)\s*|(?<!不)但是?/iu;
const REPLACEMENT_LABEL = /^(?:please\s+)?replace\b[^:]*\bwith:\s*/iu;
const CONDITION = /\b(?:if|unless|provided that|as long as)\b|如果|除非|只要/iu;
const CONTINUATION =
	/^(?:but\b|however\b|except\b|otherwise\b|only if\b|unless\b|(?:you\s+)?(?:may|can)\b|但|不过|例外|可以)|\b(?:are|is) (?:fine|allowed|okay|permitted|exempt)\b|\b(?:does not apply|exception for|may still|can still)\b|(?:也|仍然)可以|除外/iu;
// A writer can confirm the entire sentence even when an inline “after” has no punctuation.
const QUALIFIER_END = /[,，:]\s*|后\s*/u;
const NEW_TOPIC = /^(?:(?:also|separately|instead|then)\b[,\s]|另外|此外|接着|然后|顺便)/iu;
const CONTINUE_PLAN = /^(?:请)?(?:保留|沿用|继续)/u;
const CANCEL_STEP = /^(?:取消|撤掉|跳过|不再做)/u;

type ClausePair = { before: string; after: string };

/** Only consider the first join: a later one may introduce an exception to the limit. */
function clausePair(sentence: string): ClausePair | undefined {
	const join = JOIN.exec(sentence);
	if (!join) return undefined;
	const before = sentence.slice(0, join.index).trim();
	const after = sentence.slice(join.index + join[0].length).trim();
	return before && after ? { before, after } : undefined;
}

/** Only these work verdicts authorize the writer to update what is being done. */
export function changesWork(change: UserText["change"]): boolean {
	return change === "new_task" || change === "subgoal" || change === "correction";
}

/** Keep unresolved user words visible without enforcing them. */
export function noteUnresolved(frame: Frame, said: UserText): Frame {
	const question = unclearChange(flat(said.text, 200));
	if (frame.openQuestions.includes(question)) return frame;
	return { ...frame, openQuestions: [...frame.openQuestions, question].slice(-MAX_OPEN_QUESTIONS) };
}

/** Apply the verdict and selected verbatim clauses. A replacement needs exactly one new quote. */
export function applyLimit(frame: Frame, said: UserText, quotes: readonly string[]): Frame {
	const limit = said.limit;
	if (!limit || limit.kind === "none" || limit.kind === "allow_once") return frame;
	if (limit.kind === "unclear") return noteUnresolved(frame, said);
	if (limit.kind === "withdraw") return removeConstraint(frame, limit.id);

	let additions = [...new Set(quotes)];
	let kept = frame;
	if (limit.kind === "replace") {
		additions = additions.filter((quote) => constraintId(quote) !== limit.id);
		kept = removeConstraint(frame, limit.id);
		if (kept === frame || additions.length !== 1) return noteUnresolved(frame, said);
	} else if (!additions.length) return noteUnresolved(frame, said);

	// Withdrawing the new quote skips its addition, not the validated removal of the old rule.
	const known = new Set(kept.constraints.map(({ text }) => text));
	const source = sourceOf(said);
	const added = additions
		.filter((text) => !known.has(text) && !said.withdrawnQuoteIds?.includes(constraintId(text)))
		.map((text) => ({ text, source }));
	return added.length ? { ...kept, constraints: [...kept.constraints, ...added] } : kept;
}

/** Compare quotes without changing how the user's source text will be stored. */
export function quoteWords(text: string): string {
	return text
		.trim()
		.replace(/^["'“”‘’「『]+|["'“”‘’」』]+$/g, "")
		.replace(/[.。!！]+$/, "")
		.replace(/\s+/g, " ")
		.trim();
}

type LimitClause = { quote: string; workBefore?: string; workAfter?: string };

/** Select complete source spans, using the writer's quoted boundaries when available. */
export function limitQuotes(said: UserText, writerQuotes: ReadonlySet<string>, workWords: readonly string[]): string[] {
	if (said.limit?.kind === "replace" && said.withdrawnQuoteIds?.length) {
		// A withdrawal can name the quote projected by the rules. Keep that evidence even if the writer omits it.
		const projected = selectLimits(said).quotes;
		if (projected.length === 1) {
			const id = constraintId(projected[0]);
			if (id !== said.limit.id && said.withdrawnQuoteIds.includes(id)) return projected;
		}
	}
	return selectLimits(said, writerQuotes, workWords).quotes;
}

function selectLimits(
	said: UserText,
	writerQuotes?: ReadonlySet<string>,
	workWords: readonly string[] = [],
): { quotes: string[]; work: string } {
	const kind = said.limit?.kind;
	const whole = said.text.trim();
	if ((kind !== "add" && kind !== "replace") || !whole) return { quotes: [], work: whole };
	const sentences = limitClauses(whole);
	if (kind === "add" && !said.change) {
		// The verdict identifies the whole message as a limit. Split only independent rules.
		const independent = sentences.every(explicitLimit) && !sentences.slice(1).some((text) => CONTINUATION.test(text));
		return { quotes: independent ? sentences : [whole], work: "" };
	}

	const isWork = (text: string) => workWords.includes(quoteWords(text));
	const isQuoted = (text: string) => writerQuotes?.has(quoteWords(text)) === true;
	const selection = kind === "add" || !writerQuotes ? "allow_directive" : "require_quote";
	let offset = 0;
	const spans = sentences.map((text) => {
		// Keep source offsets so extending a quote preserves the original whitespace.
		const start = whole.indexOf(text, offset);
		offset = start + text.length;
		return { text, start, end: offset, clause: selectLimitClause(text, kind, isWork, isQuoted, selection) };
	});
	const quotes: string[] = [];
	const remaining: string[] = [];
	for (let i = 0; i < spans.length; i++) {
		const { text, start, end, clause } = spans[i];
		if (!clause) {
			remaining.push(text);
			continue;
		}
		const first = i;
		const quoteStart = clause.workAfter ? start : end - clause.quote.length;
		let quote: string | undefined = clause.quote;
		while (i + 1 < spans.length) {
			const next = spans[i + 1];
			const condition = CONDITION.test(next.text);
			const independent =
				next.clause !== undefined ||
				(!condition && (isWork(next.text) || TASK_START.test(next.text) || NEW_TOPIC.test(next.text)));
			const qualifies = CONTINUATION.test(next.text) || (condition && !independent);
			if (independent && !qualifies) break;
			const extended = whole.slice(quoteStart, next.end);
			if (!qualifies && !isQuoted(extended)) {
				// Unknown prose could qualify the limit. Don't save the limit on its own.
				quote = undefined;
				break;
			}
			quote = extended;
			i++;
		}
		if (quote === undefined) {
			remaining.push(...sentences.slice(first, i + 1));
			continue;
		}
		quotes.push(quote);
		if (clause.workBefore) remaining.push(clause.workBefore);
		if (clause.workAfter && i === first) remaining.push(clause.workAfter);
	}
	return { quotes, work: remaining.join(" ") };
}

function selectLimitClause(
	text: string,
	kind: "add" | "replace",
	isWork: (text: string) => boolean,
	isQuoted: (text: string) => boolean,
	selection: "allow_directive" | "require_quote",
): LimitClause | undefined {
	if (QUESTION_END.test(text)) return undefined;
	const selected = (clause: string) => isQuoted(clause) || (selection === "allow_directive" && explicitLimit(clause));
	const startsWork = (clause: string) => isWork(clause) || TASK_START.test(clause);
	const joined = clausePair(text);
	// Scope before the join may still govern the directive after it.
	const pair =
		joined && !/[,，;；]/u.test(joined.before) && !SCOPE_START.test(joined.before) && !CONDITION.test(joined.before)
			? joined
			: undefined;
	const workBefore = pair && startsWork(pair.before) ? pair.before : undefined;
	if (kind === "replace") {
		const replacement = workBefore && pair ? pair.after : text;
		const label = REPLACEMENT_LABEL.exec(replacement);
		if (label) {
			const quote = replacement.slice(label[0].length);
			return selected(quote) ? { quote, workBefore } : undefined;
		}
	}
	if (pair) {
		const { before, after } = pair;
		if (kind === "add" && CONTINUE_PLAN.test(before) && CANCEL_STEP.test(after)) {
			// An exact boundary separates the canceled step; a legacy paraphrase cannot narrow it.
			return isQuoted(after) ? { quote: after, workBefore: before } : { quote: text };
		}
		const startsWithLimit = explicitLimit(before);
		if (!startsWithLimit && workBefore && selected(after) && (explicitLimit(after) || isWork(before))) {
			return { quote: after, workBefore };
		}
		if (startsWithLimit && !CONTINUATION.test(after) && !CONDITION.test(after) && startsWork(after)) {
			// A trailing request may instead be an exception. Don't cut it off without an exact work quote.
			if (isWork(after) && selected(before)) return { quote: before, workAfter: after };
			return isQuoted(text) ? { quote: text } : undefined;
		}
	}
	if (explicitLimit(text) && (selection === "allow_directive" || isQuoted(text))) return { quote: text };
	if (!isQuoted(text) || isWork(text)) return undefined;
	// A sentence starting with work needs a limit cue before its full quote can be kept.
	if (
		!TASK_START.test(text) ||
		(joined && explicitLimit(joined.after)) ||
		text.split(QUALIFIER_END).slice(1).some(explicitLimit)
	) {
		return { quote: text };
	}
	return undefined;
}

/** Update without a writer; if work and limits can't be separated, keep the words as a question. */
export function ruleUpdate(frame: Frame, said: UserText): Frame {
	let next: Frame = {
		...frame,
		version: frame.version + 1,
		updatedTurn: said.turn,
		source: "rules",
		change: said.change,
	};
	const { quotes, work } = selectLimits(said);
	if (changesWork(said.change)) {
		if (said.change === "new_task") {
			next = {
				...next,
				goal: flat(work || said.text, GOAL_CHARS),
				currentSubgoal: undefined,
				acceptance: [],
				openQuestions: [],
			};
		} else if (work || said.change === "subgoal")
			next = { ...next, currentSubgoal: flat(work || said.text, SUBGOAL_CHARS) };
	} else if (said.change === "unclear" || said.change === "constraint") next = noteUnresolved(next, said);
	return applyLimit(next, said, quotes);
}

/** Ticking is progress, not a change of task: same version. */
export function tickItem(
	frame: Frame,
	id: string,
	evidence: string,
	by: "model" | "user",
): { frame: Frame; item: AcceptanceItem } | { error: string } {
	const wanted = id.trim().replace(/^#/, "").toLowerCase();
	const found = frame.acceptance.find((item) => item.id === wanted);
	if (!found) {
		const known = frame.acceptance.map((item) => item.id).join(", ");
		return { error: `No item has the id "${id}". ${known ? `Known ids: ${known}.` : "The list is empty."}` };
	}
	if (!evidence.trim()) return { error: "Say in one line what shows this item is met (the evidence)." };
	const item: AcceptanceItem = { ...found, done: true, doneBy: by, evidence: flat(evidence, ITEM_CHARS) };
	return { frame: { ...frame, acceptance: frame.acceptance.map((each) => (each === found ? item : each)) }, item };
}

export function addItem(
	frame: Frame,
	text: string,
	by: "model" | "user",
): { frame: Frame; item: AcceptanceItem } | { error: string } {
	const words = flat(text, ITEM_CHARS);
	if (!words) return { error: "Say what has to be true (the text of the item)." };
	const same = frame.acceptance.find((item) => item.text === words);
	if (same) return { error: `That is already on the list as ${same.id}.` };
	const item: AcceptanceItem = { id: `a${frame.nextItem}`, text: words, done: false, addedBy: by };
	return { frame: { ...frame, acceptance: [...frame.acceptance, item], nextItem: frame.nextItem + 1 }, item };
}

export function openItems(frame: Frame | undefined): readonly AcceptanceItem[] {
	return (frame?.acceptance ?? []).filter((item) => !item.done);
}

/**
 * True while the frame is known to be behind the conversation. A message
 * nobody could judge does not count: that is how the harness always ran
 * before it had a frame, and a decision left in shadow must not switch off
 * the filters of one that is active.
 */
export function isStale(state: FrameState): boolean {
	return state.unmerged.some((said) => said.reason !== "unjudged");
}

/**
 * `{goal, constraints, currentSubgoal}` for the judges. What the frame has not
 * merged yet is shown the way the rules would merge it, so consumers get the
 * last valid version plus the raw new message, never the new message alone.
 */
export function compactFrame(state: FrameState): TaskFrame | undefined {
	if (!state.frame) return undefined;
	let view = state.frame;
	let latest: string | undefined;
	for (const said of state.unmerged) {
		if (said.reason === "failed" && (said.change || said.limit)) view = ruleUpdate(view, said);
		else latest = said.text;
	}
	const goal = flat(view.goal, 300);
	const subgoal = [view.currentSubgoal, latest]
		.flatMap((text) => (text ? [flat(text, 200)] : []))
		.filter((text) => text !== goal)
		.join("\n");
	const constraints = view.constraints.slice(-12).map((constraint) => flat(constraint.text, 200));
	return {
		goal,
		...(constraints.length > 0 ? { constraints } : {}),
		currentSubgoal: subgoal || undefined,
	};
}

function where(source: FrameSource): string {
	return source.entryId ? `turn ${source.turn}, entry ${source.entryId}` : `turn ${source.turn}`;
}

/** The note the main model gets when the version changes. Short: it rides along with a user message. */
export function renderFrameNote(state: FrameState): string {
	const frame = state.frame;
	if (!frame) return "";
	const lines = [`[mu task frame v${frame.version}]`, `Goal: ${frame.goal}`];
	if (frame.constraints.length > 0) {
		lines.push("Hard constraints, in the user's own words. They outrank earlier plans:");
		for (const constraint of frame.constraints) {
			lines.push(
				`- "${constraint.text}"${constraint.partial ? " … (cut; see the full message)" : ""} (turn ${constraint.source.turn})`,
			);
		}
	}
	if (frame.currentSubgoal) lines.push(`Current subgoal: ${frame.currentSubgoal}`);
	if (frame.acceptance.length > 0) {
		lines.push("Acceptance, tick each with the todo tool once it is met:");
		for (const item of frame.acceptance) lines.push(`- [${item.done ? "x" : " "}] ${item.id} ${item.text}`);
	}
	if (frame.openQuestions.length > 0) {
		lines.push("Open questions, ask the user when one blocks the work:");
		for (const question of frame.openQuestions) lines.push(`- ${question}`);
	}
	const failed = state.unmerged.filter((said) => said.reason === "failed");
	if (failed.length > 0) {
		lines.push("Said since and not merged into the frame yet:");
		for (const said of failed) lines.push(`- "${flat(said.text, 300)}" (turn ${said.turn})`);
	}
	return lines.join("\n");
}

/** Everything about the frame, for `/frame`. */
export function describeFrame(state: FrameState): string {
	const frame = state.frame;
	if (!frame) return "No task frame yet. mu creates one from the session's first message.";
	const by = frame.change ? `${frame.source}, ${frame.change}` : frame.source;
	const stale = isStale(state)
		? " · STALE: later messages aren't merged yet, so goal-based filters are holding back"
		: "";
	const lines = [`task frame v${frame.version} · updated at turn ${frame.updatedTurn} · ${by}${stale}`];
	lines.push(`goal: ${frame.goal}`);
	lines.push(frame.constraints.length > 0 ? "constraints:" : "constraints: none");
	const displayed = new Set<string>();
	for (const constraint of frame.constraints) {
		if (displayed.has(constraint.text)) continue;
		displayed.add(constraint.text);
		lines.push(
			`  ${constraintId(constraint.text)} "${constraint.text}"${constraint.partial ? " … (cut)" : ""} (${where(constraint.source)})`,
		);
	}
	lines.push(`subgoal: ${frame.currentSubgoal ?? "none"}`);
	const done = frame.acceptance.filter((item) => item.done).length;
	lines.push(
		frame.acceptance.length > 0 ? `acceptance: ${done}/${frame.acceptance.length} done` : "acceptance: none yet",
	);
	for (const item of frame.acceptance) {
		const proof = item.done ? ` · ${item.evidence ?? "no evidence given"} (${item.doneBy ?? "?"})` : "";
		lines.push(`  [${item.done ? "x" : " "}] ${item.id} ${item.text}${proof}`);
	}
	lines.push(frame.openQuestions.length > 0 ? "open questions:" : "open questions: none");
	for (const question of frame.openQuestions) lines.push(`  - ${question}`);
	if (state.unmerged.length > 0) {
		lines.push("said since, not in the frame:");
		for (const said of state.unmerged) {
			const what =
				said.reason === "failed" ? "update failed" : said.reason === "late" ? "update in progress" : "not judged";
			const verdict = [said.change, said.limit && `limit: ${said.limit.kind}`].filter(Boolean).join(", ");
			lines.push(`  - (turn ${said.turn}, ${verdict || "unclassified"}, ${what}) "${flat(said.text, 200)}"`);
		}
	}
	return lines.join("\n");
}

/**
 * Fills in the entry id of a user message once it is in the session. A
 * constraint is a piece of that message, which is how it is recognized.
 */
export function withEntryId(state: FrameState, said: { turn: number; text: string; entryId: string }): FrameState {
	const from = (source: FrameSource, text: string) =>
		source.entryId === undefined && source.turn === said.turn && said.text.includes(text);
	const frame = state.frame && {
		...state.frame,
		constraints: state.frame.constraints.map((constraint) =>
			from(constraint.source, constraint.text)
				? { ...constraint, source: { ...constraint.source, entryId: said.entryId } }
				: constraint,
		),
	};
	const unmerged = state.unmerged.map((each) =>
		each.entryId === undefined && each.turn === said.turn && each.text === said.text
			? { ...each, entryId: said.entryId }
			: each,
	);
	return { frame, unmerged };
}

/** What one `kyrn.frame` session entry holds. */
export interface FrameEntryData {
	readonly schema: 2;
	readonly reason: "created" | "updated" | "progress" | "stale";
	readonly frame: Frame;
	readonly unmerged: readonly UnmergedText[];
}

export function frameEntry(state: FrameState, reason: FrameEntryData["reason"]): FrameEntryData | undefined {
	if (!state.frame) return undefined;
	// An update that is still running is not a fact about the session; only what failed is worth remembering.
	return {
		schema: 2,
		reason,
		frame: state.frame,
		unmerged: state.unmerged
			.filter((said) => said.reason === "failed")
			.map((said) => (said.limit?.kind === "allow_once" ? { ...said, limit: { kind: "none" } } : said)),
	};
}

const isText = (value: unknown): value is string => typeof value === "string";
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const CHANGES: readonly string[] = ["new_task", "constraint", "correction", "subgoal", "unclear"];

function isLimitIntent(value: unknown): value is LimitIntent {
	if (!isRecord(value)) return false;
	if (value.kind === "none" || value.kind === "add" || value.kind === "unclear") return true;
	return (
		(value.kind === "withdraw" || value.kind === "replace") && isText(value.id) && /^[a-f0-9]{64}$/.test(value.id)
	);
}

function isSource(value: unknown): value is FrameSource {
	return isRecord(value) && isCount(value.turn) && (value.entryId === undefined || isText(value.entryId));
}

function isFrame(value: unknown): value is Frame {
	if (!isRecord(value)) return false;
	return (
		isCount(value.version) &&
		value.version >= 1 &&
		isText(value.goal) &&
		Array.isArray(value.constraints) &&
		value.constraints.every((each) => isRecord(each) && isText(each.text) && isSource(each.source)) &&
		(value.currentSubgoal === undefined || isText(value.currentSubgoal)) &&
		Array.isArray(value.acceptance) &&
		value.acceptance.every(
			(each) => isRecord(each) && isText(each.id) && isText(each.text) && typeof each.done === "boolean",
		) &&
		Array.isArray(value.openQuestions) &&
		value.openQuestions.every(isText) &&
		isCount(value.updatedTurn) &&
		isCount(value.nextItem)
	);
}

/** A stored entry, or undefined when it is not one this code wrote: a broken entry must not become the frame. */
export function parseFrameEntry(data: unknown): FrameState | undefined {
	// V1 has no independent limit verdicts. Its active constraints stand; a pending
	// correction from that version cannot by itself authorize another one.
	if (!isRecord(data) || (data.schema !== 1 && data.schema !== 2) || !isFrame(data.frame)) return undefined;
	const unmerged = Array.isArray(data.unmerged) ? data.unmerged : [];
	const valid = unmerged.filter(
		(each): each is UnmergedText =>
			isRecord(each) &&
			isText(each.text) &&
			isCount(each.turn) &&
			each.reason === "failed" &&
			(each.limit === undefined || (data.schema === 2 && isLimitIntent(each.limit))) &&
			(each.withdrawnQuoteIds === undefined ||
				(Array.isArray(each.withdrawnQuoteIds) &&
					each.withdrawnQuoteIds.every((id) => isText(id) && /^[a-f0-9]{64}$/.test(id)))) &&
			(each.change === undefined || (isText(each.change) && CHANGES.includes(each.change))),
	);
	// A v1 constraint verdict also caught one-time actions. Recover only an unmistakable rule;
	// leave other failed messages visible as unresolved, with their original provenance.
	const unmergedText =
		data.schema === 1
			? valid.map(
					(said): UnmergedText =>
						said.change === "constraint" && explicitLimit(said.text.trim())
							? { ...said, change: undefined, limit: { kind: "add" } }
							: said,
				)
			: valid;
	return { frame: data.frame, unmerged: unmergedText };
}
