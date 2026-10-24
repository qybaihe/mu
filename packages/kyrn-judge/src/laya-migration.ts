import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_CONFIG, retiredJudges, withoutRetired } from "./config.ts";
import { missingFiles } from "./mude/download.ts";
import { MUDE_FILES, type MudeFile } from "./mude/manifest.ts";
import { mudePaths } from "./mude/paths.ts";
import { Backups, judgeConfigPath, writeFileAtomic } from "./setup/files.ts";

/**
 * Laya, the third-party local judge mu had until 0.2.4, is no longer built in. A configuration that still names it
 * (`retiredJudges` in config.ts: `laya` in `tiers` or a route, or a judge of the old type `local`) is read without it
 * in every session, and mu.json loses it once, in the first session that can tell the person so:
 *
 * - mude 1.0 set up on this machine (`mudeReady`) goes where Laya was;
 * - otherwise Laya is left out, and `tiers` with nothing else in it becomes mu's default (Jev);
 * - a route left with no judge is taken out (the decision goes back to `tiers`), and so is every `local` judge entry.
 *
 * Only those parts of the file change: the rest stays as it was, byte for byte (`migrateConfigText`). A file that is
 * not plain JSON is left alone, as the judgment layer leaves it (config.ts reads it as broken).
 */

const MUDE_KEY = "MU_JUDGE_MUDE_KEY";

/**
 * Whether mude 1.0 can answer in Laya's place on this machine: its files are installed and checked, its Python
 * environment is there, and the key its server asks for is set (`mu judge mude enable` writes it to the .env, which
 * the launcher passes on). Its server need not be running: the launcher starts it, and until it answers the judges
 * behind it do.
 */
