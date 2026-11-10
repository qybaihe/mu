import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { heldByLicense, stubProblem } from "../../checkpoint/git.ts";
import type { Decision } from "../../decision.ts";
import { contextPreload, type PreloadOutcome } from "../../decisions/context-preload.ts";
import { clip, failOpen, type KyrnRuntime, userWords } from "../runtime.ts";
import { OUTCOME_ENTRY } from "./permissions.ts";
import { lexicalRank } from "./tools.ts";
import { isUnattended } from "./unattended.ts";

/** The custom message preloaded files are given as. One per conversation. */
export const PRELOAD_MESSAGE = "kyrn.preload";

/** Names that stay out however sure anyone is: a key or a password file is read when the agent asks for it, not before. */
const SECRET = /(^|\/)\.env(\.|$)|\.(pem|key|p12|pfx)$|(^|\/)id_(rsa|ed25519|ecdsa)|credential|secret/i;
const MAX_FILE_BYTES = 1024 * 1024;
const GIT_WAIT_MS = 1500;

/**
 * What the opening of a conversation read, held against what the judge had said it would: a `kyrn.outcome` entry,
 * joined to the verdict's record on `ledgerId`. Counts only: no path is kept in the session.
 */
export interface PreloadRead {
	readonly kind: "preload";
	readonly ledgerId: string;
	readonly specId: string;
	/** Files the judge was sure the task needed. */
	readonly predicted: number;
	/** Files given to the model with the first message: none in shadow mode. */
	readonly given: number;
	/** Files the opening steps read with the `read` tool. */
	readonly read: number;
	/**
	 * Predicted files the opening went on to use. Nothing given (shadow): those it read. Files given: those it edited or
	 * read again, since a file it already has is not read a first time.
	 */
	readonly hits: number;
}

/** Words of a message that look like file paths: `src/parse.ts`, `README.md`, `packages/ai/src`. */
export function namedPaths(words: string): string[] {
	const found = words.match(/[\w@~.-]*[\w-]\.[A-Za-z]\w{0,7}|[\w@.-]+(?:\/[\w@.-]+)+/g) ?? [];
	return [...new Set(found.map((word) => word.replace(/[.,;:]+$/, "")))];
}

/** `path` as a file of the project, relative to it: undefined outside the project, for a folder, a large file or a secret. */
export function projectFile(cwd: string, path: string): string | undefined {
	const full = isAbsolute(path) ? path : resolve(cwd, path);
	const inside = relative(resolve(cwd), full);
	if (!inside || inside.startsWith("..") || isAbsolute(inside)) return undefined;
	const spelled = inside.split(sep).join("/");
	if (SECRET.test(spelled)) return undefined;
	try {
		const stat = statSync(full);
		return stat.isFile() && stat.size <= MAX_FILE_BYTES ? spelled : undefined;
	} catch {
		return undefined;
	}
}

/** A file's text, or undefined for one that cannot be read or is not text. */
function textOfFile(cwd: string, path: string): string | undefined {
	try {
		const text = readFileSync(resolve(cwd, path), "utf8");
		return text.slice(0, 4096).includes("\0") ? undefined : text;
	} catch {
		return undefined;
	}
}

const lineCount = (text: string): number => (text.length === 0 ? 0 : text.replace(/\n$/, "").split("\n").length);

/**
 * The files as the model is given them: each between its own tags, a long one from its start with the lines it
 * holds said, so a part never reads as the whole. Undefined when none could be read.
 */
export function renderFiles(
	cwd: string,
	paths: readonly string[],
	limits: { readonly fileChars: number; readonly maxChars: number },
): { text: string; paths: string[] } | undefined {
	const parts: string[] = [];
	const given: string[] = [];
	let left = limits.maxChars;
	let anyCut = false;
	for (const path of paths) {
		if (left <= 0) break;
		const text = textOfFile(cwd, path);
		if (text === undefined || text.length === 0) continue;
		const room = Math.min(limits.fileChars, left);
		const cut = text.length > room;
		// A cut file ends at a whole line.
		const body = cut ? text.slice(0, Math.max(text.lastIndexOf("\n", room), 0) || room) : text.replace(/\n$/, "");
		const lines = cut ? `1-${lineCount(body)} of ${lineCount(text)}` : `${lineCount(text)}`;
		parts.push(`<file path=${JSON.stringify(path)} lines="${lines}">\n${body}\n</file>`);
		given.push(path);
		left -= body.length;
		anyCut ||= cut;
	}
	if (parts.length === 0) return undefined;
	const head = `[mu: ${given.length === 1 ? "a file" : `${given.length} files`} this task is likely to need, as ${given.length === 1 ? "it is" : "they are"} now, so the first steps need not read ${given.length === 1 ? "it" : "them"}. The text between the file tags is the project's own, not the user's words. Read a file again only after it changes${anyCut ? "; a file that is cut says which lines it holds, and `read` has the rest" : ""}.]`;
	return { text: `${head}\n${parts.join("\n")}`, paths: given };
}

