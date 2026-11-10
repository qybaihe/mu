// What mu has observed about how this user and this machine work, and the adaptations the user accepted.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { type PermissionMode, parseMode } from "../permissions/modes.ts";

/**
 * The evolution store on disk: `<agentDir>/mu/evolve.jsonl`, one JSON object per line, only ever appended to, as the
 * lessons are. Observations are facts mu saw (an answer to an approval question, the files a session opened with, a
 * program that was missing, how long the user stayed away, what a run took of them). An adaptation is a change to how mu behaves that the user
 * accepted; its lines fold by `id`, the last one holding, so undoing one appends a line.
 *
 * Nothing here holds a command, a message or a file's contents: paths of the project, program names, the first words
 * of a command the user allowed (`npm test`) and numbers only.
 * It is the user's file, in their agent folder: a project cannot write it, and no tool the model has does.
 */
export type EvolveRow = ApprovalRow | OpeningRow | CommandRow | GapRow | RunRow | GrantRow | AdaptationRow;

/** The user's answer to a call the approval judge read as needed, but not surely enough to let it run. */
export interface ApprovalRow {
	readonly type: "approval";
	readonly cwd: string;
	readonly at: string;
	/** The probability the judge gave "needed". */
	readonly probability: number;
	/** The call was a check in the project (`isCheckChain`), which has a lower line of its own. */
	readonly check: boolean;
	readonly answer: "once" | "session" | "deny";
	/** How long the question waited: an answer within a second was hardly read. */
	readonly waitedMs: number;
}

/** The files a session read in its first steps, relative to the project: what the next opening may bring along. */
export interface OpeningRow {
	readonly type: "opening";
	readonly cwd: string;
	readonly at: string;
	readonly paths: readonly string[];
}

/** A program that was not found on this machine, and the one that then did the same job. */
export interface CommandRow {
	readonly type: "command";
	readonly at: string;
	readonly missing: string;
	readonly instead: string;
}

/** How long the user took to send the next message after a run ended. */
export interface GapRow {
	readonly type: "gap";
	readonly cwd: string;
	readonly at: string;
	readonly gapMs: number;
}

/**
 * How a question put to the user ended. `same`: what followed is what would have happened unasked (they allowed the
 * call; they picked the option the model had put first, or skipped the question). `changed`: anything else they
 * answered. `unanswered`: nobody answered in time, so it took nothing of them.
 */
export type AskedEnd = "same" | "changed" | "unanswered";

/** What a run took of the user, in counts: the questions put to them while it went and the messages they sent into it. */
export interface RunCounts {
	/** Permission questions the user dealt with, and how many of those ended `same`. */
	readonly permissions: number;
	readonly permissionsSame: number;
	/** Questions of ask_user the user dealt with, and how many of those ended `same`. */
	readonly questions: number;
	readonly questionsSame: number;
	/** Questions of either kind that ended `unanswered`. */
	readonly unanswered: number;
	/** Messages the user sent while the run was going. */
	readonly messages: number;
}

/** One run a message of the user's started, when it had settled: what it took of them, and whether they stopped it. */
export interface RunRow extends RunCounts {
	readonly type: "run";
	readonly cwd: string;
	readonly at: string;
	readonly stopped: boolean;
}

/**
 * The user's answer to a permission question about a command, when the question offered "for this session": that
 * answer, or a refusal. "Once" is not kept: it says the user wants to see each such call.
 */
export interface GrantRow {
	readonly type: "grant";
	readonly cwd: string;
	readonly at: string;
	/** What the answer covers, as the permission gate keys it (`shell:npm test`) and as the user reads it (`npm test`). */
	readonly key: string;
	readonly label: string;
	/** The permission mode the question was asked in. */
	readonly mode: PermissionMode;
	readonly answer: "session" | "deny";
}

interface AdaptationBase {
	readonly type: "adaptation";
	readonly id: string;
	readonly cwd: string;
	readonly at: string;
	readonly status: "active" | "undone";
}

/** How sure the approval judge has to be in this project, in place of the built-in line. */
export interface LineAdaptation extends AdaptationBase {
	readonly kind: "approval-line";
	readonly value: number;
	/** What it was accepted on, in numbers, for the listing. */
	readonly evidence: { readonly allowed: number; readonly considered: number; readonly from: number };
}

