/**
 * The `lsp` tool: the model asks the language servers on this machine where a symbol is defined, where it is used,
 * what implements it, and what it is. Part of the `lsp` feature (`lsp.ts`), on the same server processes as its
 * diagnostics, and a capability of the catalog: hidden until the judge opens it for a task or the model asks for it.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { shownPath } from "../../lsp/diagnostics.ts";
import type { LspManager, ReadyServer } from "../../lsp/manager.ts";
import {
	describePlaces,
	NAVIGATION,
	type NavigationOp,
	nothingFound,
	type Place,
	readHover,
	readPlaces,
	symbolAt,
} from "../../lsp/navigation.ts";
import { extensionOf, type ServerSpec } from "../../lsp/servers.ts";
import { clip, type KyrnRuntime } from "../runtime.ts";

/** What the `lsp` feature lends the tool. */
export interface NavigationServers {
	readonly manager: LspManager;
	/**
	 * The server table for the session's folder; whether its project may name servers, and whether it names some in a
	 * file that is ignored because it may not.
	 */
	readonly table: (ctx: ExtensionContext) => {
		readonly servers: readonly ServerSpec[];
		readonly trusted: boolean;
		readonly ignoredProjectFile: boolean;
	};
	/** A file's text: undefined when it does not exist, false when it is too large to hand a server. */
	readonly read: (path: string) => string | undefined | false;
	readonly maxResults: number;
	readonly maxFileBytes: number;
}

interface NavigationDetails {
	readonly op: NavigationOp;
	/** The server that answered, or the first one asked when none had an answer. */
	readonly server: string;
	readonly results: number;
}

/** A path as a tool is given it: `@` in front, `~` for the home folder, relative to the session's folder. */
export function toolPath(cwd: string, raw: string): string {
	const named = raw.startsWith("@") ? raw.slice(1) : raw;
	return resolve(cwd, named === "~" || named.startsWith("~/") ? join(homedir(), named.slice(1)) : named);
}

/**
 * A file by its real path, links resolved. A server may name files by it while the session's folder is reached
 * through a link (macOS's `/var` is `/private/var`): compared as written, one file would be two, and inside the
 * session's folder would be outside it.
 */
