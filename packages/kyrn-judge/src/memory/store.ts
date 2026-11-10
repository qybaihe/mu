import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname } from "node:path";
import type { Lesson, LessonText } from "../decisions/memory.ts";

/**
 * The experience library on disk: `<agentDir>/mu/lessons.jsonl`, one JSON object per line, only ever
 * appended to. A line is a whole lesson or only the fields that changed (`{ id, status: "retired" }`,
 * `{ id, uses }`); reading folds the lines of one id in order, later fields over earlier ones. A line
 * that does not parse is skipped, and a malformed field is dropped without the rest of its line.
 *
 * Lines of the first version (`{ id, trigger, lesson, cwd?, created }`) read as active corrections.
 */
export type LessonKind = "correction" | "preference" | "pitfall" | "workaround" | "fact";
export type LessonOrigin = "user" | "outcome" | "model" | "subagent" | "command";
export type LessonStatus = "active" | "retired" | "superseded";

const KINDS: readonly LessonKind[] = ["correction", "preference", "pitfall", "workaround", "fact"];
const ORIGINS: readonly LessonOrigin[] = ["user", "outcome", "model", "subagent", "command"];
const STATUSES: readonly LessonStatus[] = ["active", "retired", "superseded"];

export interface LessonUses {
	readonly recalled: number;
	readonly applied: number;
	readonly lastRecalled?: string;
}

export interface LessonScope {
	/** The project the lesson belongs to. Undefined: it applies everywhere. */
	readonly cwd?: string;
}

export interface LessonSource {
	readonly origin: LessonOrigin;
	readonly session?: string;
	readonly turn?: number;
}

export interface StoredLesson extends Lesson {
	readonly kind: LessonKind;
	readonly scope: LessonScope;
	readonly source: LessonSource;
	readonly status: LessonStatus;
	/** The lesson this one replaced. */
	readonly supersedes?: string;
	/**
	 * A standing rule: the user's own word that recalling was not enough for (they had to say it again, or it was
	 * recalled and never followed). The constraint gate holds calls that change something against it.
	 */
	readonly standing?: true;
	readonly uses: LessonUses;
	readonly created: string;
	/** When it was written, confirmed again or changed status. Use accounting does not touch it. */
	readonly updated: string;
}

/** One line of the file: a whole lesson, or the fields of one that changed. `standing: false` takes a rule's standing away. */
export type LessonLine = { readonly id: string } & Partial<Omit<StoredLesson, "id" | "standing">> & {
		readonly standing?: boolean;
	};

