/**
 * The `.env` the launcher reads (the checkout's, or ~/.mu/.env for the npm package): read the way kyrn/bin/mu.mjs
 * reads it (parseEnvFile there; a test holds the two to the same answers), and changed one variable at a time, every
 * other line kept as it was. A value is data: nothing in the file is executed or expanded.
 */

export interface EnvEntry {
	readonly name: string;
	readonly value: string;
	/** The lines the definition takes, first and last (a quoted value may go on over several). */
	readonly first: number;
	readonly last: number;
}

const DEFINITION = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function closingQuote(text: string, quote: string): number {
	for (let index = 0; index < text.length; index++) {
		if (quote === '"' && text[index] === "\\") index++;
		else if (text[index] === quote) return index;
	}
	return -1;
}

/** Every definition in the file, in order, with where it is. Lines that are none are skipped, as the launcher skips them. */
export function readEnvEntries(text: string): EnvEntry[] {
	const entries: EnvEntry[] = [];
	const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index].trim();
		if (!line || line.startsWith("#")) continue;
		const match = DEFINITION.exec(line);
		if (!match) continue;
		const [, name, rest] = match;
		const quote = rest[0];
		if (quote !== '"' && quote !== "'") {
			entries.push({ name, value: rest.replace(/\s+#.*$/, "").trim(), first: index, last: index });
			continue;
		}
		let body = rest.slice(1);
		let end = closingQuote(body, quote);
		const startedAt = index;
		while (end < 0 && index + 1 < lines.length) {
			body += `\n${lines[++index]}`;
			end = closingQuote(body, quote);
		}
		if (end < 0) {
			index = startedAt;
			continue;
		}
		const value = body.slice(0, end);
		entries.push({
			name,
			value: quote === '"' ? value.replace(/\\(["\\$`])/g, "$1") : value,
			first: startedAt,
			last: index,
		});
	}
	return entries;
}

/** The value of `name` as the launcher would take it from the file: its first definition. */
export function envFileValue(text: string, name: string): string | undefined {
	return readEnvEntries(text).find((entry) => entry.name === name)?.value;
}

/** A value written so that the launcher reads it back unchanged: bare when it is plain, else quoted. */
export function formatEnvValue(value: string): string {
	if (/^[A-Za-z0-9_./:@+-]*$/.test(value)) return value;
	if (!value.includes("'")) return `'${value}'`;
	return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * The file with `name` set to `value`: its first definition replaced in place (with its `export` if it had one),
 * later ones removed, as they would never be read; appended at the end when there is none. The file's own line
 * endings are kept.
 */
export function setEnvValue(text: string, name: string, value: string): string {
	const newline = text.includes("\r\n") ? "\r\n" : "\n";
	const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
	const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
	const found = readEnvEntries(text).filter((entry) => entry.name === name);
	const assignment = (exported: boolean) => `${exported ? "export " : ""}${name}=${formatEnvValue(value)}`;
	if (found.length === 0) {
		const body = lines.join(newline);
		const separator = body === "" || body.endsWith(newline) ? "" : newline;
		return `${bom}${body}${separator}${assignment(false)}${newline}`;
	}
	const drop = new Set<number>();
	for (const entry of found.slice(1)) for (let line = entry.first; line <= entry.last; line++) drop.add(line);
	const [first] = found;
	const exported = /^\s*export\s/.test(lines[first.first]);
	const next: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		if (drop.has(index)) continue;
		if (index === first.first) next.push(assignment(exported));
		else if (index > first.first && index <= first.last) continue;
		else next.push(lines[index]);
	}
	return `${bom}${next.join(newline)}`;
}