function real(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

/** How long a question waits for its answer: a cold TypeScript server loads the whole project for the first one. */
const ANSWER_MS = 30_000;
/** The protocol's "ask again": the text changed under the request, or the server dropped it for newer work. */
const ASK_AGAIN = new Set([-32801, -32802]);
const HOVER_CHARS = 3000;
const BUSY =
	" The language server is still loading the project (it reports work in progress): ask again in a moment, or use grep.";

/** Registers the `lsp` tool and its catalog entry, `lsp:navigation`. */
export function registerNavigation(runtime: KyrnRuntime, servers: NavigationServers): void {
	runtime.pi.registerTool({
		name: "lsp",
		label: "Code navigation",
		description:
			"Ask a language server about a symbol: where it is defined (definition), every place that uses it, the declaration included (references), what implements an interface or abstract method (implementation), or its type and documentation (hover). Lines and columns count from 1. Find and read code with grep and read as usual; use this when the text alone is ambiguous: a name defined in several places, an interface's implementations, a definition in another file or package.",
		parameters: Type.Object({
			op: Type.Union(
				[
					Type.Literal("definition"),
					Type.Literal("references"),
					Type.Literal("implementation"),
					Type.Literal("hover"),
				],
				{ description: "What to ask" },
			),
			path: Type.String({ description: "File the symbol is in" }),
			line: Type.Number({ description: "Line it is on, from 1" }),
			symbol: Type.Optional(Type.String({ description: "Its name as written on that line" })),
			column: Type.Optional(
				Type.Number({ description: "Its column, from 1, when the name is on the line more than once" }),
			),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			runtime.touch(ctx);
			const { text, details } = await answer(params, servers, ctx);
			return { content: [{ type: "text", text }], details };
		},
	});
	runtime.catalog.register({
		id: "lsp:navigation",
		kind: "lsp",
		title: "Code navigation",
		description:
			"Go to a symbol's definition or implementations, list every place that uses it, or read its type and docs, from the language servers installed on this machine: for when grep can't tell same-named symbols apart.",
		tools: ["lsp"],
		exposure: "judged",
	});
}

/** One question, answered in the model's words. Throws, with what to do instead, when it cannot be asked. */
async function answer(
	params: { op: NavigationOp; path: string; line: number; symbol?: string; column?: number },
	servers: NavigationServers,
	ctx: ExtensionContext,
): Promise<{ text: string; details: NavigationDetails }> {
	const file = toolPath(ctx.cwd, params.path);
	const shown = shownPath(file, ctx.cwd);
	const text = servers.read(file);
	if (text === undefined) throw new Error(`${shown} does not exist.`);
	if (text === false) {
		throw new Error(
			`${shown} is larger than mu hands a language server (${servers.maxFileBytes} bytes). Use grep and read.`,
		);
	}
	const lines = text.split("\n");
	const count = text.endsWith("\n") ? lines.length - 1 : lines.length;
	const line = Math.trunc(params.line);
	if (!(line >= 1 && line <= count))
		throw new Error(`${shown} has ${count} lines; ${params.line} is not one of them.`);
	const lineText = lines[line - 1].replace(/\r$/, "");
	const symbol = params.symbol?.trim();
	const column = params.column === undefined ? undefined : Math.trunc(params.column);
	if (!symbol && column === undefined) {
		throw new Error("Give the symbol's name as written on that line (symbol), or its column from 1.");
	}
	if (!symbol && !(column !== undefined && column >= 1 && column <= lineText.length)) {
		throw new Error(`Line ${line} of ${shown} has ${lineText.length} columns; ${params.column} is not one of them.`);
	}
	const character = symbol ? symbolAt(lineText, symbol, column) : (column as number) - 1;
	if (character === undefined) {
		throw new Error(`\`${symbol}\` is not on line ${line} of ${shown}, which reads: ${clip(lineText.trim(), 200)}`);
	}

	const table = servers.table(ctx);
	const serving = servers.manager.serving(file, table.servers, table.trusted);
	if (serving.length === 0) throw new Error(unavailable(file, servers, ctx));
	const { running, failed } = await servers.manager.prepare(file, text, serving, ctx.cwd);
	if (running.length === 0) {
		throw new Error(
			`The language server for these files could not be started (${failed.map(({ id, reason }) => `${id}: ${reason}`).join("; ")}). Use grep and read.`,
		);
	}

	const { op } = params;
	const subject = symbol ? `\`${symbol}\`` : `the symbol at ${shown}:${line}:${character + 1}`;
	const asked = await ask(op, file, { line: line - 1, character }, running);
	const busy = asked.result === null && asked.busy ? BUSY : "";
	const details = (results: number): NavigationDetails => ({ op, server: asked.id, results });
	if (op === "hover") {
		const hover = readHover(asked.result);
		if (!hover) return { text: `No type or documentation for ${subject}.${busy}`, details: details(0) };
		// Kept as written, line breaks included: a signature and its documentation read as Markdown.
		const cut = hover.length > HOVER_CHARS ? `${hover.slice(0, HOVER_CHARS)}…` : hover;
		return { text: `${subject}:\n${cut}`, details: details(1) };
	}
	const places = readPlaces(asked.result, (uri) => {
		const path = asked.client.pathOf(uri);
		return path === undefined ? undefined : real(path);
	});
	if (places.length === 0) return { text: `${nothingFound(op, subject)}${busy}`, details: details(0) };
	// Each file is read once per answer, however many of its lines are shown.
	const read = new Map<string, string[] | undefined>([[real(file), lines]]);
	const lineOf = (place: Place) => {
		if (!place.path) return undefined;
		if (!read.has(place.path)) {
			const content = servers.read(place.path);
			read.set(place.path, typeof content === "string" ? content.split("\n") : undefined);
		}
		return read.get(place.path)?.[place.line];
	};
	return {
		text: describePlaces(op, subject, places, { cwd: real(ctx.cwd), max: servers.maxResults, lineOf }),
		details: details(places.length),
	};
}

/**
 * Puts the question to the running servers that answer its kind, in order, and keeps the first answer that says
 * something. `result` is null when none did; `busy` then says whether one is still loading its project.
 */
async function ask(
	op: NavigationOp,
	file: string,
	position: { line: number; character: number },
	running: readonly ReadyServer[],
): Promise<{ id: string; client: ReadyServer["client"]; result: unknown; busy: boolean }> {
	const capable = running.filter(({ client }) => client.supports(NAVIGATION[op].capability));
	if (capable.length === 0) {
		const names = running.map(({ id }) => id).join(", ");
		const instead = op === "implementation" ? "Ask for references instead, or use grep." : "Use grep and read.";
		throw new Error(`${names} doesn't answer ${op} questions. ${instead}`);
	}
	const problems: string[] = [];
	for (const { id, client } of capable) {
		const request = {
			textDocument: { uri: client.uriOf(file) },
			position,
			...(op === "references" ? { context: { includeDeclaration: true } } : {}),
		};
		try {
			const result = await askAgainOnce(() => client.ask(NAVIGATION[op].method, request, ANSWER_MS));
			const said =
				op === "hover" ? readHover(result) !== "" : readPlaces(result, (uri) => client.pathOf(uri)).length > 0;
			if (said) return { id, client, result, busy: false };
		} catch (error) {
			problems.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (problems.length === capable.length) {
		throw new Error(`The language server didn't answer (${problems.join("; ")}). Use grep and read.`);
	}
	const [first] = capable;
	return { id: first.id, client: first.client, result: null, busy: capable.some(({ client }) => client.busy) };
}

/** A request the server asked to have sent again is sent once more, a moment later. */
async function askAgainOnce(send: () => Promise<unknown>): Promise<unknown> {
	try {
		return await send();
	} catch (error) {
		if (!ASK_AGAIN.has((error as { code?: unknown }).code as number)) throw error;
		await new Promise((done) => setTimeout(done, 300));
		return send();
	}
}

/** Why no server answers questions about this file, and what to do instead. */
function unavailable(file: string, servers: NavigationServers, ctx: ExtensionContext): string {
	const table = servers.table(ctx);
	const extension = extensionOf(file);
	const files = extension ? `${extension} files` : "this file";
	const handling = extension
		? servers.manager.status(table.servers, table.trusted).filter((server) => server.extensions.includes(extension))
		: [];
	// An untrusted project's file is not even read into the table, so it can only be said that there is one.
	const project = table.ignoredProjectFile
		? " This project names its own servers in lsp.json, which mu ignores until the user trusts the project (/trust)."
		: "";
	if (handling.length === 0) return `No language server is set up for ${files}. Use grep and read.${project}`;
	return `No language server for ${files} is installed on this machine (mu looks for ${handling.map((server) => server.id).join(", ")} on PATH and installs none). Use grep and read.${project}`;
}
