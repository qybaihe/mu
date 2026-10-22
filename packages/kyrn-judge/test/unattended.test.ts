import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, createTestUiContext, type Harness } from "../../coding-agent/test/suite/harness.ts";
import type { Capability } from "../src/catalog/catalog.ts";
import { parseConfig } from "../src/config.ts";
import { UNATTENDED_HIDDEN } from "../src/extension/features/catalog.ts";
import type { SwarmRunner } from "../src/extension/features/swarm.ts";
import { isUnattended } from "../src/extension/features/unattended.ts";
import { IDENTITY, leanDocs, leanIdentity } from "../src/extension/features/welcome.ts";
import { createKyrnJudgeExtension, type FeatureName } from "../src/extension/kyrn-judge.ts";
import { MANIFEST } from "../src/manifest.ts";
import type { StoredLesson } from "../src/memory/store.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import type { Answer, JudgeRequest } from "../src/types.ts";

const LEFT_OUT = [
	"delegate",
	"apply_patch_from",
	"browse",
	"locate",
	"remember",
	"find_skill",
	"find_capability",
	"hive",
];
const KEPT = ["todo", "bg_start", "bg_output", "bg_stop", "web_fetch", "web_search", "bash"];

type Mode = "print" | "json" | "tui" | "rpc";

const yes: Answer = { type: "boolean", probability: 0.95 };
const pick = (choice: string): Answer => ({ type: "choice", choice, probabilities: { [choice]: 0.95 } });

const dirs: string[] = [];
const temp = () => {
	const dir = mkdtempSync(join(tmpdir(), "mu-unattended-"));
	dirs.push(dir);
	return dir;
};

function tool(name: string, run: (params: Record<string, unknown>) => string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async (_id, params) => ({
			content: [{ type: "text", text: run((params ?? {}) as Record<string, unknown>) }],
			details: {},
		}),
	};
}

const bash = () => tool("bash", (params) => (String(params.command).includes("npm test") ? "" : "ok"));
const run = (command: string) => fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });

/** The tools a request declares: what its system messages add, less what they take away, in order. */
function declared(messages: readonly Message[]): string[] {
	const tools = new Set<string>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const added of message.toolsAdded ?? []) tools.add(added.name);
		for (const removed of message.toolsRemoved ?? []) tools.delete(removed.name);
	}
	return [...tools];
}

/** A section of the request's system prompt, without its tags. */
function section(messages: readonly Message[], name: string): string | undefined {
	for (const message of messages) {
		if (message.role !== "system") continue;
		const text = message.sections?.[name];
		if (text) return text.slice(`<${name}>\n`.length, -`\n</${name}>`.length);
	}
	return undefined;
}

/** What a request tells the model about itself: the system prompt's sections and each tool's description. */
function told(messages: readonly Message[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role !== "system") continue;
		parts.push(...Object.values(message.sections ?? {}).filter((text): text is string => typeof text === "string"));
		for (const tool of message.toolsAdded ?? []) parts.push(`${tool.name}: ${tool.description}`);
	}
	return parts.join("\n");
}

const description = (messages: readonly Message[], name: string) =>
	messages
		.flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []) : []))
		.find((tool) => tool.name === name)?.description;

/** The judge's questions, one name per request: what it was asked about. */
function asked(calls: readonly JudgeRequest[]): Set<string> {
	const kinds = new Set<string>();
	for (const call of calls) {
		const questions = Object.keys(call.questions);
		if (questions.includes("turn_type")) kinds.add("input.preflight");
		if (questions.some((id) => id.startsWith("capability_"))) kinds.add("capability.disclosure");
		if (questions.includes("course")) kinds.add("turn.drift");
		if (questions.includes("kind") && "turn_digest" in (call.state as Record<string, unknown>))
			kinds.add("skill.capture");
		if (questions.includes("way_out")) kinds.add("memory.outcome");
		if (questions.some((id) => id.startsWith("worth_"))) kinds.add("memory.worth");
	}
	return kinds;
}

