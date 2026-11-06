import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, createTestUiContext, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import {
	configFile,
	FEATURE_OFFER_ENTRY,
	type FeatureOfferRecord,
	turnOn,
	worksHere,
} from "../src/extension/features/feature-offers.ts";
import { createKyrnJudgeExtension, type FeatureName } from "../src/extension/kyrn-judge.ts";
import type { KyrnPresentationEvent } from "../src/extension/presentation.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { JudgeRequest } from "../src/types.ts";
import { attended } from "./attended.ts";

const find = (args: Record<string, JsonValue>, id = "call-find") =>
	fauxAssistantMessage([fauxToolCall("find_capability", args, { id })], { stopReason: "toolUse" });

const results = (harness: Harness): string[] =>
	harness.session.messages
		.filter((message) => message.role === "toolResult")
		.map((message) => (message.content as { text?: string }[]).map((block) => block.text ?? "").join(""));

const records = (harness: Harness): FeatureOfferRecord[] =>
	harness.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === FEATURE_OFFER_ENTRY ? [entry.data as FeatureOfferRecord] : [],
		);

describe("offers of features that are off", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
	});

	/** mu's home with its agent folder, as loadConfig reads it. */
	function home(): { home: string; agentDir: string } {
		const root = mkdtempSync(join(tmpdir(), "mu-offers-"));
		dirs.push(root);
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		return { home: root, agentDir };
	}

	async function start(
		setup: {
			/** What the user picks in each select, by the start of the option; undefined for Esc. */
			picks?: (string | undefined)[];
			features?: Record<string, unknown>;
			only?: FeatureName[];
			noUi?: boolean;
			judged?: JudgeRequest[];
		} = {},
	) {
		const roots = home();
		const events: KyrnPresentationEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider((request) => {
						setup.judged?.push(request);
						return {};
					}),
					mode: "active",
					config: parseConfig({ features: attended({ memory: false, ...setup.features }) }),
					only: setup.only ?? ["catalog", "featureOffers"],
					roots,
					onPresentation: (event) => events.push(event),
				}),
			],
		});
		harnesses.push(harness);
		const picks = [...(setup.picks ?? [])];
		const asked: { title: string; options: string[] }[] = [];
		const notes: string[] = [];
		if (!setup.noUi) {
			const ui: ExtensionUIContext = createTestUiContext({
				select: async (title, options) => {
					asked.push({ title, options });
					const start = picks.shift();
					return start === undefined ? undefined : options.find((option) => option.startsWith(start));
				},
				input: async () => picks.shift(),
				notify: (message) => notes.push(message),
			});
			await harness.session.bindExtensions({ uiContext: ui, mode: "tui" });
		}
		return { harness, roots, asked, notes, events };
	}

	it("lists a feature that is off, and asks the user before turning it on for the next conversation", async () => {
		const { harness, roots, asked } = await start({
			picks: ["Turn it on"],
		});
		harness.setResponses([
			find({ query: "correction" }),
			find({ open: "feature:ttsr" }),
			fauxAssistantMessage("Turned on."),
		]);
		await harness.session.prompt("Stop the model when it writes something the rules forbid.");
		const [listed, opened] = results(harness);
		expect(listed).toContain("- feature:ttsr · Mid-stream correction:");
		expect(listed).toContain("Off now: opening it asks the user whether to turn it on, from the next conversation.");
		expect(asked).toEqual([expect.objectContaining({ title: "Feature: Turn on Mid-stream correction?" })]);
		expect(opened).toBe(
			`The user turned on Mid-stream correction (features.ttsr in ${join(roots.agentDir, "mu.json")}). It takes effect from the next conversation; this one goes on without it. Turning it on allows nothing beyond that feature.`,
		);
		expect(JSON.parse(readFileSync(join(roots.agentDir, "mu.json"), "utf8"))).toEqual({ features: { ttsr: true } });
		expect(records(harness)).toEqual([{ feature: "ttsr", answer: "on", by: "model" }]);
	});

	it("writes nothing on Not now, and does not offer it again in the conversation", async () => {
		const { harness, roots, asked } = await start({
			picks: ["Not now"],
		});
		harness.setResponses([
			find({ open: "feature:compaction" }),
			find({ open: "feature:compaction" }, "call-again"),
			fauxAssistantMessage("OK."),
		]);
		await harness.session.prompt("The context keeps filling up.");
		const [first, second] = results(harness);
		expect(first).toContain("The user declined Summary-free compaction, so it stays off.");
		expect(first).toContain("Do not offer it again in this conversation");
		expect(second).toContain("declined Summary-free compaction earlier in this conversation");
		expect(asked).toHaveLength(1);
		expect(existsSync(join(roots.agentDir, "mu.json"))).toBe(false);
		expect(records(harness)).toEqual([{ feature: "compaction", answer: "declined", by: "model" }]);
	});

	it("keeps the rest of the file the user has, kyrn.json included, and backs it up first", async () => {
		const { harness, roots } = await start();
		const legacy = join(roots.agentDir, "kyrn.json");
		writeFileSync(legacy, JSON.stringify({ tiers: ["jev"], features: { ttsr: { cooldownMs: 5 } } }));
		expect(configFile(roots.agentDir)).toBe(legacy);
		expect(turnOn(roots.agentDir, "ttsr", new Date("2026-11-05T10:00:00Z"))).toEqual({ file: legacy });
		expect(JSON.parse(readFileSync(legacy, "utf8"))).toEqual({
			tiers: ["jev"],
			features: { ttsr: { cooldownMs: 5, enabled: true } },
		});
		// No mu.json beside it: loadConfig reads the first of the two that exists, and would lose the rest.
		expect(existsSync(join(roots.agentDir, "mu.json"))).toBe(false);
		const backups = readdirSync(join(roots.home, "backups"));
		expect(backups).toHaveLength(1);
		expect(readdirSync(join(roots.home, "backups", backups[0]))).toEqual(["kyrn.json"]);
		harness.setResponses([fauxAssistantMessage("Hi.")]);
	});

	it("does not touch a file that is not plain JSON", () => {
		const roots = home();
		const file = join(roots.agentDir, "mu.json");
		writeFileSync(file, "{ // my settings\n }");
		expect(turnOn(roots.agentDir, "ttsr")).toEqual({ problem: `${file} is not plain JSON, so mu did not change it` });
		expect(readFileSync(file, "utf8")).toBe("{ // my settings\n }");
	});

	it("is not offered when it is on, and /capabilities open is the user asking, with no question", async () => {
		const on = await start({ features: { ttsr: true } });
		on.harness.setResponses([find({ query: "" }), fauxAssistantMessage("Listed.")]);
		await on.harness.session.prompt("What is there?");
		expect(results(on.harness)[0]).not.toContain("feature:ttsr");

		const { harness, roots, asked, notes } = await start();
		await harness.session.prompt("/capabilities open feature:compaction");
		expect(asked).toEqual([]);
		expect(notes.at(-1)).toContain("The user turned on Summary-free compaction");
		expect(JSON.parse(readFileSync(join(roots.agentDir, "mu.json"), "utf8"))).toEqual({
			features: { compaction: true },
		});
		await harness.session.prompt("/capabilities");
		expect(notes.at(-1)).toMatch(/on next conv\.\s+feature:compaction/);
		expect(notes.at(-1)).toMatch(/off\s+feature:ttsr/);
	});

	it("writes nothing where nobody can be asked", async () => {
		const { harness, roots } = await start({ noUi: true });
		harness.setResponses([find({ open: "feature:ttsr" }), fauxAssistantMessage("OK.")]);
		await harness.session.prompt("Correct the model as it writes.");
		expect(results(harness)[0]).toContain("only the user can turn it on; nobody can be asked in this session");
		expect(existsSync(join(roots.agentDir, "mu.json"))).toBe(false);
	});

	it("is never a candidate for the capability judge", async () => {
		const judged: JudgeRequest[] = [];
		const { harness } = await start({ judged, features: { catalog: { askUnattended: true } } });
		harness.setResponses([fauxAssistantMessage("Hi.")]);
		await harness.session.prompt("Hello.");
		// With only features hidden, there is nothing for it to choose from, and nobody is asked.
		expect(judged.filter((request) => JSON.stringify(request).includes("feature:"))).toEqual([]);
	});
});

describe("where a feature works", () => {
	it("needs a write floor for the sandbox, and nothing for the others", () => {
		expect(worksHere("ttsr", "win32")).toBe(true);
		expect(worksHere("confine", "darwin")).toBe(true);
		expect(worksHere("confine", "win32")).toBe(false);
		expect(worksHere("confine", "linux", "")).toBe(false);
	});
});