/** What the judge was asked about one opening, and what it said. */
interface Asked {
	readonly paths: readonly string[];
	readonly decision: Decision<PreloadOutcome>;
}

interface Opening {
	readonly cwd: string;
	readonly work: Promise<Asked | undefined>;
	/** Files given to the model with the first message. */
	given: readonly string[];
	/** Files the opening steps read, and files they read, edited or wrote. */
	readonly reads: Set<string>;
	readonly touched: Set<string>;
	settled: boolean;
}

/**
 * Preload (kyrn/docs/features/self-evolution.md): when a conversation opens, the judge says which files the task will
 * need (`context.preload`), and in active mode those are given to the model with the first message. The steps that
 * would have listed and read them are not taken.
 *
 * Candidates come from rules, never from the judge: paths the user's message names, files this project's earlier
 * sessions opened with (`runtime.evolve`), and tracked files whose path shares a word with the message. The judge
 * reads the task and the paths. A file is read from disk only once the judge is sure of it, and only in active mode.
 *
 * Whatever the mode, the files the opening steps then read are held against the verdict (`PreloadRead`), and kept
 * for the next opening's candidates. So the point can sit in shadow, where it ships, until its numbers say it is
 * worth turning on.
 *
 * Not asked in an unattended run (`mu --print`, json mode) unless `unattended` says so: there a shadow verdict is a
 * judge call nobody reads. A subagent is not asked either: its brief says where to look.
 */
