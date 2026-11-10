// What mu has observed about how this user and this machine work, and the adaptations the user accepted.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The evolution store on disk: `<agentDir>/mu/evolve.jsonl`, one JSON object per line, only ever appended to, as the
 * lessons are. Observations are facts mu saw (an answer to an approval question, the files a session opened with, a
 * program that was missing, how long the user stayed away). An adaptation is a change to how mu behaves that the user
 * accepted; its lines fold by `id`, the last one holding, so undoing one appends a line.
 *
 * Nothing here holds a command, a message or a file's contents: paths of the project, program names and numbers only.
 * It is the user's file, in their agent folder: a project cannot write it, and no tool the model has does.
 */
export type EvolveRow = ApprovalRow | OpeningRow | CommandRow | GapRow | AdaptationRow;

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

export interface AdaptationRow {
	readonly type: "adaptation";
	readonly id: string;
	/** `approval-line`: how sure the approval judge has to be in this project, in place of the built-in line. */
	readonly kind: "approval-line";
	readonly cwd: string;
	readonly value: number;
	/** What it was accepted on, in numbers, for the listing. */
	readonly evidence: { readonly allowed: number; readonly considered: number; readonly from: number };
	readonly at: string;
	readonly status: "active" | "undone";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

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
	if (value.type === "adaptation") {
		const evidence = value.evidence;
		if (!isText(value.id) || value.kind !== "approval-line" || !isText(value.cwd) || !isNumber(value.value)) {
			return undefined;
		}
		if (value.status !== "active" && value.status !== "undone") return undefined;
		return {
			type: "adaptation",
			id: value.id,
			kind: "approval-line",
			cwd: value.cwd,
			value: value.value,
			evidence: {
				allowed: isRecord(evidence) && isNumber(evidence.allowed) ? evidence.allowed : 0,
				considered: isRecord(evidence) && isNumber(evidence.considered) ? evidence.considered : 0,
				from: isRecord(evidence) && isNumber(evidence.from) ? evidence.from : 0,
			},
			at,
			status: value.status,
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

/** The adaptation of one kind in force in a project, if the user accepted one and has not undone it. */
export function activeAdaptation(
	rows: readonly EvolveRow[],
	kind: AdaptationRow["kind"],
	cwd: string,
): AdaptationRow | undefined {
	return adaptations(rows)
		.filter((row) => row.kind === kind && row.cwd === cwd && row.status === "active")
		.pop();
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

/**
 * What the other features tell the evolve feature, and what they ask it. Set on the runtime by that feature
 * (`features/evolve.ts`) while it is on; with it off, nothing is observed and nothing adapted.
 */
export interface EvolveLink {
	/** The approval line the user accepted for this project, in place of the built-in one. */
	approvalLine(cwd: string): number | undefined;
	/** The user answered an approval question about a call the judge had read as needed, not surely enough. */
	approvalAnswered(answer: Omit<ApprovalRow, "type" | "at">): void;
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