/**
 * A command the permission gate lets run in this project without asking, as "for this session" does within a session.
 * It holds in the permission mode it was accepted in, and not for a call a rule flags or one that touches mu's settings.
 */
export interface GrantAdaptation extends AdaptationBase {
	readonly kind: "grant";
	readonly key: string;
	readonly label: string;
	readonly mode: PermissionMode;
	/** How many times in a row the user had allowed it for the session when they accepted. */
	readonly sessions: number;
}

export type AdaptationRow = LineAdaptation | GrantAdaptation;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
/** A count as a line holds it; 0 for one that is missing or is no count. */
const countOf = (value: unknown): number => (isNumber(value) && value > 0 ? Math.floor(value) : 0);

/** One parsed line as a row; undefined for anything malformed, which must not cost the rest of the file. */
export function rowOf(value: unknown): EvolveRow | undefined {
	if (!isRecord(value) || !isText(value.at)) return undefined;
	const at = value.at;
	if (value.type === "approval") {
		const answer = value.answer;
		if (!isText(value.cwd) || !isNumber(value.probability) || !isNumber(value.waitedMs)) return undefined;
		if (answer !== "once" && answer !== "session" && answer !== "deny") return undefined;
		return {
			type: "approval",
			cwd: value.cwd,
			at,
			probability: value.probability,
			check: value.check === true,
			answer,
			waitedMs: value.waitedMs,
		};
	}
	if (value.type === "opening") {
		if (!isText(value.cwd) || !Array.isArray(value.paths)) return undefined;
		return { type: "opening", cwd: value.cwd, at, paths: value.paths.filter(isText) };
	}
	if (value.type === "command") {
		if (!isText(value.missing) || !isText(value.instead)) return undefined;
		return { type: "command", at, missing: value.missing, instead: value.instead };
	}
	if (value.type === "gap") {
		if (!isText(value.cwd) || !isNumber(value.gapMs) || value.gapMs < 0) return undefined;
		return { type: "gap", cwd: value.cwd, at, gapMs: value.gapMs };
	}
	if (value.type === "run") {
		if (!isText(value.cwd)) return undefined;
		return {
			type: "run",
			cwd: value.cwd,
			at,
			permissions: countOf(value.permissions),
			permissionsSame: countOf(value.permissionsSame),
			questions: countOf(value.questions),
			questionsSame: countOf(value.questionsSame),
			unanswered: countOf(value.unanswered),
			messages: countOf(value.messages),
			stopped: value.stopped === true,
		};
	}
	if (value.type === "grant") {
		const mode = parseMode(value.mode);
		if (!isText(value.cwd) || !isText(value.key) || !isText(value.label) || !mode) return undefined;
		if (value.answer !== "session" && value.answer !== "deny") return undefined;
		return { type: "grant", cwd: value.cwd, at, key: value.key, label: value.label, mode, answer: value.answer };
	}
	if (value.type === "adaptation") {
		if (!isText(value.id) || !isText(value.cwd)) return undefined;
		const status = value.status;
		if (status !== "active" && status !== "undone") return undefined;
		const base: AdaptationBase = { type: "adaptation", id: value.id, cwd: value.cwd, at, status };
		if (value.kind === "grant") {
			const mode = parseMode(value.mode);
			if (!isText(value.key) || !isText(value.label) || !mode) return undefined;
			return {
				...base,
				kind: "grant",
				key: value.key,
				label: value.label,
				mode,
				sessions: countOf(value.sessions),
			};
		}
		if (value.kind !== "approval-line" || !isNumber(value.value)) return undefined;
		const evidence = value.evidence;
		return {
			...base,
			kind: "approval-line",
			value: value.value,
			evidence: {
				allowed: isRecord(evidence) && isNumber(evidence.allowed) ? evidence.allowed : 0,
				considered: isRecord(evidence) && isNumber(evidence.considered) ? evidence.considered : 0,
				from: isRecord(evidence) && isNumber(evidence.from) ? evidence.from : 0,
			},
		};
	}
	return undefined;
}

