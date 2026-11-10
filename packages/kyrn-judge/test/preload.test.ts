import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import type { DecisionMode } from "../src/decision.ts";
import { contextPreload } from "../src/decisions/context-preload.ts";
import { OUTCOME_ENTRY } from "../src/extension/features/permissions.ts";
import {
	namedPaths,
	PRELOAD_MESSAGE,
	type PreloadRead,
	projectFile,
	renderFiles,
} from "../src/extension/features/preload.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { LEDGER_ENTRY_TYPE } from "../src/extension/runtime.ts";
import type { LedgerRecord } from "../src/ledger.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer, JudgeRequest } from "../src/types.ts";

const sure: Answer = { type: "boolean", probability: 0.93 };
const unsure: Answer = { type: "boolean", probability: 0.6 };
const no: Answer = { type: "boolean", probability: 0.05 };

describe("what the preload decision does with the judge's answers", () => {
	it("brings in only the files the judge is sure of, the surest first", () => {
		const input = {
			task: "Fix the parser",
			paths: ["README.md", "src/parse.ts", "src/format.ts", "test/parse.test.ts"],
		};
		expect(contextPreload.questionsFor?.(input)).toMatchObject({
			file_1: { type: "boolean", instructions: "Will the agent have to read this file to do `task`? src/parse.ts" },
		});
		expect(contextPreload.buildState(input)).toEqual({ task: "Fix the parser" });
		expect(
			contextPreload.policy(
				{ file_0: no, file_1: { type: "boolean", probability: 0.97 }, file_2: unsure, file_3: sure },
				input,
			),
		).toEqual({
			read: [
				{ path: "src/parse.ts", probability: 0.97 },
				{ path: "test/parse.test.ts", probability: 0.93 },
			],
		});
		expect(contextPreload.fallback(input)).toEqual({ read: [] });
	});
});

