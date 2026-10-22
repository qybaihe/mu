import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { MANIFEST } from "../src/manifest.ts";
import { localizeManifest, type ManifestTranslations, manifestTexts } from "../src/manifest-locales.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const sources = (dir: string) =>
	readdirSync(join(root, dir))
		.filter((name) => name.endsWith(".ts"))
		.map((name) => join(dir, name));

/** Decision ids as the code declares them: the `id:` right after `defineDecision({`. */
function declaredDecisions(): string[] {
	const ids = new Set<string>();
	for (const path of [...sources("src/decisions"), ...sources("src/admission")]) {
		for (const match of read(path).matchAll(/defineDecision\(\{\s*(?:\/\/[^\n]*\n\s*)*id:\s*([^,\n]+),/g)) {
			const literal = /^"([^"]+)"$/.exec(match[1].trim());
			// A computed id (the test-log wordings) is listed under its default spelling.
			ids.add(literal ? literal[1] : "tool.admission.test-log");
		}
	}
	return [...ids].sort();
}

/** Feature names as the code reads their options: `runtime.options("<name>", …`. */
function declaredFeatures(): Map<string, string> {
	const found = new Map<string, string>();
	for (const path of sources("src/extension/features")) {
		const text = read(path);
		// Options of one feature can be read in several files (the swarm's model ladder is): all of them count.
		for (const match of text.matchAll(/runtime\.options\(\s*"([a-zA-Z]+)"/g)) {
			found.set(match[1], `${found.get(match[1]) ?? ""}\n${text}`);
		}
	}
	return found;
}

describe("harness manifest", () => {
	it("lists every decision the code declares, once, under a feature that exists", () => {
		const listed = MANIFEST.decisions.map((decision) => decision.id).sort();
		expect(listed).toEqual(declaredDecisions());
		expect(new Set(listed).size).toBe(listed.length);
		const features = new Set(MANIFEST.features.map((feature) => feature.name));
		for (const decision of MANIFEST.decisions) expect(features, decision.id).toContain(decision.feature);
	});

	it("lists every feature the code reads options for, and only options that code has", () => {
		const declared = declaredFeatures();
		expect(MANIFEST.features.map((feature) => feature.name).sort()).toEqual([...declared.keys()].sort());
		for (const feature of MANIFEST.features) {
			const text = declared.get(feature.name) ?? "";
			for (const option of feature.options) {
				expect(text, `${feature.name}.${option.key}`).toMatch(new RegExp(`\\b${option.key}:`));
			}
		}
	});

	it("says everything in both languages", () => {
		const texts = [
			...Object.values(MANIFEST.groups),
			...MANIFEST.modes.flatMap((mode) => [mode.label, mode.help]),
			...MANIFEST.decisions.flatMap((decision) => [decision.title, decision.summary]),
			...MANIFEST.features.flatMap((feature) => [
				feature.title,
				feature.summary,
				...feature.options.flatMap((option) => [option.label, ...(option.help ? [option.help] : [])]),
			]),
		];
		for (const text of texts) {
			expect(text.zh.trim().length, JSON.stringify(text)).toBeGreaterThan(0);
			expect(text.en.trim().length, JSON.stringify(text)).toBeGreaterThan(0);
			expect(/[一-鿿]/.test(text.zh), text.zh).toBe(true);
		}
	});

	it("says which decisions start other than active, as the kernel's defaults do", () => {
		const listed = Object.fromEntries(
			MANIFEST.decisions
				.filter((decision) => decision.defaultMode)
				.map((decision) => [decision.id, decision.defaultMode]),
		);
		const defaults = Object.fromEntries(Object.entries(DEFAULT_CONFIG.modes).filter(([id]) => id !== "default"));
		expect(listed).toEqual(defaults);
	});

	it("keeps manifest.json, which the desktop app reads, identical to the source and its translations", () => {
		const translations = JSON.parse(read("i18n/manifest.json")) as ManifestTranslations;
		const localized = localizeManifest(MANIFEST, translations).manifest;
		expect(read("manifest.json")).toBe(`${JSON.stringify(localized, null, "\t")}\n`);
	});
});

describe("the manifest in more languages", () => {
	const translations = (texts: ManifestTranslations["texts"]): ManifestTranslations => ({
		version: 1,
		locales: ["ja-JP", "de-DE"],
		texts,
	});

	it("finds each text by names, ids, keys and values, not by where it happens to be", () => {
		const paths = [...manifestTexts(MANIFEST).keys()];
		expect(paths).toContain("groups.input");
		expect(paths).toContain("modes[value=shadow].help");
		expect(paths).toContain("decisions[id=input.preflight].summary");
		expect(paths.some((path) => /^features\[name=[^\]]+\]\.options\[key=[^\]]+\]\.label$/.test(path))).toBe(true);
		expect(new Set(paths).size).toBe(paths.length);
	});

	it("adds a translation beside zh and en only while its English is the English of the text", () => {
		const shadow = MANIFEST.modes.find((mode) => mode.value === "shadow");
		const input = MANIFEST.groups.input;
		const result = localizeManifest(
			MANIFEST,
			translations({
				"modes[value=shadow].label": { en: shadow?.label.en ?? "", "ja-JP": "シャドー", "de-DE": "Schatten" },
				"groups.input": { en: "Input, as it was before", "ja-JP": "入力" },
				"features[name=gone].title": { en: "Gone", "ja-JP": "消えた" },
			}),
		);
		const manifest = result.manifest as typeof MANIFEST & {
			modes: { value: string; label: Record<string, string> }[];
		};
		expect(manifest.modes.find((mode) => mode.value === "shadow")?.label).toEqual({
			zh: shadow?.label.zh,
			en: shadow?.label.en,
			"ja-JP": "シャドー",
			"de-DE": "Schatten",
		});
		// Its English changed after it was translated: English until someone translates it again.
		expect(manifest.groups.input).toEqual(input);
		expect(result.stale).toEqual(["groups.input"]);
		expect(result.unused).toEqual(["features[name=gone].title"]);
		expect(result.untranslated.length).toBe(manifestTexts(MANIFEST).size - 2);
		// The source object is never changed.
		expect(Object.keys(MANIFEST.groups.input)).toEqual(["zh", "en"]);
	});
});