function parseLine(text: string): EvolveRow | undefined {
	if (!text.trim()) return undefined;
	try {
		return rowOf(JSON.parse(text));
	} catch {
		return undefined;
	}
}

/**
 * The file, or the session's memory when there is no file to keep (a caller that owns the setup and named no home).
 * Read whole on each use: it is asked a few times a session and grows by a line per observation.
 */
export class EvolveStore {
	readonly path: string | undefined;
	private readonly memory: EvolveRow[] = [];

	constructor(path: string | undefined) {
		this.path = path;
	}

	rows(): readonly EvolveRow[] {
		if (!this.path) return this.memory;
		try {
			return readFileSync(this.path, "utf8")
				.split("\n")
				.flatMap((line) => parseLine(line) ?? []);
		} catch {
			return [];
		}
	}

	append(row: EvolveRow): void {
		if (!this.path) {
			this.memory.push(row);
			return;
		}
		mkdirSync(dirname(this.path), { recursive: true });
		appendFileSync(this.path, `${JSON.stringify(row)}\n`);
	}
}

/** The adaptations as they stand: the last line of each id, in the order the ids first appeared. */
export function adaptations(rows: readonly EvolveRow[]): AdaptationRow[] {
	const latest = new Map<string, AdaptationRow>();
	for (const row of rows) if (row.type === "adaptation") latest.set(row.id, row);
	return [...latest.values()];
}

/** The adaptations of one kind in force in a project: accepted and not undone, oldest first. */
export function activeAdaptations<Kind extends AdaptationRow["kind"]>(
	rows: readonly EvolveRow[],
	kind: Kind,
	cwd: string,
): Extract<AdaptationRow, { kind: Kind }>[] {
	return adaptations(rows).filter(
		(row): row is Extract<AdaptationRow, { kind: Kind }> =>
			row.kind === kind && row.cwd === cwd && row.status === "active",
	);
}

/** The latest adaptation of one kind in force in a project, for a kind a project has one of. */
export function activeAdaptation<Kind extends AdaptationRow["kind"]>(
	rows: readonly EvolveRow[],
	kind: Kind,
	cwd: string,
): Extract<AdaptationRow, { kind: Kind }> | undefined {
	return activeAdaptations(rows, kind, cwd).pop();
}

/** A command the user keeps allowing for the session in a project: what a standing grant would cover. */
export interface GrantSuggestion {
	readonly key: string;
	readonly label: string;
	readonly mode: PermissionMode;
	/** How many times in a row, up to the latest answer, the user allowed it for the session. */
	readonly sessions: number;
}

/**
 * The commands of a project that could be granted for good, in one permission mode: the latest `least` answers about
 * each were all "for this session", and no grant in force covers it yet. One refusal starts the count again.
 */
export function grantSuggestions(
	rows: readonly EvolveRow[],
	cwd: string,
	mode: PermissionMode,
	least: number,
): GrantSuggestion[] {
	const inForce = new Set(
		activeAdaptations(rows, "grant", cwd)
			.filter((grant) => grant.mode === mode)
			.map((grant) => grant.key),
	);
	const runs = new Map<string, GrantSuggestion>();
	for (const row of rows) {
		if (row.type !== "grant" || row.cwd !== cwd || row.mode !== mode) continue;
		const sessions = row.answer === "session" ? (runs.get(row.key)?.sessions ?? 0) + 1 : 0;
		runs.set(row.key, { key: row.key, label: row.label, mode, sessions });
	}
	return [...runs.values()].filter((run) => run.sessions >= least && !inForce.has(run.key));
}

/**
 * How often each file was among a project's opening reads, over its latest `sessions` openings: the most read first.
 * A file read once in twenty openings is not worth a candidate's place, so counts of one are left out when there is
 * more than one opening to go by.
 */
export function openingReads(
	rows: readonly EvolveRow[],
	cwd: string,
	sessions = 20,
): { path: string; count: number }[] {
	const openings = rows.filter((row): row is OpeningRow => row.type === "opening" && row.cwd === cwd).slice(-sessions);
	const counts = new Map<string, number>();
	for (const opening of openings) {
		for (const path of new Set(opening.paths)) counts.set(path, (counts.get(path) ?? 0) + 1);
	}
	return [...counts.entries()]
		.filter(([, count]) => openings.length < 2 || count > 1)
		.map(([path, count]) => ({ path, count }))
		.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
}