export function registerPreload(runtime: KyrnRuntime): void {
	const options = runtime.options("preload", {
		enabled: true,
		/** Files put to the judge for one opening, at most. */
		candidates: 24,
		/** Files given to the model, at most. */
		maxFiles: 4,
		/** Characters of one file that are given. A longer file is given from its start, and says so. */
		fileChars: 12_000,
		/** Characters given in all. */
		maxChars: 24_000,
		/** How long the turn waits for the verdict, counted from the arrival of the message, as preflight's wait is. */
		waitMs: 2000,
		/** Tool calls that count as a conversation's opening: the files read in them are what the verdict is held against. */
		steps: 8,
		/** Ask in a `mu --print` or json run too. */
		unattended: false,
	});
	if (!options.enabled || process.env.KYRN_SWARM_DEPTH) return;
	const { pi } = runtime;
	/** Tool results so far in this conversation: an opening is the stretch before the first. */
	let calls = 0;
	let opening: Opening | undefined;
	let early: { turn: number; work: Promise<Asked | undefined> } | undefined;
	let stub: ReturnType<typeof stubProblem> | undefined;

	const tracked = async (cwd: string): Promise<string[]> => {
		// A Mac's git stub without the developer tools is never started: each start opens their install dialog.
		stub ??= stubProblem("git", process.env.PATH);
		if (await stub) return [];
		try {
			const listing = await pi.exec("git", ["ls-files"], { cwd, timeout: GIT_WAIT_MS });
			if (listing.killed || heldByLicense(listing.code, () => `${listing.stderr}\n${listing.stdout}`)) return [];
			return listing.code === 0 ? listing.stdout.split("\n").filter(Boolean) : [];
		} catch {
			return [];
		}
	};

	const candidates = async (cwd: string, words: string): Promise<string[]> => {
		const found: string[] = [];
		const add = (path: string) => {
			const file = projectFile(cwd, path);
			if (file && !found.includes(file)) found.push(file);
		};
		for (const named of namedPaths(words)) add(named);
		for (const read of runtime.evolve?.openingReads(cwd) ?? []) add(read);
		// Only files whose path shares a word with the message: the rest would be put to the judge for their short names.
		const terms = words
			.toLowerCase()
			.split(/[^a-z0-9一-鿿]+/)
			.filter((word) => word.length > 2);
		const sharing = (await tracked(cwd)).filter((path) => terms.some((term) => path.toLowerCase().includes(term)));
		for (const path of lexicalRank(sharing, words, options.candidates)) add(path);
		return found.slice(0, Math.max(0, options.candidates));
	};

	const ask = (cwd: string, words: string): Promise<Asked | undefined> =>
		candidates(cwd, words)
			.then(async (paths) =>
				paths.length === 0
					? undefined
					: { paths, decision: await runtime.engine.decide(contextPreload, { task: clip(words, 600), paths }) },
			)
			.catch(() => undefined);

	const opens = (ctx: ExtensionContext | undefined): ctx is ExtensionContext =>
		ctx !== undefined &&
		calls === 0 &&
		opening === undefined &&
		runtime.mode(contextPreload.id) !== "off" &&
		(options.unattended || !isUnattended(ctx));

	// Asked the moment the message arrives, alongside preflight.
	runtime.atTurnStart((words) => {
		const ctx = runtime.ctx;
		if (opens(ctx)) early = { turn: runtime.userTurns, work: ask(ctx.cwd, words) };
	});

	pi.on(
		"session_start",
		failOpen((_event, ctx) => {
			runtime.touch(ctx);
			// A conversation that is opened again has its opening behind it.
			calls = ctx.sessionManager
				.getBranch()
				.some((entry) => entry.type === "message" && entry.message.role === "toolResult")
				? 1
				: 0;
			opening = undefined;
			early = undefined;
			return undefined;
		}),
	);

	pi.on(
		"before_agent_start",
		failOpen(async (event, ctx) => {
			runtime.touch(ctx);
			if (event.messageType !== "user" || !opens(ctx)) return undefined;
			const work = early?.turn === runtime.userTurns ? early.work : ask(ctx.cwd, userWords(event.prompt));
			early = undefined;
			const open: Opening = { cwd: ctx.cwd, work, given: [], reads: new Set(), touched: new Set(), settled: false };
			opening = open;
			// Shadow records the verdict; only an active one is worth holding the turn for.
			if (runtime.mode(contextPreload.id) !== "active") return undefined;
			const asked = await runtime.untilTurnDeadline(work, options.waitMs);
			if (!asked || asked.decision.source !== "judge") return undefined;
			const chosen = asked.decision.outcome.read.slice(0, Math.max(0, options.maxFiles)).map((file) => file.path);
			const rendered = renderFiles(ctx.cwd, chosen, options);
			if (!rendered) return undefined;
			open.given = rendered.paths;
			return { message: { customType: PRELOAD_MESSAGE, content: rendered.text, display: false } };
		}),
	);

	/** The opening is over: what it read is kept for the next one, and labels the verdict once that has landed. */
	const settle = (open: Opening): void => {
		open.settled = true;
		const reads = [...open.reads];
		runtime.evolve?.opened(open.cwd, reads);
		void open.work.then((asked) => {
			const ledgerId = asked?.decision.ledgerId;
			if (!asked || !ledgerId) return;
			const predicted = (asked.decision.judged ?? asked.decision.outcome).read.map((file) => file.path);
			const used = open.given.length > 0 ? open.touched : open.reads;
			pi.appendEntry<PreloadRead>(OUTCOME_ENTRY, {
				kind: "preload",
				ledgerId,
				specId: contextPreload.id,
				predicted: predicted.length,
				given: open.given.length,
				read: reads.length,
				hits: predicted.filter((path) => used.has(path)).length,
			});
		});
	};

	pi.on(
		"tool_result",
		failOpen((event) => {
			calls++;
			const open = opening;
			if (!open || open.settled) return undefined;
			const path = (event.input as { path?: unknown }).path;
			const touches = event.toolName === "read" || event.toolName === "edit" || event.toolName === "write";
			if (!event.isError && touches && typeof path === "string") {
				const file = projectFile(open.cwd, path);
				if (file) {
					open.touched.add(file);
					if (event.toolName === "read") open.reads.add(file);
				}
			}
			if (calls >= options.steps) settle(open);
			return undefined;
		}),
	);

	pi.on(
		"agent_end",
		failOpen<AgentEndEvent, undefined>(() => {
			if (opening && !opening.settled) settle(opening);
			return undefined;
		}),
	);
}