export function mudeReady(
	muHome: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
	files: readonly MudeFile[] = MUDE_FILES,
): boolean {
	if (!env[MUDE_KEY]) return false;
	const paths = mudePaths(muHome);
	try {
		return existsSync(paths.python) && missingFiles(paths.model, files).length === 0;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Where the values are in the text
// ---------------------------------------------------------------------------------------------------------------

interface Node {
	readonly start: number;
	readonly end: number;
	readonly kind: "object" | "array" | "value";
	readonly props: readonly Prop[];
	readonly items: readonly Node[];
}

interface Prop {
	readonly key: string;
	readonly keyStart: number;
	readonly value: Node;
}

/** The JSON `text` as spans: each object's properties and each array's items, with where they are. Throws if malformed. */
function spans(text: string): Node {
	let at = 0;
	const fail = (): never => {
		throw new SyntaxError(`Unexpected character at ${at}`);
	};
	const space = () => {
		while (at < text.length && /\s/.test(text[at])) at++;
	};
	const string = (): string => {
		const start = at;
		at++;
		while (at < text.length && text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
		if (at >= text.length) fail();
		at++;
		return JSON.parse(text.slice(start, at)) as string;
	};
	const value = (): Node => {
		space();
		const start = at;
		const char = text[at];
		if (char === "{") {
			at++;
			const props: Prop[] = [];
			space();
			if (text[at] === "}") at++;
			else {
				for (;;) {
					space();
					if (text[at] !== '"') fail();
					const keyStart = at;
					const key = string();
					space();
					if (text[at] !== ":") fail();
					at++;
					props.push({ key, keyStart, value: value() });
					space();
					if (text[at] === ",") at++;
					else if (text[at] === "}") {
						at++;
						break;
					} else fail();
				}
			}
			return { start, end: at, kind: "object", props, items: [] };
		}
		if (char === "[") {
			at++;
			const items: Node[] = [];
			space();
			if (text[at] === "]") at++;
			else {
				for (;;) {
					items.push(value());
					space();
					if (text[at] === ",") at++;
					else if (text[at] === "]") {
						at++;
						break;
					} else fail();
				}
			}
			return { start, end: at, kind: "array", props: [], items };
		}
		if (char === '"') string();
		else {
			while (at < text.length && !/[\s,\]}]/.test(text[at])) at++;
			if (at === start) fail();
		}
		return { start, end: at, kind: "value", props: [], items: [] };
	};
	const root = value();
	space();
	if (at !== text.length) fail();
	return root;
}

interface Edit {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

/** `list` written as `original` was: on one line or one item per line, with or without a space after each comma. */
function arrayText(text: string, original: Node, list: readonly string[]): string {
	const old = text.slice(original.start, original.end);
	const items = original.items;
	const indent = items.length > 0 ? text.slice(text.lastIndexOf("\n", items[0].start) + 1, items[0].start) : "";
	const oneLine =
		items.length === 0 || !/^\s*$/.test(indent) || !text.slice(original.start + 1, items[0].start).includes("\n");
	if (oneLine) {
		return `[${list.map((item) => JSON.stringify(item)).join(/,\s/.test(old) || items.length < 2 ? ", " : ",")}]`;
	}
	const closing = text.slice(text.lastIndexOf("\n", original.end - 1) + 1, original.end - 1);
	const end = /^\s*$/.test(closing) ? `\n${closing}` : "";
	return `[\n${list.map((item) => `${indent}${JSON.stringify(item)}`).join(",\n")}${end}]`;
}

/** Edits that take the properties `gone` out of `object`, commas and the lines they stood on included. */
function removals(object: Node, gone: ReadonlySet<Prop>): Edit[] {
	const props = object.props;
	if (props.every((prop) => gone.has(prop))) return props.length > 0 ? [{ ...object, text: "{}" }] : [];
	const edits: Edit[] = [];
	for (let first = 0; first < props.length; first++) {
		if (!gone.has(props[first]) || (first > 0 && gone.has(props[first - 1]))) continue;
		let last = first;
		while (last + 1 < props.length && gone.has(props[last + 1])) last++;
		// Up to the next property kept, or, at the end, from the end of the one before.
		edits.push(
			last + 1 < props.length
				? { start: props[first].keyStart, end: props[last + 1].keyStart, text: "" }
				: { start: props[first - 1].value.end, end: props[last].value.end, text: "" },
		);
	}
	return edits;
}

/** The property `key` of `object`: the last one of that name, as JSON.parse reads it. */
function propOf(object: Node | undefined, key: string): Prop | undefined {
	let found: Prop | undefined;
	for (const prop of object?.kind === "object" ? object.props : []) if (prop.key === key) found = prop;
	return found;
}

const stringsOf = (text: string, node: Node): string[] | undefined => {
	const value: unknown = JSON.parse(text.slice(node.start, node.end));
	if (typeof value === "string") return value.split(",");
	return Array.isArray(value) ? value.filter((tier): tier is string => typeof tier === "string") : undefined;
};

/**
 * mu.json's text without Laya, as the module comment says, with `replacement` (mude) where it was. Undefined when
 * there is nothing to change, or the text is not a plain JSON object.
 */
export function migrateConfigText(text: string, replacement?: string): string | undefined {
	let root: Node;
	try {
		root = spans(text);
	} catch {
		return undefined;
	}
	if (root.kind !== "object") return undefined;
	const judges = propOf(root, "judges")?.value;
	const retired = retiredJudges(judges ? JSON.parse(text.slice(judges.start, judges.end)) : undefined);
	const edits: Edit[] = [];

	const tiers = propOf(root, "tiers")?.value;
	const named = tiers?.kind === "array" ? stringsOf(text, tiers) : undefined;
	const kept = named && withoutRetired(named, retired, replacement);
	if (tiers && kept) {
		edits.push({ ...tiers, text: arrayText(text, tiers, kept.length > 0 ? kept : DEFAULT_CONFIG.tiers) });
	}

	const routes = propOf(root, "routes")?.value;
	const emptied = new Set<Prop>();
	for (const route of routes?.kind === "object" ? routes.props : []) {
		const list = stringsOf(text, route.value);
		const left = list && withoutRetired(list, retired, replacement);
		if (!left) continue;
		const trimmed = left.map((tier) => tier.trim()).filter(Boolean);
		if (trimmed.length === 0) emptied.add(route);
		else if (route.value.kind === "array")
			edits.push({ ...route.value, text: arrayText(text, route.value, trimmed) });
		else edits.push({ ...route.value, text: JSON.stringify(trimmed.join(", ")) });
	}
	if (routes && emptied.size > 0) edits.push(...removals(routes, emptied));

	if (judges?.kind === "object") {
		const sidecars = new Set(
			judges.props.filter((prop) => {
				const entry: unknown = JSON.parse(text.slice(prop.value.start, prop.value.end));
				return typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "local";
			}),
		);
		if (sidecars.size > 0) edits.push(...removals(judges, sidecars));
	}

	if (edits.length === 0) return undefined;
	let next = text;
	for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
		next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
	}
	return next;
}

/**
 * Takes Laya out of mu.json (kyrn.json on a machine that only has that one), keeping a copy of the file as it was in
 * <mu home>/backups. Returns whether the file changed.
 */
export function migrateConfigFile(options: {
	readonly agentDir: string;
	readonly muHome: string;
	readonly replacement?: string;
	readonly now?: Date;
}): boolean {
	const path = judgeConfigPath(options.agentDir);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return false;
	}
	const next = migrateConfigText(text, options.replacement);
	if (next === undefined) return false;
	try {
		new Backups(options.muHome, options.now ?? new Date()).save(path);
		writeFileAtomic(path, next);
		return true;
	} catch {
		// Read without Laya all the same; the next session tries again.
		return false;
	}
}