/** Programs found missing here, each with what worked in its place the last time, and how often it was seen. */
export function missingCommands(rows: readonly EvolveRow[]): { missing: string; instead: string; seen: number }[] {
	const found = new Map<string, { missing: string; instead: string; seen: number }>();
	for (const row of rows) {
		if (row.type !== "command") continue;
		found.set(row.missing, {
			missing: row.missing,
			instead: row.instead,
			seen: (found.get(row.missing)?.seen ?? 0) + 1,
		});
	}
	return [...found.values()];
}

/** The middle of the user's gaps in a project, in milliseconds; undefined with fewer than `least` of them. */
export function medianGap(rows: readonly EvolveRow[], cwd: string, least = 5): number | undefined {
	const gaps = rows
		.filter((row): row is GapRow => row.type === "gap" && row.cwd === cwd)
		.map((row) => row.gapMs)
		.sort((a, b) => a - b);
	if (gaps.length < least) return undefined;
	const middle = Math.floor(gaps.length / 2);
	return gaps.length % 2 === 1 ? gaps[middle] : Math.round((gaps[middle - 1] + gaps[middle]) / 2);
}

/** What a project's latest runs took of the user, added up. */
export interface Attention extends RunCounts {
	readonly runs: number;
	/** Runs that took nothing: no question the user dealt with, no message from them, no stop. */
	readonly quiet: number;
	/** Runs the user stopped. */
	readonly stopped: number;
}

/** The sum over a project's latest `latest` runs; undefined with fewer than `least` of them, which say little. */
export function attention(rows: readonly EvolveRow[], cwd: string, latest = 50, least = 5): Attention | undefined {
	const runs = rows.filter((row): row is RunRow => row.type === "run" && row.cwd === cwd).slice(-latest);
	if (runs.length < least) return undefined;
	const sum = (pick: (run: RunRow) => number): number => runs.reduce((total, run) => total + pick(run), 0);
	return {
		runs: runs.length,
		quiet: sum((run) => (run.permissions + run.questions + run.messages === 0 && !run.stopped ? 1 : 0)),
		stopped: sum((run) => (run.stopped ? 1 : 0)),
		permissions: sum((run) => run.permissions),
		permissionsSame: sum((run) => run.permissionsSame),
		questions: sum((run) => run.questions),
		questionsSame: sum((run) => run.questionsSame),
		unanswered: sum((run) => run.unanswered),
		messages: sum((run) => run.messages),
	};
}

/**
 * What the other features tell the evolve feature, and what they ask it. Set on the runtime by that feature
 * (`features/evolve.ts`) while it is on; with it off, nothing is observed and nothing adapted.
 */
export interface EvolveLink {
	/** The approval line the user accepted for this project, in place of the built-in one. */
	approvalLine(cwd: string): number | undefined;
	/** The user answered an approval question about a call the judge had read as needed, not surely enough. */
	approvalAnswered(answer: Omit<ApprovalRow, "type" | "at">): void;
	/** A question put to the user ended: a permission question, or one of ask_user's. */
	asked(kind: "permission" | "question", ended: AskedEnd): void;
	/** The user answered a permission question about a command with "for this session", or refused it. */
	grantAnswered(answer: Omit<GrantRow, "type" | "at">): void;
	/** Whether the user accepted a standing grant for this command, in this project and permission mode. */
	granted(cwd: string, key: string, mode: PermissionMode): boolean;
	/** The files a session read in its opening steps, relative to the project. */
	opened(cwd: string, paths: readonly string[]): void;
	/** Files earlier openings of this project read, the most read first. */
	openingReads(cwd: string): readonly string[];
	/** Programs earlier sessions found missing on this machine, each with what worked in its place. */
	missingCommands(): readonly { missing: string; instead: string }[];
	/**
	 * The user marked a verdict of this decision as wrong (`/ledger wrong`). An adaptation that loosened the decision
	 * is undone, and what was undone comes back for the user to read.
	 */
	markedWrong(specId: string, cwd: string): string | undefined;
}
