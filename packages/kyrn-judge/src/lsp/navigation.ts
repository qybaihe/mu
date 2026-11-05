/**
 * The agent's questions about code, put to a language server: where a symbol
 * is defined, where it is used, what implements it, and what it is. Pure: the
 * feature (`extension/features/lsp.ts`) sends the requests and reads the files.
 *
 * Positions are what the model reads and writes: lines and columns from 1, a
 * column counted in UTF-16 code units as the protocol counts it. For text
 * outside the rarer characters (emoji count two) that is the editor's column.
 */
import { shownPath } from "./diagnostics.ts";

export type NavigationOp = "definition" | "references" | "implementation" | "hover";

/** The request each question is, and the capability a server announces when it answers it. */
export const NAVIGATION: Readonly<Record<NavigationOp, { readonly method: string; readonly capability: string }>> = {
	definition: { method: "textDocument/definition", capability: "definitionProvider" },
	references: { method: "textDocument/references", capability: "referencesProvider" },
	implementation: { method: "textDocument/implementation", capability: "implementationProvider" },
	hover: { method: "textDocument/hover", capability: "hoverProvider" },
};

/** A place a server pointed to: line and character from 0, the character in UTF-16 code units. */
export interface Place {
	readonly uri: string;
	/** The file, or undefined for a URI that names no file on this machine. */
	readonly path: string | undefined;
	readonly line: number;
	readonly character: number;
}

const WORD = /[\p{L}\p{N}_$]/u;

/**
 * Where on a line the symbol starts, as the protocol counts it, or undefined when the line does not hold it. A whole
 * word wins over a part of one (`id` in `id = userId`); when it is there more than once, the occurrence at the column
 * (from 1) or nearest to it, else the first.
 */
export function symbolAt(text: string, symbol: string, column?: number): number | undefined {
	if (!symbol) return undefined;
	const starts: number[] = [];
	for (let at = text.indexOf(symbol); at >= 0; at = text.indexOf(symbol, at + 1)) starts.push(at);
	const whole = starts.filter((at) => !WORD.test(text[at - 1] ?? "") && !WORD.test(text[at + symbol.length] ?? ""));
	const found = whole.length > 0 ? whole : starts;
	if (found.length === 0) return undefined;
	if (column === undefined) return found[0];
	const target = column - 1;
	const away = (at: number) => (target < at ? at - target : Math.max(0, target - (at + symbol.length - 1)));
	return found.reduce((best, at) => (away(at) < away(best) ? at : best));
}

/** One protocol position, or undefined when the value is not one. */
function position(value: unknown): { line: number; character: number } | undefined {
	const { line, character } = (value ?? {}) as { line?: unknown; character?: unknown };
	return typeof line === "number" && typeof character === "number" ? { line, character } : undefined;
}

/**
 * The places in an answer to `definition`, `references` or `implementation`: a `Location`, a list of them or of
 * `LocationLink`s, or null. A link points at its name (`targetSelectionRange`), not at the whole declaration. The
 * same place twice is kept once, also when two URIs name the same file (`pathOf` decides); whatever is not a place
 * is left out.
 */
export function readPlaces(result: unknown, pathOf: (uri: string) => string | undefined): Place[] {
	const items = Array.isArray(result) ? result : result ? [result] : [];
	const places = new Map<string, Place>();
	for (const item of items) {
		const { uri, range, targetUri, targetRange, targetSelectionRange } = (item ?? {}) as Record<string, unknown>;
		const where = typeof targetUri === "string" ? targetUri : uri;
		const span = (typeof targetUri === "string" ? (targetSelectionRange ?? targetRange) : range) as
			| { start?: unknown }
			| undefined;
		const start = position(span?.start);
		if (typeof where !== "string" || !start) continue;
		const path = pathOf(where);
		places.set(`${path ?? where}\n${start.line}\n${start.character}`, { uri: where, path, ...start });
	}
	return [...places.values()];
}

/** The text of a hover: Markdown or plain text, an old-style marked string, or a list of them. Empty for none. */
export function readHover(result: unknown): string {
	const contents = (result as { contents?: unknown } | null | undefined)?.contents;
	const part = (value: unknown): string => {
		if (typeof value === "string") return value;
		const { language, value: text } = (value ?? {}) as { language?: unknown; value?: unknown };
		if (typeof text !== "string") return "";
		return typeof language === "string" ? `\`\`\`${language}\n${text}\n\`\`\`` : text;
	};
	const parts = Array.isArray(contents) ? contents.map(part) : [part(contents)];
	return parts
		.map((text) => text.trim())
		.filter(Boolean)
		.join("\n\n");
}

/** What the places are, in the model's words: "3 references to `save`". */
const NOUNS: Readonly<Record<Exclude<NavigationOp, "hover">, readonly [string, string, string]>> = {
	definition: ["definition", "definitions", "of"],
	references: ["reference", "references", "to"],
	implementation: ["implementation", "implementations", "of"],
};

/** "No references to `save` found." */
export function nothingFound(op: Exclude<NavigationOp, "hover">, subject: string): string {
	const [, many, to] = NOUNS[op];
	return `No ${many} ${to} ${subject} found.`;
}

const SNIPPET = 160;

/**
 * The answer as the model reads it: one line per place, `path:line:column  text of that line`, sorted by file and
 * line, at most `max`, and how many were left out. `lineOf` gives a place's line of text when the file can be read.
 */
export function describePlaces(
	op: Exclude<NavigationOp, "hover">,
	subject: string,
	places: readonly Place[],
	options: { cwd: string; max: number; lineOf: (place: Place) => string | undefined },
): string {
	const sorted = [...places].sort(
		(a, b) => (a.path ?? a.uri).localeCompare(b.path ?? b.uri) || a.line - b.line || a.character - b.character,
	);
	const shown = sorted.slice(0, Math.max(1, options.max));
	const [one, many, to] = NOUNS[op];
	const head = `${sorted.length} ${sorted.length === 1 ? one : many} ${to} ${subject}${
		op === "references" ? ", the declaration included" : ""
	}`;
	const rows = shown.map((place) => {
		const where = `${place.path ? shownPath(place.path, options.cwd) : place.uri}:${place.line + 1}:${place.character + 1}`;
		const text = options.lineOf(place)?.trim();
		return text ? `${where}  ${text.length > SNIPPET ? `${text.slice(0, SNIPPET)}…` : text}` : where;
	});
	const left = sorted.length - shown.length;
	return [
		`${head}${left > 0 ? `. The first ${shown.length}:` : ":"}`,
		...rows,
		...(left > 0 ? [`${left} more not shown. Search the text with grep to see them all.`] : []),
	].join("\n");
}