describe("the files a preload may give", () => {
	const folders: string[] = [];
	afterEach(() => {
		while (folders.length > 0) rmSync(folders.pop() as string, { recursive: true, force: true });
	});
	const project = () => {
		const cwd = mkdtempSync(join(tmpdir(), "mu-preload-"));
		folders.push(cwd);
		mkdirSync(join(cwd, "src"));
		writeFileSync(join(cwd, "src", "parse.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
		writeFileSync(join(cwd, ".env"), "TOKEN=abc\n");
		writeFileSync(join(cwd, "logo.png"), "\u0000\u0001\u0002binary");
		return cwd;
	};

	it("finds the paths a message names", () => {
		expect(namedPaths("Fix src/parse.ts, then update README.md. See packages/ai/src and v2.")).toEqual([
			"src/parse.ts",
			"README.md",
			"packages/ai/src",
		]);
		expect(namedPaths("fix the parser")).toEqual([]);
	});

	it("takes a file of the project, and nothing outside it, no folder and no secret", () => {
		const cwd = project();
		expect(projectFile(cwd, "src/parse.ts")).toBe("src/parse.ts");
		expect(projectFile(cwd, join(cwd, "src", "parse.ts"))).toBe("src/parse.ts");
		expect(projectFile(cwd, "src")).toBeUndefined();
		expect(projectFile(cwd, "missing.ts")).toBeUndefined();
		expect(projectFile(cwd, "../outside.ts")).toBeUndefined();
		expect(projectFile(cwd, "/etc/hosts")).toBeUndefined();
		// There, and the user may even have named it: a key file is read when the agent asks for it.
		expect(projectFile(cwd, ".env")).toBeUndefined();
	});

	it("gives a file whole or from its start, says which lines a cut one holds, and skips what is not text", () => {
		const cwd = project();
		const whole = renderFiles(cwd, ["src/parse.ts", "logo.png", "missing.ts"], { fileChars: 1000, maxChars: 1000 });
		expect(whole?.paths).toEqual(["src/parse.ts"]);
		expect(whole?.text).toContain(
			'<file path="src/parse.ts" lines="3">\nexport const a = 1;\nexport const b = 2;\nexport const c = 3;\n</file>',
		);
		expect(whole?.text).toContain("not the user's words");
		expect(whole?.text).not.toContain("a file that is cut");

		const cut = renderFiles(cwd, ["src/parse.ts"], { fileChars: 45, maxChars: 1000 });
		expect(cut?.text).toContain(
			'<file path="src/parse.ts" lines="1-2 of 3">\nexport const a = 1;\nexport const b = 2;\n</file>',
		);
		expect(cut?.text).toContain("a file that is cut says which lines it holds");
		expect(renderFiles(cwd, ["logo.png"], { fileChars: 1000, maxChars: 1000 })).toBeUndefined();
	});
});

describe("preload at the opening of a session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** `read` and `edit` that answer without touching anything: what they were called with is the test's business. */
	const tool = (name: string): AgentTool => ({
		name,
		label: name,
		description: name,
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	});
	const call = (name: string, path: string) =>
		fauxAssistantMessage([fauxToolCall(name, { path })], { stopReason: "toolUse" });

	async function start(mode: DecisionMode | undefined, preload: Record<string, unknown> = {}) {
		const provider = new MockJudgeProvider((request: JudgeRequest): Record<string, Answer> => {
			const answers: Record<string, Answer> = {};
			for (const [id, question] of Object.entries(request.questions)) {
				if (id.startsWith("file_"))
					answers[id] = String(question.instructions).endsWith("src/parse.ts") ? sure : no;
			}
			return answers;
		});
		const harness = await createHarness({
			tools: [tool("read"), tool("edit")],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider,
					mode: "active",
					config: parseConfig({
						...(mode ? { modes: { "context.preload": mode } } : {}),
						// The harness runs in print mode, which preload leaves alone unless told otherwise.
						features: { preload: { unattended: true, ...preload } },
					}),
					only: ["preload"],
				}),
			],
		});
		harnesses.push(harness);
		mkdirSync(join(harness.tempDir, "src"));
		writeFileSync(join(harness.tempDir, "src", "parse.ts"), "export const parse = () => 1;\n");
		writeFileSync(join(harness.tempDir, "src", "format.ts"), "export const format = () => 2;\n");
		const custom = <T>(type: string): T[] =>
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === type)
				.map((entry) => (entry as { data: T }).data);
		return {
			harness,
			asked: () => provider.calls.filter((each) => Object.keys(each.questions).some((id) => id.startsWith("file_"))),
			given: () =>
				harness.session.messages.flatMap((message) =>
					message.role === "custom" && message.customType === PRELOAD_MESSAGE ? [String(message.content)] : [],
				),
			outcomes: () => custom<PreloadRead>(OUTCOME_ENTRY),
			records: () => custom<LedgerRecord>(LEDGER_ENTRY_TYPE).filter((record) => record.specId === contextPreload.id),
		};
	}
	const task = "The 1h30m case fails in src/parse.ts and src/format.ts looks related.";

	it("ships in shadow: the judge is asked, nothing is given, and what the opening read labels the verdict", async () => {
		const session = await start(undefined);
		session.harness.setResponses([
			call("read", "src/parse.ts"),
			call("read", "src/format.ts"),
			fauxAssistantMessage("Found it."),
		]);
		await session.harness.session.prompt(task);
		await vi.waitFor(() => expect(session.outcomes()).toHaveLength(1));

		expect(session.given()).toEqual([]);
		const [request] = session.asked();
		expect(request.state).toEqual({ task });
		expect(Object.values(request.questions).map((question) => question.instructions)).toEqual([
			"Will the agent have to read this file to do `task`? src/parse.ts",
			"Will the agent have to read this file to do `task`? src/format.ts",
		]);
		const [record] = session.records();
		expect(record).toMatchObject({ mode: "shadow", source: "fallback", outcome: { read: [] } });
		expect(record.judged).toEqual({ read: [{ path: "src/parse.ts", probability: 0.93 }] });
		// One file forecast, two read, the forecast one among them. Paths stay out of the session.
		expect(session.outcomes()).toEqual([
			{ kind: "preload", ledgerId: record.id, specId: "context.preload", predicted: 1, given: 0, read: 2, hits: 1 },
		]);
	});

	it("active: the files the judge is sure of go to the model with the first message, and only then", async () => {
		const session = await start("active");
		session.harness.setResponses([
			call("edit", "src/parse.ts"),
			fauxAssistantMessage("Fixed."),
			call("read", "src/format.ts"),
			fauxAssistantMessage("Looked."),
		]);
		await session.harness.session.prompt(task);
		await vi.waitFor(() => expect(session.outcomes()).toHaveLength(1));

		const [given] = session.given();
		expect(given).toContain('<file path="src/parse.ts" lines="1">\nexport const parse = () => 1;\n</file>');
		expect(given).not.toContain("format.ts");
		// It was given, so it is not read; editing it is what shows it was needed.
		expect(session.outcomes()[0]).toMatchObject({ predicted: 1, given: 1, read: 0, hits: 1 });

		// The opening is over: a later message brings nothing more, and asks nothing.
		await session.harness.session.prompt("Now look at src/format.ts.");
		expect(session.given()).toHaveLength(1);
		expect(session.asked()).toHaveLength(1);
		expect(session.outcomes()).toHaveLength(1);
	});

	it("asks nothing when it is off, when no file is a candidate, or in an unattended run left as it is", async () => {
		const off = await start("off");
		off.harness.setResponses([fauxAssistantMessage("Done.")]);
		await off.harness.session.prompt(task);
		expect(off.asked()).toEqual([]);

		const bare = await start("active");
		bare.harness.setResponses([fauxAssistantMessage("Hello.")]);
		await bare.harness.session.prompt("Good morning.");
		expect(bare.asked()).toEqual([]);
		expect(bare.given()).toEqual([]);

		const unattended = await start("active", { unattended: false });
		unattended.harness.setResponses([fauxAssistantMessage("Done.")]);
		await unattended.harness.session.prompt(task);
		expect(unattended.asked()).toEqual([]);
		expect(unattended.given()).toEqual([]);
	});
});
