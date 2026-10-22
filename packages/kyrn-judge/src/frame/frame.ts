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
export type FrameChange = "new_task" | "constraint" | "correction" | "subgoal" | "unclear";

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
	/** The rule path cut an over-long message: `text` is its beginning, the entry holds the rest. */
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
/** A constraint is verbatim, so this is a cut, not a summary; the entry id leads to the whole message. */
const CONSTRAINT_CHARS = 1000;
export const MAX_OPEN_QUESTIONS = 8;
export const MAX_ACCEPTANCE = 12;

export function flat(text: string, length: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length <= length ? line : `${line.slice(0, length - 1)}…`;
}

function sourceOf(text: UserText): FrameSource {
	return text.entryId ? { turn: text.turn, entryId: text.entryId } : { turn: text.turn };
}

/** The user's message as a constraint, whole unless it is very long. */
export function verbatimConstraint(text: UserText): Constraint {
	const words = text.text.trim();
	if (words.length <= CONSTRAINT_CHARS) return { text: words, source: sourceOf(text) };
	return { text: words.slice(0, CONSTRAINT_CHARS), source: sourceOf(text), partial: true };
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
		const text = raw.trim().slice(0, CONSTRAINT_CHARS);
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

/**
 * The update when no model can write one. It never rephrases: a constraint or
 * a correction is kept word for word, and a message whose effect is unclear
 * becomes an open question instead of replacing the goal.
 */
export function ruleUpdate(frame: Frame, said: UserText): Frame {
	const next = {
		...frame,
		version: frame.version + 1,
		updatedTurn: said.turn,
		source: "rules" as const,
		change: said.change,
	};
	if (said.change === "new_task") {
		// Constraints stay: which of them only concerned the old task is not something a rule can tell.
		return {
			...next,
			goal: flat(said.text, GOAL_CHARS),
			currentSubgoal: undefined,
			acceptance: [],
			openQuestions: [],
		};
	}
	if (said.change === "constraint" || said.change === "correction") {
		const added = verbatimConstraint(said);
		if (frame.constraints.some((constraint) => constraint.text === added.text)) return next;
		return { ...next, constraints: [...frame.constraints, added] };
	}
	if (said.change === "subgoal") return { ...next, currentSubgoal: flat(said.text, SUBGOAL_CHARS) };
	const question = unclearChange(flat(said.text, 200));
	return { ...next, openQuestions: [...frame.openQuestions, question].slice(-MAX_OPEN_QUESTIONS) };
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
		if (said.reason === "failed" && said.change) view = ruleUpdate(view, said);
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
	frame.constraints.forEach((constraint, index) => {
		lines.push(
			`  ${index + 1}. "${constraint.text}"${constraint.partial ? " … (cut)" : ""} (${where(constraint.source)})`,
		);
	});
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
			lines.push(`  - (turn ${said.turn}, ${said.change ?? "unclassified"}, ${what}) "${flat(said.text, 200)}"`);
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
	readonly schema: 1;
	readonly reason: "created" | "updated" | "progress" | "stale";
	readonly frame: Frame;
	readonly unmerged: readonly UnmergedText[];
}

export function frameEntry(state: FrameState, reason: FrameEntryData["reason"]): FrameEntryData | undefined {
	if (!state.frame) return undefined;
	// An update that is still running is not a fact about the session; only what failed is worth remembering.
	return {
		schema: 1,
		reason,
		frame: state.frame,
		unmerged: state.unmerged.filter((said) => said.reason === "failed"),
	};
}

const isText = (value: unknown): value is string => typeof value === "string";
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const CHANGES: readonly string[] = ["new_task", "constraint", "correction", "subgoal", "unclear"];

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
	if (!isRecord(data) || data.schema !== 1 || !isFrame(data.frame)) return undefined;
	const unmerged = Array.isArray(data.unmerged) ? data.unmerged : [];
	const valid = unmerged.filter(
		(each): each is UnmergedText =>
			isRecord(each) &&
			isText(each.text) &&
			isCount(each.turn) &&
			each.reason === "failed" &&
			(each.change === undefined || (isText(each.change) && CHANGES.includes(each.change))),
	);
	return { frame: data.frame, unmerged: valid };
}
