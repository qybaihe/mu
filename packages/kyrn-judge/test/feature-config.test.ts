import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { featureConfigProblems, featureOptions, parseConfig } from "../src/config.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { MANIFEST } from "../src/manifest.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";

const read = new Map<string, Record<string, unknown>>([
	["skills", { enabled: true, askEarly: false }],
	["watchdog", { enabled: true, thinkingMs: 600_000, maxCuts: 2 }],
	["confine", { enabled: false, writable: [] as string[] }],
	["packs", { enabled: true, debugAdapters: undefined }],
]);

describe("features in mu.json", () => {
	it("names a feature mu does not have, an option a feature does not have, and a value of the wrong kind", () => {
		expect(
			featureConfigProblems(
				{
					skils: { enabled: false },
					skills: { enabled: "false", askEarley: true },
					watchdog: { thinkingMs: "300000", maxCuts: 1 },
					confine: "on",
					packs: { debugAdapters: { mine: { command: "x" } } },
				},
				read,
			),
		).toEqual([
			"features.skils: mu has no feature by that name, so it does nothing. Did you mean skills?",
			'features.skills.enabled is text ("false"), where it takes a boolean: mu uses its default, true.',
			"features.skills.askEarley: skills has no such option, so it does nothing. Did you mean askEarly?",
			'features.watchdog.thinkingMs is text ("300000"), where it takes a number: mu uses its default, 600000.',
			"features.confine is text: it takes true, false or an object of its options.",
		]);
		// true and false switch a feature on and off; an option whose default is nothing takes anything.
		expect(featureConfigProblems({ skills: false, watchdog: true, packs: { debugAdapters: [1] } }, read)).toEqual([]);
	});

	it("keeps an option's default where mu.json gives a value of another kind", () => {
		const config = parseConfig({
			features: { skills: { enabled: "false", askEarly: true }, watchdog: { thinkingMs: "300" } },
		});
		expect(featureOptions(config, "skills", { enabled: true, askEarly: false })).toEqual({
			enabled: true,
			askEarly: true,
		});
		expect(featureOptions(config, "watchdog", { enabled: true, thinkingMs: 600_000 })).toEqual({
			enabled: true,
			thinkingMs: 600_000,
		});
	});

	describe("in a session", () => {
		const harnesses: Harness[] = [];
		afterEach(() => {
			while (harnesses.length > 0) harnesses.pop()?.cleanup();
		});

		/** The notices a session with these features gives when it starts. */
		async function startWith(features: Record<string, unknown>) {
			const harness = await createHarness({
				extensionFactories: [
					createKyrnJudgeExtension({
						provider: new MockJudgeProvider(() => ({})),
						mode: "off",
						config: parseConfig({ features }),
					}),
				],
			});
			harnesses.push(harness);
			const notes: string[] = [];
			const known: Record<string, unknown> = {
				notify: (message: string) => notes.push(message),
				setStatus: () => undefined,
			};
			const ui = new Proxy(known, {
				get: (target, key) => (key in target ? target[key as string] : () => undefined),
			}) as unknown as ExtensionUIContext;
			await harness.session.bindExtensions({ uiContext: ui, mode: "rpc" });
			return { harness, notes };
		}

		it("takes every option the settings pages write, each at its default", async () => {
			// What the desktop app's settings write to mu.json: each feature, each option the manifest lists.
			const features = Object.fromEntries(
				MANIFEST.features.map((feature) => [
					feature.name,
					Object.fromEntries([
						["enabled", feature.defaultEnabled],
						...feature.options.map((option) => [option.key, option.default]),
					]),
				]),
			);
			const { notes } = await startWith({ ...features, memory: false });
			expect(notes.filter((note) => note.startsWith("mu.json:"))).toEqual([]);
		});

		it("checks against what every feature reads, says so when the session starts, and lists it in /doctor", async () => {
			const harness = await createHarness({
				extensionFactories: [
					createKyrnJudgeExtension({
						provider: new MockJudgeProvider(() => ({})),
						mode: "off",
						config: parseConfig({
							features: { memory: false, watchdgo: { thinkingMs: 1000 }, admission: { enabled: true } },
						}),
					}),
				],
			});
			harnesses.push(harness);
			const notes: string[] = [];
			const known: Record<string, unknown> = {
				notify: (message: string) => notes.push(message),
				setStatus: () => undefined,
			};
			const ui = new Proxy(known, {
				get: (target, key) => (key in target ? target[key as string] : () => undefined),
			}) as unknown as ExtensionUIContext;
			await harness.session.bindExtensions({ uiContext: ui, mode: "rpc" });
			const warning = notes.find((note) => note.startsWith("mu.json:"));
			expect(warning).toBe(
				"mu.json: a setting under features does nothing as written. features.watchdgo: mu has no feature by that name, so it does nothing. Did you mean watchdog?",
			);

			const shown: string[] = [];
			await harness.session.extensionRunner.getCommand("doctor")?.handler("", {
				cwd: harness.tempDir,
				hasUI: true,
				model: harness.getModel(),
				modelRegistry: { getAvailable: () => [], find: () => undefined },
				getContextUsage: () => undefined,
				ui: { notify: (message: string) => shown.push(message), setStatus: () => {} },
			} as never);
			expect(shown.join("\n")).toContain("features.watchdgo: mu has no feature by that name");
		});
	});
});