const debuggerPack: Capability = {
	id: "pack:debugger",
	kind: "pack",
	title: "Debugger",
	description: "Step through a program",
	tools: ["debug_start"],
	exposure: "judged",
};

const EVERYTHING: FeatureName[] = [
	"preflight",
	"frame",
	"memory",
	"procedures",
	"skills",
	"catalog",
	"monitor",
	"swarm",
	"hive",
	"tools",
	"browser",
	"background",
	"web",
];

describe("an unattended run (mu --print, json mode)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.unstubAllEnvs();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
	});

	async function start(
		mode: Mode,
		responder: MockResponder,
		setup: { features?: Record<string, unknown>; runner?: SwarmRunner; lessons?: string } = {},
	) {
		const provider = new MockJudgeProvider(responder);
		const skills = temp();
		const harness = await createHarness({
			tools: [bash(), tool("debug_start", () => "started")],
			extensionFactories: [
				// The skills the prompt lists, as pi would have found them: mu's own browser skill and one of the user's.
				(pi) => {
					pi.on("before_agent_start", (event) => {
						event.systemPromptOptions.skills = ["mu-browser", "calendar"].map((name) => ({
							name,
							description: `What ${name} does`,
							filePath: join(skills, name, "SKILL.md"),
							baseDir: join(skills, name),
							sourceInfo: { path: skills, source: "test", scope: "temporary", origin: "top-level" },
							disableModelInvocation: false,
						}));
					});
				},
				createKyrnJudgeExtension({
					provider,
					mode: "active",
					config: parseConfig({
						features: {
							procedures: { path: temp() },
							memory: { path: setup.lessons ?? join(temp(), "lessons.jsonl") },
							swarm: { isolation: "none", agentsDir: temp() },
							...setup.features,
						},
					}),
					only: EVERYTHING,
					capabilities: [debuggerPack],
					swarmRunner: setup.runner,
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions(
			mode === "print" || mode === "json" ? { mode } : { uiContext: createTestUiContext(), mode },
		);
		return { harness, provider };
	}

	/** Seven steps, two of them commands, ending well: long enough for the drift check and for skill capture. */
	const longRun = (seen: { first?: readonly Message[] }): FauxResponseFactory[] => {
		const agent = [
			...["ls", "cat package.json", "npm ci", "npx vitest --run", "git status", "git diff", "git log -1"].map(run),
			fauxAssistantMessage("Done: the tests pass."),
		];
		return Array.from({ length: agent.length + 2 }, () => (context) => {
			seen.first ??= context.messages;
			return agent.shift() ?? fauxAssistantMessage("no more agent replies");
		});
	};

	const answers: MockResponder = (request): Record<string, Answer> => {
		if ("course" in request.questions) return { course: pick("on_track") };
		if ("kind" in request.questions) return { kind: pick("one_off") };
		return {};
	};

	it("leaves the listed tools and the mu-browser skill out of the request, and asks no preflight, capability, drift or skill question", async () => {
		for (const mode of ["print", "json"] as const) {
			const { harness, provider } = await start(mode, answers);
			const seen: { first?: readonly Message[] } = {};
			harness.setResponses(longRun(seen));
			await harness.session.prompt("Make the tests pass.");
			await new Promise((resolve) => setTimeout(resolve, 50));

			const tools = declared(seen.first ?? []);
			for (const name of LEFT_OUT) expect(tools, `${mode}: ${name}`).not.toContain(name);
			for (const name of KEPT) expect(tools, `${mode}: ${name}`).toContain(name);
			// Packs stay hidden, as in any run: no judge opens them, and the model has no way in.
			expect(tools).not.toContain("debug_start");
			expect(JSON.stringify(seen.first)).not.toContain("mu-browser");
			expect(JSON.stringify(seen.first)).toContain("calendar");
			expect([...asked(provider.calls)]).toEqual([]);
		}
	});

	it("keeps all of it in an interactive or desktop session", async () => {
		for (const mode of ["tui", "rpc"] as const) {
			const { harness, provider } = await start(mode, answers);
			const seen: { first?: readonly Message[] } = {};
			harness.setResponses(longRun(seen));
			await harness.session.prompt("Make the tests pass.");

			const tools = declared(seen.first ?? []);
			for (const name of [...LEFT_OUT, ...KEPT]) expect(tools, `${mode}: ${name}`).toContain(name);
			expect(JSON.stringify(seen.first)).toContain("mu-browser");
			// turn.drift only records by default, and still asks.
			await vi.waitFor(() =>
				expect([...asked(provider.calls)].sort()).toEqual([
					"capability.disclosure",
					"input.preflight",
					"skill.capture",
					"turn.drift",
				]),
			);
		}
	});

	it("turns each part back on with its option", async () => {
		const { harness, provider } = await start("print", answers, {
			features: {
				preflight: { unattended: true },
				catalog: { askUnattended: true, unattendedHidden: ["browse"] },
				monitor: { unattended: true },
				procedures: { path: temp(), unattended: true },
			},
		});
		const seen: { first?: readonly Message[] } = {};
		harness.setResponses(longRun(seen));
		await harness.session.prompt("Make the tests pass.");

		const tools = declared(seen.first ?? []);
		expect(tools).not.toContain("browse");
		for (const name of LEFT_OUT.filter((name) => name !== "browse")) expect(tools).toContain(name);
		expect(JSON.stringify(seen.first)).toContain("mu-browser");
		await vi.waitFor(() =>
			expect([...asked(provider.calls)].sort()).toEqual([
				"capability.disclosure",
				"input.preflight",
				"skill.capture",
				"turn.drift",
			]),
		);
	});

	it('keeps the hive for `mu -p "/hive …"`: the person called for it', async () => {
		const { harness } = await start("print", () => ({}));
		const seen: { first?: readonly Message[] } = {};
		harness.setResponses([
			(context) => {
				seen.first ??= context.messages;
				return fauxAssistantMessage("No hive needed after all.");
			},
		]);
		await harness.session.prompt("/hive why does login fail only in CI?");

		const tools = declared(seen.first ?? []);
		expect(tools).toContain("hive");
		expect(tools).not.toContain("delegate");
	});

	it("reads kept lessons and learns no new ones", async () => {
		const lessons = join(temp(), "lessons.jsonl");
		const { harness, provider } = await start(
			"print",
			(request): Record<string, Answer> => {
				if ("lesson_0" in request.questions) return { lesson_0: yes };
				if ("way_out" in request.questions) return { way_out: yes };
				if (Object.keys(request.questions).some((id) => id.startsWith("worth_")))
					return { worth_1: pick("reusable") };
				return {};
			},
			{
				lessons,
				// The delegate tool is left out of a print run; this run gets it, to show its lessons are not kept.
				features: { catalog: { unattendedHidden: [] } },
				runner: async () => "Done.\nLesson: when the report page is slow -> flush the cache before measuring",
			},
		);
		const kept: StoredLesson = {
			id: "kept",
			kind: "correction",
			trigger: "when the tests are run",
			lesson: "Run the tests with npx vitest --run.",
			scope: { cwd: harness.tempDir },
			source: { origin: "user" },
			status: "active",
			uses: { recalled: 0, applied: 0 },
			created: "2026-10-01T00:00:00.000Z",
			updated: "2026-10-01T00:00:00.000Z",
		};
		writeFileSync(lessons, `${JSON.stringify(kept)}\n`);
		let seen = "";
		harness.setResponses([
			(context) => {
				seen = JSON.stringify(context.messages);
				return run("npm test");
			},
			run("npm test"),
			run("npm test"),
			fauxAssistantMessage(
				[fauxToolCall("delegate", { tasks: [{ title: "measure", instructions: "Measure the report page" }] })],
				{ stopReason: "toolUse" },
			),
			run("npx vitest --run"),
			fauxAssistantMessage("The tests pass with npx vitest --run."),
		]);
		await harness.session.prompt("Run the tests.");
		await new Promise((resolve) => setTimeout(resolve, 50));

		// The kept lesson was read and brought in.
		expect(seen).toContain("Run the tests with npx vitest --run.");
		// A loop the run got out of, and a sub-agent's Lesson: line: neither is asked about, nothing is written.
		expect(asked(provider.calls).has("memory.outcome")).toBe(false);
		expect(asked(provider.calls).has("memory.worth")).toBe(false);
		// The recall was counted on the kept lesson; no other lesson was written.
		const lines = readFileSync(lessons, "utf8").trim().split("\n");
		expect(new Set(lines.map((line) => (JSON.parse(line) as { id: string }).id))).toEqual(new Set(["kept"]));
	});

	/** The first request of a run that does nothing but answer. */
	async function firstRequest(mode: Mode, features?: Record<string, unknown>): Promise<readonly Message[]> {
		const { harness } = await start(mode, () => ({}), { features });
		let first: readonly Message[] = [];
		harness.setResponses([
			(context) => {
				first = context.messages;
				return fauxAssistantMessage("Done.");
			},
		]);
		await harness.session.prompt("Make the tests pass.");
		return first;
	}

	it("tells the model less about mu, points at the docs in one line and names no tool it left out, in a sub-agent too", async () => {
		for (const mode of ["print", "json"] as const) {
			const first = await firstRequest(mode);
			expect(section(first, "mu"), mode).toBe(leanIdentity(true));
			expect(section(first, "docs"), mode).toBe(leanDocs());
			expect(description(first, "web_fetch"), mode).not.toContain("browse");
			// Nothing in the prompt or in a tool's description sends the model to a tool it does not have.
			for (const name of LEFT_OUT) expect(told(first), `${mode}: ${name}`).not.toMatch(new RegExp(`\\b${name}\\b`));
		}
		// No commands to type, no reply to act on, no hints before a turn.
		expect(leanIdentity(true)).not.toMatch(/\/help|replies|hints/);
		expect(leanIdentity(false)).not.toContain("tool output");

		vi.stubEnv("KYRN_SWARM_DEPTH", "1");
		const child = await firstRequest("json");
		expect(section(child, "mu")).toBe(leanIdentity(true));
		expect(section(child, "docs")).toBe(leanDocs());
		// A sub-agent keeps the browse tool, and web_fetch still points at it.
		expect(description(child, "web_fetch")).toContain("use browse");
	});

	it("keeps the full identity and pi's docs in an interactive or desktop session, and with welcome.unattended", async () => {
		for (const mode of ["tui", "rpc"] as const) {
			const first = await firstRequest(mode);
			expect(section(first, "mu"), mode).toBe(IDENTITY);
			expect(section(first, "docs"), mode).toContain("Pi documentation");
			expect(description(first, "web_fetch"), mode).toContain("use browse");
		}
		const full = await firstRequest("print", { welcome: { unattended: true } });
		expect(section(full, "mu")).toBe(IDENTITY);
		expect(section(full, "docs")).toContain("Pi documentation");
	});

	it("is not what a sub-agent runs, though it runs in json mode", () => {
		expect(isUnattended({ mode: "print" })).toBe(true);
		expect(isUnattended({ mode: "json" })).toBe(true);
		expect(isUnattended({ mode: "tui" })).toBe(false);
		expect(isUnattended({ mode: "rpc" })).toBe(false);
		expect(isUnattended(undefined)).toBe(false);
		vi.stubEnv("KYRN_SWARM_DEPTH", "1");
		expect(isUnattended({ mode: "json" })).toBe(false);
	});

	it("lists the same names in the manifest as in the code", () => {
		const option = MANIFEST.features
			.find((feature) => feature.name === "catalog")
			?.options.find((candidate) => candidate.key === "unattendedHidden");
		expect(option?.default).toEqual(UNATTENDED_HIDDEN);
		expect(UNATTENDED_HIDDEN).toEqual([...LEFT_OUT, "mu-browser"]);
	});
});
