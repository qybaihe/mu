import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, createTestUiContext, type Harness } from "../../coding-agent/test/suite/harness.ts";
import type { Capability } from "../src/catalog/catalog.ts";
import { parseConfig } from "../src/config.ts";
import type { SwarmRunner } from "../src/extension/features/swarm.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import { CAPABILITIES_OPEN_ENV, inheritedNames, SKILLS_HIDDEN_ENV } from "../src/swarm/brief.ts";
import type { Answer, JudgeRequest } from "../src/types.ts";
import { attended } from "./attended.ts";

const yes: Answer = { type: "boolean", probability: 0.96 };
const no: Answer = { type: "boolean", probability: 0.03 };

/** The skills the prompt lists, in order: the judge here keeps the first two and hides the last two. */
const SKILLS = ["calendar", "invoices", "slideshow", "forecast"];
const HIDDEN = ["slideshow", "forecast"];

const pack = (id: string, tool: string): Capability => ({
	id,
	kind: "pack",
	title: id,
	description: `What ${id} does`,
	tools: [tool],
	exposure: "judged",
});
const PACKS = [pack("pack:debugger", "debug_start"), pack("pack:ast-grep", "sg")];

function tool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}

/** The tools a request declares: what its system messages add, less what they take away. */
function declared(messages: readonly Message[]): string[] {
	const tools = new Set<string>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const added of message.toolsAdded ?? []) tools.add(added.name);
		for (const removed of message.toolsRemoved ?? []) tools.delete(removed.name);
	}
	return [...tools];
}

/** Which of the two disclosure questions the judge was asked. */
function asked(calls: readonly JudgeRequest[]): string[] {
	const kinds = new Set<string>();
	for (const call of calls) {
		const questions = Object.keys(call.questions);
		if (questions.some((id) => id.startsWith("skill_"))) kinds.add("skills.disclosure");
		if (questions.some((id) => id.startsWith("capability_"))) kinds.add("capability.disclosure");
	}
	return [...kinds].sort();
}

/** Keeps calendar and invoices, hides slideshow and forecast, and opens the debugger (the first pack). */
const verdicts: MockResponder = (request): Record<string, Answer> => {
	const answers: Record<string, Answer> = {};
	for (const id of Object.keys(request.questions)) {
		if (id.startsWith("skill_")) answers[id] = Number(id.slice(6)) < 2 ? yes : no;
		if (id.startsWith("capability_")) answers[id] = id === "capability_0" ? yes : no;
	}
	return answers;
};