/** The well-formed fields of one line. `cwd` is where the first version kept the project. */
interface Draft {
	id: string;
	trigger?: string;
	lesson?: string;
	kind?: LessonKind;
	scope?: LessonScope;
	cwd?: string;
	source?: LessonSource;
	status?: LessonStatus;
	supersedes?: string;
	standing?: boolean;
	uses?: LessonUses;
	created?: string;
	updated?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const oneOf = <T extends string>(options: readonly T[], value: unknown): T | undefined =>
	options.find((option) => option === value);

function draftOf(value: unknown): Draft | undefined {
	if (!isRecord(value) || !isText(value.id)) return undefined;
	const draft: Draft = { id: value.id };
	if (isText(value.trigger)) draft.trigger = value.trigger;
	if (isText(value.lesson)) draft.lesson = value.lesson;
	const kind = oneOf(KINDS, value.kind);
	if (kind) draft.kind = kind;
	const status = oneOf(STATUSES, value.status);
	if (status) draft.status = status;
	if (isRecord(value.scope)) draft.scope = isText(value.scope.cwd) ? { cwd: value.scope.cwd } : {};
	if (isText(value.cwd)) draft.cwd = value.cwd;
	if (isRecord(value.source)) {
		const origin = oneOf(ORIGINS, value.source.origin);
		if (origin) {
			draft.source = {
				origin,
				...(isText(value.source.session) ? { session: value.source.session } : {}),
				...(isCount(value.source.turn) ? { turn: value.source.turn } : {}),
			};
		}
	}
	if (isText(value.supersedes)) draft.supersedes = value.supersedes;
	if (typeof value.standing === "boolean") draft.standing = value.standing;
	if (isRecord(value.uses) && isCount(value.uses.recalled) && isCount(value.uses.applied)) {
		draft.uses = {
			recalled: value.uses.recalled,
			applied: value.uses.applied,
			...(isText(value.uses.lastRecalled) ? { lastRecalled: value.uses.lastRecalled } : {}),
		};
	}
	if (isText(value.created)) draft.created = value.created;
	if (isText(value.updated)) draft.updated = value.updated;
	return draft;
}

function complete(draft: Draft): StoredLesson | undefined {
	if (draft.trigger === undefined || draft.lesson === undefined) return undefined;
	const created = draft.created ?? draft.updated ?? new Date(0).toISOString();
	const cwd = draft.scope ? draft.scope.cwd : draft.cwd;
	return {
		id: draft.id,
		kind: draft.kind ?? "correction",
		trigger: draft.trigger,
		lesson: draft.lesson,
		scope: cwd === undefined ? {} : { cwd },
		source: draft.source ?? { origin: "user" },
		status: draft.status ?? "active",
		...(draft.supersedes ? { supersedes: draft.supersedes } : {}),
		...(draft.standing ? { standing: true as const } : {}),
		uses: draft.uses ?? { recalled: 0, applied: 0 },
		created,
		updated: draft.updated ?? created,
	};
}

function foldInto(drafts: Map<string, Draft>, line: unknown): void {
	const draft = draftOf(line);
	if (!draft) return;
	const earlier = drafts.get(draft.id);
	// Setting a key that is there keeps its place: lessons stay in the order they were first written.
	drafts.set(draft.id, earlier ? { ...earlier, ...draft } : draft);
}

function completeAll(drafts: ReadonlyMap<string, Draft>): StoredLesson[] {
	const lessons: StoredLesson[] = [];
	for (const draft of drafts.values()) {
		const lesson = complete(draft);
		if (lesson) lessons.push(lesson);
	}
	return lessons;
}

/** One line of text as JSON; undefined for a blank or corrupt one, which must not cost the rest of the store. */
function parseLine(text: string): unknown {
	if (!text.trim()) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * Parsed lines, folded by id: later fields over earlier ones, in the order each id first appeared.
 * An id whose folded fields still lack a trigger or a lesson (a tombstone for a lesson that is not
 * there) is left out.
 */
export function foldLessons(lines: readonly unknown[]): StoredLesson[] {
	const drafts = new Map<string, Draft>();
	for (const line of lines) foldInto(drafts, line);
	return completeAll(drafts);
}

/** Every lesson in the file, folded. A missing or unreadable file holds none. */
export function readLessons(path: string): StoredLesson[] {
	let text = "";
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	return foldLessons(text.split("\n").map(parseLine));
}

/** True when the file has content that does not end with a newline: whatever is appended would join its last line. */
function endsOpen(path: string): boolean {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const { size } = fstatSync(fd);
		if (size === 0) return false;
		const last = Buffer.alloc(1);
		readSync(fd, last, 0, 1, size - 1);
		return last[0] !== 0x0a;
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Appends one line. A file someone left without a final newline gets one first, so no two lines run together. */
export function writeLesson(path: string, line: LessonLine): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${endsOpen(path) ? "\n" : ""}${JSON.stringify(line)}\n`);
}

/**
 * The file, or the session's memory when there is no file to keep (a caller that owns the setup and
 * named no home). Recall reads the store on every message and every recall appends a line, so the
 * file is read the way it grows: only what was appended since the last read is parsed and folded in.
 * A file that was replaced or got shorter is read again from the start.
 */
export class LessonStore {
	readonly path: string | undefined;
	private readonly memory: LessonLine[] = [];
	private offset = 0;
	private inode = -1;
	private mtimeMs = -1;
	/** Bytes after the last newline read: a line still being written, or a last line without its newline. */
	private tail: Buffer = Buffer.alloc(0);
	private readonly drafts = new Map<string, Draft>();
	private lessons: StoredLesson[] = [];

	constructor(path: string | undefined) {
		this.path = path;
	}

	private restart(): void {
		this.offset = 0;
		this.inode = -1;
		this.mtimeMs = -1;
		this.tail = Buffer.alloc(0);
		this.drafts.clear();
		this.lessons = [];
	}

	all(): readonly StoredLesson[] {
		if (!this.path) return foldLessons(this.memory);
		let fd: number | undefined;
		try {
			fd = openSync(this.path, "r");
			const stat = fstatSync(fd);
			if (stat.ino === this.inode && stat.size === this.offset && stat.mtimeMs === this.mtimeMs) return this.lessons;
			if (stat.ino !== this.inode || stat.size <= this.offset) this.restart();
			this.inode = stat.ino;
			this.mtimeMs = stat.mtimeMs;
			const fresh = Buffer.alloc(stat.size - this.offset);
			let read = 0;
			while (read < fresh.length) {
				const count = readSync(fd, fresh, read, fresh.length - read, this.offset + read);
				if (count === 0) break;
				read += count;
			}
			this.offset += read;
			// A newline byte never occurs inside a multi-byte character, so splitting at it is safe for any text.
			const chunk = Buffer.concat([this.tail, fresh.subarray(0, read)]);
			const end = chunk.lastIndexOf(0x0a);
			this.tail = Buffer.from(end < 0 ? chunk : chunk.subarray(end + 1));
			const lines = end < 0 ? [] : chunk.subarray(0, end).toString("utf8").split("\n");
			// A last line without its newline counts now; read again once the newline comes, it changes nothing.
			if (this.tail.length > 0) lines.push(this.tail.toString("utf8"));
			for (const line of lines) foldInto(this.drafts, parseLine(line));
			this.lessons = completeAll(this.drafts);
			return this.lessons;
		} catch {
			this.restart();
			return [];
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}

	get(id: string): StoredLesson | undefined {
		return this.all().find((lesson) => lesson.id === id);
	}

	write(line: LessonLine): void {
		if (this.path) writeLesson(this.path, line);
		else this.memory.push(line);
	}
}

/** Whether a lesson is the user's own word (a correction, a rule, `/remember`), not something the agent concluded. */
export function isUsersWord(lesson: Pick<StoredLesson, "source">): boolean {
	return lesson.source.origin === "user" || lesson.source.origin === "command";
}

/** The standing rules that hold in `cwd`, the most recently confirmed first. */
export function standingRules(lessons: readonly StoredLesson[], cwd: string): StoredLesson[] {
	return lessons
		.filter((lesson) => lesson.status === "active" && lesson.standing === true && inScope(lesson, cwd))
		.sort((a, b) => b.updated.localeCompare(a.updated));
}

/** Lessons that apply in `cwd`: its own, and those that apply everywhere. */
export function inScope(lesson: StoredLesson, cwd: string): boolean {
	return lesson.scope.cwd === undefined || lesson.scope.cwd === cwd;
}

/**
 * Recall's candidates: the active lessons of this project, the ones followed most often first, then
 * the ones written or confirmed most recently.
 */
export function rankForRecall(lessons: readonly StoredLesson[], cwd: string, limit: number): StoredLesson[] {
	return lessons
		.filter((lesson) => lesson.status === "active" && inScope(lesson, cwd))
		.sort((a, b) => b.uses.applied - a.uses.applied || b.updated.localeCompare(a.updated))
		.slice(0, limit);
}

/** Words that say nothing about what a lesson is about. */
const FILLER = new Set([
	"the",
	"and",
	"for",
	"with",
	"when",
	"this",
	"that",
	"from",
	"into",
	"are",
	"was",
	"were",
	"you",
	"your",
	"its",
	"has",
	"have",
	"will",
	"then",
	"than",
	"there",
	"which",
	"what",
	"should",
	"would",
	"could",
	"been",
	"about",
]);

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

/**
 * The terms two lessons can share: words of three letters or more, and pairs of neighbouring
 * characters in Chinese, Japanese or Korean, which are written without spaces.
 */
export function terms(text: string): Set<string> {
	const lower = text.toLowerCase();
	const found = new Set<string>();
	for (const run of lower.match(CJK) ?? []) {
		if (run.length === 1) found.add(run);
		for (let index = 0; index + 1 < run.length; index++) found.add(run.slice(index, index + 2));
	}
	for (const raw of lower.replace(CJK, " ").match(/[\p{L}\p{N}_./-]+/gu) ?? []) {
		const word = raw.replace(/^[._/-]+|[._/-]+$/g, "");
		if (word.length >= 3 && !FILLER.has(word)) found.add(word);
	}
	return found;
}

const lessonTerms = (lesson: LessonText) => terms(`${lesson.trigger} ${lesson.lesson}`);

/**
 * The active lessons of this project a new one is held against before it is stored: those it shares
 * the most terms with, relative to the shorter of the two, and at least one. A rule, no judge.
 */
export function neighbours(
	candidate: LessonText,
	lessons: readonly StoredLesson[],
	cwd: string,
	limit: number,
): StoredLesson[] {
	const mine = lessonTerms(candidate);
	if (mine.size === 0 || limit <= 0) return [];
	const scored: { lesson: StoredLesson; overlap: number }[] = [];
	for (const lesson of lessons) {
		if (lesson.status !== "active" || !inScope(lesson, cwd)) continue;
		const theirs = lessonTerms(lesson);
		let shared = 0;
		for (const term of mine) if (theirs.has(term)) shared++;
		if (shared > 0) scored.push({ lesson, overlap: shared / Math.min(mine.size, theirs.size) });
	}
	return scored
		.sort((a, b) => b.overlap - a.overlap)
		.slice(0, limit)
		.map((entry) => entry.lesson);
}

/** Word for word the same, whatever the spacing and case. */
export function sameText(a: string, b: string): boolean {
	const plain = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
	return plain(a) === plain(b);
}
