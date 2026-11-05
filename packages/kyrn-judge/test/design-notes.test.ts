import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The design notes in `kyrn/docs`. Most are records of what was measured or decided at the time and are not kept in
 * step with the code, a few are kept up to date; a reader, or an agent, has to know which before trusting one. So each
 * says it in a `Status:` line under its title. A translation names the original it was made from with the original's
 * hash, so a change to the original fails here until the translation follows it.
 */
const DOCS = fileURLToPath(new URL("../../../kyrn/docs", import.meta.url));
const notes = readdirSync(DOCS).filter((name) => /^\d\d-.+\.md$/.test(name));
const read = (name: string) => readFileSync(join(DOCS, name), "utf8").replaceAll("\r\n", "\n");
const hash = (name: string) => createHash("sha256").update(read(name)).digest("hex").slice(0, 16);

describe("the design notes", () => {
	it("each say under their title whether they are kept up to date", () => {
		expect(notes.length).toBeGreaterThan(10);
		const missing = notes.filter((name) => {
			const lines = read(name).split("\n");
			const first = lines.slice(1).find((line) => line.trim() !== "");
			return !lines[0]?.startsWith("# ") || !first?.startsWith("Status: ");
		});
		expect(missing, "add a `Status:` line under the title").toEqual([]);
	});

	it("each translation follows the original it was made from", () => {
		const translations = notes.filter((name) => name.endsWith(".en.md"));
		expect(translations.length).toBeGreaterThan(0);
		for (const name of translations) {
			const marker = /<!-- translated from (\S+), sha256 ([0-9a-f]{16}) -->/.exec(read(name));
			expect(marker, `${name} names no original`).not.toBeNull();
			const [, original, recorded] = marker as RegExpExecArray;
			expect(existsSync(join(DOCS, original)), `${name}: ${original} is not there`).toBe(true);
			expect(
				recorded,
				`${original} changed since ${name} was made from it: bring the translation up to date, then set its sha256 to ${hash(original)}`,
			).toBe(hash(original));
		}
	});
});