describe("a sub-agent takes its parent's skills and capabilities", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];
	afterEach(() => {
		vi.unstubAllEnvs();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
	});

	async function start(
		mode: "tui" | "json",
		responder: MockResponder,
		setup: { features?: Record<string, unknown>; modes?: Record<string, string>; runner?: SwarmRunner } = {},
	) {
		const provider = new MockJudgeProvider(responder);
		const skills = mkdtempSync(join(tmpdir(), "mu-inherit-"));
		dirs.push(skills);
		const harness = await createHarness({
			tools: [tool("bash"), tool("debug_start"), tool("sg")],
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						event.systemPromptOptions.skills = SKILLS.map((name) => ({
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
					only: ["preflight", "skills", "catalog", "swarm", "hive", "permissions"],
					config: parseConfig({
						modes: setup.modes,
						features: attended({
							permissions: { mode: "full" },
							swarm: { isolation: "none", agentsDir: skills },
							...setup.features,
						}),
					}),
					capabilities: PACKS,
					swarmRunner: setup.runner,
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions(mode === "json" ? { mode } : { uiContext: createTestUiContext(), mode });
		return { harness, provider };
	}

	/** A parent that delegates one task and starts a hive of two, and what each child was handed. */
	async function parent(responder: MockResponder, features?: Record<string, unknown>) {
		const handed: Record<string, string>[] = [];
		const { harness } = await start("tui", responder, {
			features,
			runner: async (task, _assignment, _signal, env) => {
				handed.push({ ...env });
				return `${task.title}: done`;
			},
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", { tasks: [{ title: "a", instructions: "Do a" }] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[
					fauxToolCall("hive", {
						goal: "Why does login fail?",
						bees: [
							{ name: "where", focus: "Where login is implemented" },
							{ name: "run", focus: "What the login tests show" },
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("Fix the login.");
		return handed;
	}

	it("the parent passes the skills it hid and the capabilities it opened to each sub-agent and bee", async () => {
		const handed = await parent(verdicts);
		expect(handed).toHaveLength(3);
		for (const env of handed) {
			expect(JSON.parse(env[SKILLS_HIDDEN_ENV])).toEqual(HIDDEN);
			expect(JSON.parse(env[CAPABILITIES_OPEN_ENV])).toEqual(["pack:debugger"]);
		}
	});

	it("passes nothing with the options off, and no skills while the first verdict is still on its way", async () => {
		const off = await parent(verdicts, {
			skills: { subagentsInherit: false },
			catalog: { subagentsInherit: false },
		});
		expect(off).toHaveLength(3);
		for (const env of off) {
			expect(env).not.toHaveProperty(SKILLS_HIDDEN_ENV);
			expect(env).not.toHaveProperty(CAPABILITIES_OPEN_ENV);
		}

		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const late = await parent(
			async (request) => {
				if (Object.keys(request.questions).some((id) => id.startsWith("skill_"))) await held;
				return verdicts(request);
			},
			{ skills: { waitMs: 50 } },
		);
		release();
		for (const env of late) {
			expect(env).not.toHaveProperty(SKILLS_HIDDEN_ENV);
			expect(JSON.parse(env[CAPABILITIES_OPEN_ENV])).toEqual(["pack:debugger"]);
		}
	});

	it("a child with its parent's answers asks neither question, hides what the parent hid and opens what it opened", async () => {
		vi.stubEnv("KYRN_SWARM_DEPTH", "1");
		vi.stubEnv(SKILLS_HIDDEN_ENV, JSON.stringify(HIDDEN));
		vi.stubEnv(CAPABILITIES_OPEN_ENV, JSON.stringify(["pack:debugger"]));
		// Its own modes would show every skill and capability: the parent's answer holds all the same.
		for (const modes of [undefined, { "skills.disclosure": "off", "capability.disclosure": "off" }]) {
			const { harness, provider } = await start("json", verdicts, { modes });
			let first: readonly Message[] = [];
			harness.setResponses([
				(context) => {
					first = context.messages;
					return fauxAssistantMessage("Done.");
				},
			]);
			await harness.session.prompt("Task: do a");

			expect(asked(provider.calls)).toEqual([]);
			const text = JSON.stringify(first);
			for (const name of SKILLS) expect(text.includes(`What ${name} does`), name).toBe(!HIDDEN.includes(name));
			const tools = declared(first);
			expect(tools).toContain("debug_start");
			expect(tools).not.toContain("sg");
		}
	});

	it("a child without them asks as before", async () => {
		vi.stubEnv("KYRN_SWARM_DEPTH", "1");
		const { harness, provider } = await start("json", verdicts);
		let first: readonly Message[] = [];
		harness.setResponses([
			(context) => {
				first = context.messages;
				return fauxAssistantMessage("Done.");
			},
		]);
		await harness.session.prompt("Task: do a");

		expect(asked(provider.calls)).toEqual(["capability.disclosure", "skills.disclosure"]);
		const text = JSON.stringify(first);
		for (const name of SKILLS) expect(text.includes(`What ${name} does`), name).toBe(!HIDDEN.includes(name));
		expect(declared(first)).toContain("debug_start");
	});

	it("reads only a list of names, and only inside a sub-agent", () => {
		expect(inheritedNames(SKILLS_HIDDEN_ENV, { [SKILLS_HIDDEN_ENV]: '["a"]' })).toBeUndefined();
		const child = (raw: string) =>
			inheritedNames(SKILLS_HIDDEN_ENV, { KYRN_SWARM_DEPTH: "1", [SKILLS_HIDDEN_ENV]: raw });
		expect(child('["a","b"]')).toEqual(new Set(["a", "b"]));
		expect(child("[]")).toEqual(new Set());
		expect(child('{"a":1}')).toBeUndefined();
		expect(child("[1]")).toBeUndefined();
		expect(child("not json")).toBeUndefined();
		expect(inheritedNames(SKILLS_HIDDEN_ENV, { KYRN_SWARM_DEPTH: "1" })).toBeUndefined();
	});
});
