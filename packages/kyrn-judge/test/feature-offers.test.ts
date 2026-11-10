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
		setup: { features?: Record<string, unknown>; only?: FeatureName[]; noUi?: boolean; judged?: JudgeRequest[] } = {},
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
		const asked: { title: string; options: string[] }[] = [];
		const notes: string[] = [];
		/** For each notice, the text of the message the conversation ended on when it was said. */
		const saidAfter: string[] = [];
		if (!setup.noUi) {
			const ui: ExtensionUIContext = createTestUiContext({
				select: async (title, options) => {
					asked.push({ title, options });
					return undefined;
				},
				notify: (message) => {
					notes.push(message);
					const last = harness.session.messages.at(-1);
					saidAfter.push(
						last?.role === "assistant"
							? (last.content as { text?: string }[]).map((block) => block.text ?? "").join("")
							: String(last?.role),
					);
				},
			});
			await harness.session.bindExtensions({ uiContext: ui, mode: "tui" });
		}
		return { harness, roots, asked, notes, saidAfter, events };
	}

	it("lists a feature that is off, does not hold the run for it, and tells the user when the run has ended", async () => {
		const { harness, roots, asked, notes, saidAfter } = await start();
		harness.setResponses([
			find({ query: "correction" }),
			find({ open: "feature:ttsr" }),
			fauxAssistantMessage("Done without it."),
		]);
		await harness.session.prompt("Stop the model when it writes something the rules forbid.");
		const [listed, opened] = results(harness);
		expect(listed).toContain("- feature:ttsr · Mid-stream correction:");
		expect(listed).toContain(
			"Off now, and only the user turns it on, from the next conversation: opening it tells them of it when this run ends.",
		);
		expect(opened).toBe(
			"Mid-stream correction is off, and turning it on takes effect only from the next conversation, so nothing changes in this run. mu tells the user of it when this run ends, and they decide. Carry on without it, and do not offer it again.",
		);
		// No question, in the run or after it: a notice takes no answer.
		expect(asked).toEqual([]);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("mu: the model suggests Mid-stream correction for work like this. It's off now.");
		expect(notes[0]).toContain("/capabilities open feature:ttsr turns it on, from the next session.");
		expect(saidAfter).toEqual(["Done without it."]);
		expect(existsSync(join(roots.agentDir, "mu.json"))).toBe(false);
		expect(records(harness)).toEqual([{ feature: "ttsr", answer: "offered", by: "model" }]);
	});

	it("offers a feature once in a conversation, and the command the notice names turns it on", async () => {
		const { harness, roots, notes } = await start();
		harness.setResponses([
			find({ open: "feature:compaction" }),
			find({ open: "feature:compaction" }, "call-again"),
			fauxAssistantMessage("OK."),
		]);
		await harness.session.prompt("The context keeps filling up.");
		const [first, second] = results(harness);
		expect(first).toContain("mu tells the user of it when this run ends");
		expect(second).toBe(
			"Summary-free compaction was already offered to the user in this conversation, and it is still off. Do not offer it again; carry on without it.",
		);
		expect(notes).toHaveLength(1);

		// In a later run of the conversation: the same answer, and nothing more is said to the user.
		harness.setResponses([find({ open: "feature:compaction" }, "call-later"), fauxAssistantMessage("OK.")]);
		await harness.session.prompt("It filled up again.");
		expect(results(harness)[2]).toContain("was already offered to the user in this conversation");
		expect(notes).toHaveLength(1);
		expect(existsSync(join(roots.agentDir, "mu.json"))).toBe(false);

		await harness.session.prompt("/capabilities open feature:compaction");
		expect(notes.at(-1)).toContain("The user turned on Summary-free compaction");
		expect(JSON.parse(readFileSync(join(roots.agentDir, "mu.json"), "utf8"))).toEqual({
			features: { compaction: true },
		});
		expect(records(harness)).toEqual([
			{ feature: "compaction", answer: "offered", by: "model" },
			{ feature: "compaction", answer: "on", by: "user" },
		]);
		harness.setResponses([find({ open: "feature:compaction" }, "call-on"), fauxAssistantMessage("OK.")]);
		await harness.session.prompt("And now?");
		expect(results(harness)[3]).toBe("Summary-free compaction is already turned on for the next conversation.");
	});

	it("says one notice for each feature offered in a run", async () => {
		const { harness, notes, saidAfter } = await start();
		harness.setResponses([
			find({ open: "feature:compaction" }),
			find({ open: "feature:ttsr" }, "call-second"),
			fauxAssistantMessage("Both would help."),
		]);
		await harness.session.prompt("Long task, strict rules.");
		expect(notes.map((note) => /feature:(\w+)/.exec(note)?.[1])).toEqual(["compaction", "ttsr"]);
		expect(saidAfter).toEqual(["Both would help.", "Both would help."]);
		expect(records(harness).map((record) => record.answer)).toEqual(["offered", "offered"]);
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

	it("says and writes nothing where nobody can be told", async () => {
		const { harness, roots } = await start({ noUi: true });
		harness.setResponses([find({ open: "feature:ttsr" }), fauxAssistantMessage("OK.")]);
		await harness.session.prompt("Correct the model as it writes.");
		expect(results(harness)[0]).toContain("only the user can turn it on; nobody can be told of it in this session");
		expect(existsSync(join(roots.agentDir, "mu.json"))).toBe(false);
		expect(records(harness)).toEqual([]);
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
