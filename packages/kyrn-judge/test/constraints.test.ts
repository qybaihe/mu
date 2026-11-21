import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import type { DecisionMode } from "../src/decision.ts";
import { toolConstraint } from "../src/decisions/tool-constraint.ts";
import { constraintInput, describeCall } from "../src/extension/features/constraints.ts";
import { FRAME_ENTRY } from "../src/extension/features/frame.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { LEDGER_ENTRY_TYPE } from "../src/extension/runtime.ts";
import { constraintId, createFrame, inheritConstraints, parseInheritedConstraints } from "../src/frame/frame.ts";
import type { LedgerRecord } from "../src/ledger.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";

const choice = (option: "violates" | "compatible" | "unclear", probability = 0.97): Answer => ({
	type: "choice",
	choice: option,
	probabilities: { [option]: probability },
});

describe("hard constraints on tool calls", () => {
	const harnesses: Harness[] = [];
	const ran: string[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		ran.length = 0;
		delete process.env.KYRN_SWARM_CONSTRAINTS;
		vi.unstubAllEnvs();
	});

	function tool(name: string): AgentTool {
		return {
			name,
			label: name,
			description: name,
			parameters: Type.Object({}, { additionalProperties: true }),
			execute: async (_id, params) => {
				ran.push(`${name}:${JSON.stringify(params)}`);
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
	}

	async function start(
		responder: MockResponder,
		{
			mode = "active",
			constraints = {},
			recordState = false,
			rules = ["先别修改数据库相关的文件"],
			refuseAfterConstraints,
		}: {
			mode?: DecisionMode;
			constraints?: Record<string, unknown>;
			recordState?: boolean;
			rules?: string[];
			refuseAfterConstraints?: string;
		} = {},
	) {
		// A subagent's frame starts with what its parent was told: the shortest way to a frame with a constraint.
		process.env.KYRN_SWARM_CONSTRAINTS = JSON.stringify(rules);
		const provider = new MockJudgeProvider(responder);
		const harness = await createHarness({
			tools: [tool("edit"), tool("read"), tool("bash")],
			extensionFactories: [
				(pi) =>
					createKyrnJudgeExtension({
						provider,
						mode,
						config: parseConfig({ recordState, features: { memory: false, constraints } }),
						only: ["preflight", "frame", "constraints", ...(refuseAfterConstraints ? ["recovery" as const] : [])],
						trace(part) {
							if (part === "recovery" && refuseAfterConstraints)
								pi.on(
									"tool_call",
									(event) =>
										event.toolCallId === refuseAfterConstraints
											? { block: true, reason: "A later gate refused this call." }
											: undefined,
									{ final: true },
								);
						},
					})(pi),
			],
		});
		harnesses.push(harness);
		return { harness, provider };
	}
	const verdict =
		(answer: Answer | undefined): MockResponder =>
		(request): Record<string, Answer> =>
			answer && "constraint_0" in request.questions ? { constraint_0: answer } : {};
	const edit = (path: string) =>
		fauxAssistantMessage([fauxToolCall("edit", { path, edits: [{ oldText: "before", newText: "after" }] })], {
			stopReason: "toolUse",
		});

	it("lets a batched spec edit run when a completed rename is still in the restored frame", async () => {
		const rename = "Rename agents.md to AGENTS.md";
		// Session call 625: three replacements in `collage-spec.md`. The spec text here is synthetic.
		const input = {
			path: "collage-spec.md",
			edits: [
				{ oldText: "Use two tiles per row.", newText: "Use three tiles per row." },
				{ oldText: "Gap: 4 px.", newText: "Gap: 8 px on desktop." },
				{ oldText: "Export a PDF.", newText: "Export a PDF and a preview." },
			],
		};
		const sessionManager = SessionManager.inMemory();
		const entryId = sessionManager.appendMessage({ role: "user", content: rename, timestamp: 0 });
		const frame = {
			...createFrame({ turn: 1, text: "Update the collage website" }),
			version: 2,
			updatedTurn: 18,
			source: "writer" as const,
			currentSubgoal: rename,
			constraints: [{ text: rename, source: { turn: 18, entryId } }],
		};
		sessionManager.appendCustomEntry(FRAME_ENTRY, { schema: 1, reason: "updated", frame, unmerged: [] });
		const expectedState = {
			tool_call: [
				'edit: replace text in "collage-spec.md" (3 replacements)',
				...input.edits.map(
					({ oldText, newText }, index) =>
						`${index + 1}. oldText: ${JSON.stringify(oldText)}\n   newText: ${JSON.stringify(newText)}`,
				),
			].join("\n"),
		};
		const provider = new MockJudgeProvider((request): Record<string, Answer> => {
			const question = request.questions.constraint_0;
			// The original judge gave the rename 0.82 for this path-only request. New wording needs a fresh verdict.
			if (
				question?.type === "boolean" &&
				JSON.stringify(request.state) === '{"tool_call":"edit: collage-spec.md"}'
			) {
				return { constraint_0: { type: "boolean", probability: 0.82 } };
			}
			return question?.type === "choice" && JSON.stringify(request.state) === JSON.stringify(expectedState)
				? { constraint_0: choice("compatible") }
				: {};
		});
		const harness = await createHarness({
			sessionManager,
			extensionFactories: [
				createKyrnJudgeExtension({
					provider,
					mode: "active",
					// Restore the saved frame without asking a writer to update it during this guard test.
					config: parseConfig({ modes: { "task.frame": "off" } }),
					only: ["frame", "constraints"],
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "print" });
		const spec = join(harness.tempDir, input.path);
		writeFileSync(spec, `${input.edits.map((edit) => edit.oldText).join("\n")}\n`);
		writeFileSync(join(harness.tempDir, "AGENTS.md"), "Project notes\n");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("edit", input, { id: "edit-spec" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);

		await harness.session.prompt("Update the collage spec.");

		const calls = provider.calls.filter((call) => "constraint_0" in call.questions);
		expect(calls).toHaveLength(1);
		const [asked] = calls;
		expect.soft(asked.state).toEqual(expectedState);
		expect.soft(asked.questions).toEqual({
			constraint_0: {
				type: "choice",
				instructions: expect.stringContaining(`directly contradict this user instruction? "${rename}"`),
				criteria: {
					violates: expect.stringContaining("does something the instruction forbids or undoes the result"),
					compatible: expect.stringContaining("merely does not carry out a requested action"),
					unclear: expect.any(String),
				},
			},
		});
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		expect.soft(result, JSON.stringify(result)).toMatchObject({ toolCallId: "edit-spec", isError: false });
		expect(readFileSync(spec, "utf8")).toBe(`${input.edits.map((edit) => edit.newText).join("\n")}\n`);
	});

	it.each([
		{ type: "choice", choice: "violates", probabilities: { violates: 0.8 } },
		{ type: "choice", choice: "violates", confidence: 0.8 },
	] as const)("states the user's rule when it blocks a change (%j)", async (answer) => {
		const { harness } = await start(verdict(answer));
		harness.setResponses([edit("db/schema.sql"), fauxAssistantMessage("I will leave the schema alone.")]);

		await harness.session.prompt("Speed up the report page.");

		expect(ran).toEqual([]);
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		expect(JSON.stringify(result)).toContain("先别修改数据库相关的文件");
		expect(JSON.stringify(result)).toContain(constraintId("先别修改数据库相关的文件").slice(0, 8));
		expect(JSON.stringify(result)).toContain("/frame remove <id>");
	});

	it("spends a one-call exception only on the whole authorized call, without lifting other rules", async () => {
		const recurring = "Ask before each commit.";
		const keep = "Never modify the schema.";
		const permit = "You may commit the docs fix once using git commit -m docs.";
		const use = "git commit -m docs";
		const { harness, provider } = await start(
			(request): Record<string, Answer> => {
				if ("change" in request.questions)
					return {
						change: { type: "choice", choice: "none" },
						limit: { type: "choice", choice: "once_1", probabilities: { once_1: 0.99 } },
					};
				if (!("constraint_0" in request.questions)) return {};
				const { tool_call, complete_call, one_call_permission } = request.state as {
					tool_call: string;
					complete_call?: string;
					one_call_permission?: string;
				};
				return {
					constraint_0: choice("violates"),
					constraint_1: choice(tool_call.includes("schema") ? "violates" : "compatible"),
					...("permission_once" in request.questions
						? {
								permission_once: {
									type: "boolean",
									probability:
										one_call_permission === permit &&
										// Even a match cannot waive the independent schema rule.
										(tool_call.includes("schema") ||
											complete_call === `bash: ${JSON.stringify({ command: use })}`)
											? 0.99
											: 0.01,
								} as const,
							}
						: {}),
				};
			},
			{ rules: [recurring, keep], refuseAfterConstraints: "call-2" },
		);
		harness.setResponses([fauxAssistantMessage("Ready.")]);
		await harness.session.prompt("Prepare the docs fix.");
		const commands = ["git commit -m schema", "git commit -m other", use, use, use];
		harness.setResponses([
			...commands.map((command, i) =>
				fauxAssistantMessage([fauxToolCall("bash", { command }, { id: `call-${i}` })], { stopReason: "toolUse" }),
			),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt(permit);
		expect(ran).toEqual([`bash:${JSON.stringify({ command: use })}`]);
		expect(
			harness.session.messages.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId, m.isError]),
		).toEqual([
			["call-0", true],
			["call-1", true],
			["call-2", true], // A later gate refused it; the grant is still available.
			["call-3", false],
			["call-4", true],
		]);
		expect(provider.calls.filter((r) => "permission_once" in r.questions)).toHaveLength(4);
	});

	it("two simultaneous matching calls cannot spend one permission twice", async () => {
		const both = Promise.withResolvers<void>();
		let checking = 0;
		const { harness } = await start(
			async (request): Promise<Record<string, Answer>> => {
				if ("change" in request.questions)
					return {
						change: { type: "choice", choice: "none" },
						limit: { type: "choice", choice: "once_1", probabilities: { once_1: 0.99 } },
					};
				if (!("permission_once" in request.questions)) return { constraint_0: choice("violates") };
				if (++checking === 2) both.resolve();
				await both.promise;
				return { constraint_0: choice("violates"), permission_once: { type: "boolean", probability: 0.99 } };
			},
			{ rules: ["Ask before each commit."] },
		);
		harness.setResponses([fauxAssistantMessage("Ready."), fauxAssistantMessage("Understood.")]);
		await harness.session.prompt("Prepare the docs fix.");
		await harness.session.prompt("I authorize one git commit -m docs.");
		const results = await Promise.all(
			["parallel-a", "parallel-b"].map((toolCallId) =>
				harness.session.extensionRunner.emitToolCall({
					type: "tool_call",
					toolName: "bash",
					toolCallId,
					input: { command: "git commit -m docs" },
				}),
			),
		);
		expect(checking).toBe(2);
		expect(results.filter((r) => r?.block)).toHaveLength(1);
	});

	it("never asks for a one-call exception using redacted or incomplete arguments", () => {
		const rule = ["Ask before editing documents."];
		const once = { index: 0, userMessage: "Allow this one update." };
		for (const content of ["x".repeat(5000), '{"password":"test marker with spaces"}']) {
			expect(constraintInput("write", { path: "doc.txt", content }, rule, once).permission).toBeUndefined();
		}
	});

	it("blocks only the edit each prohibition actually covers", async () => {
		const rules = ["Do not modify AGENTS.md.", "Do not remove copyright notices."];
		const requests = [
			{ path: "AGENTS.md", edits: [{ oldText: "Draft notes", newText: "Updated notes" }] },
			{ path: "collage-spec.md", edits: [{ oldText: "Draft notes", newText: "Updated notes" }] },
			{ path: "collage-spec.md", edits: [{ oldText: "Copyright 2026", newText: "" }] },
		];
		const states = requests.map((input) => toolConstraint.buildState(constraintInput("edit", input, rules)));
		const { harness, provider } = await start(
			(request): Record<string, Answer> => {
				const index = states.findIndex((state) => JSON.stringify(request.state) === JSON.stringify(state));
				if (index < 0) return {};
				return {
					constraint_0: choice(index === 0 ? "violates" : "compatible"),
					constraint_1: choice(index === 2 ? "violates" : "compatible"),
				};
			},
			{ rules },
		);
		harness.setResponses([
			...requests.map((input, index) =>
				fauxAssistantMessage([fauxToolCall("edit", input, { id: `edit-${index}` })], { stopReason: "toolUse" }),
			),
			fauxAssistantMessage("Done."),
		]);

		await harness.session.prompt("Update the project notes and spec.");

		const calls = provider.calls.filter((call) => "constraint_0" in call.questions);
		expect(calls.map((call) => call.state)).toEqual(states);
		for (const { questions } of calls) {
			expect(Object.keys(questions)).toEqual(["constraint_0", "constraint_1"]);
			expect(questions.constraint_0.instructions).toContain(rules[0]);
			expect(questions.constraint_1.instructions).toContain(rules[1]);
		}
		expect(ran).toEqual([`edit:${JSON.stringify(requests[1])}`]);
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results.map(({ toolCallId, isError }) => [toolCallId, isError])).toEqual([
			["edit-0", true],
			["edit-1", false],
			["edit-2", true],
		]);
		expect(JSON.stringify(results[0])).toContain(rules[0]);
		expect(JSON.stringify(results[0])).not.toContain(rules[1]);
		expect(JSON.stringify(results[2])).toContain(rules[1]);
		expect(JSON.stringify(results[2])).not.toContain(rules[0]);
	});

	it.each([
		{ name: "compatible", answer: choice("compatible"), mode: "active" },
		{ name: "unclear", answer: choice("unclear"), mode: "active" },
		{ name: "below the cutoff", answer: choice("violates", 0.79), mode: "active" },
		{ name: "no score", answer: { type: "choice", choice: "violates" }, mode: "active" },
		{
			name: "weak picked probability despite high confidence",
			answer: { type: "choice", choice: "violates", probabilities: { violates: 0.79 }, confidence: 0.99 },
			mode: "active",
		},
		{ name: "no answer", answer: undefined, mode: "active" },
		{ name: "shadow", answer: choice("violates"), mode: "shadow" },
		{ name: "off", answer: choice("violates"), mode: "off" },
	] as const)("lets the edit run: $name", async ({ answer, mode }) => {
		const { harness, provider } = await start(verdict(answer), { mode });
		harness.setResponses([edit("src/report.ts"), fauxAssistantMessage("Done.")]);

		await harness.session.prompt("Speed up the report page.");

		const calls = provider.calls.filter((call) => "constraint_0" in call.questions);
		expect(calls).toHaveLength(mode === "off" ? 0 : 1);
		expect(ran).toHaveLength(1);
	});

	it("lets the edit run when the judge fails", async () => {
		const { harness, provider } = await start((request) => {
			if ("constraint_0" in request.questions) throw new Error("judge unavailable");
			return {};
		});
		harness.setResponses([edit("src/report.ts"), fauxAssistantMessage("Done.")]);

		await harness.session.prompt("Speed up the report page.");

		expect(provider.calls.filter((call) => "constraint_0" in call.questions)).toHaveLength(1);
		expect(ran).toHaveLength(1);
	});

	it("lets the edit run before a late verdict arrives", async () => {
		const { promise, resolve } = Promise.withResolvers<Record<string, Answer>>();
		const { harness, provider } = await start((request) => ("constraint_0" in request.questions ? promise : {}), {
			constraints: { waitMs: 5 },
		});
		harness.setResponses([edit("src/report.ts"), fauxAssistantMessage("Done.")]);

		try {
			await harness.session.prompt("Speed up the report page.");

			expect(provider.calls.filter((call) => "constraint_0" in call.questions)).toHaveLength(1);
			expect(ran).toHaveLength(1);
		} finally {
			resolve({ constraint_0: choice("violates") });
		}
	});

	it("never asks about a call that changes nothing", async () => {
		let asked = 0;
		const { harness } = await start((request) => {
			if ("constraint_0" in request.questions) asked++;
			return {};
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "db/schema.sql" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Read it."),
		]);

		await harness.session.prompt("What is in the schema?");

		expect(asked).toBe(0);
		expect(ran).toHaveLength(1);
	});

	// Review of the decision points, 2026-10-22: `bash` was checked whatever the command, `ls` included.
	it("never asks about a shell command that only looks, and still asks about one part that writes", async () => {
		const asked: string[] = [];
		const responder: MockResponder = (request) => {
			if ("constraint_0" in request.questions)
				asked.push(String((request.state as { tool_call: string }).tool_call));
			return {};
		};
		const look = (command: string) =>
			fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
		const { harness } = await start(responder);
		harness.setResponses([
			look("ls -la db; git status --short"),
			look("cat db/schema.sql | grep -n users 2>/dev/null"),
			look("ls db && sed -i s/a/b/ db/schema.sql"),
			fauxAssistantMessage("Looked."),
		]);
		await harness.session.prompt("What is in the schema?");
		expect(asked).toEqual(["bash: ls db && sed -i s/a/b/ db/schema.sql"]);
		expect(ran).toHaveLength(3);

		// Switched off, every command is checked as before.
		asked.length = 0;
		const { harness: all } = await start(responder, { constraints: { skipReadOnly: false } });
		all.setResponses([look("ls -la db"), fauxAssistantMessage("Looked.")]);
		await all.session.prompt("What is in the schema?");
		expect(asked).toEqual(["bash: ls -la db"]);
	});

	it("describes a call briefly: where, and the beginning of what", () => {
		expect(describeCall("bash", { command: "rm -rf build" })).toBe("rm -rf build");
		expect(describeCall("edit", { path: "a.ts", newText: "const a = 1;" })).toBe("a.ts <- const a = 1;");
		expect(describeCall("write", { path: "b.md", content: "x".repeat(900) }).length).toBeLessThanOrEqual(500);
	});

	it("redacts nested data before rendering a generic mutating tool's arguments", () => {
		const input = constraintInput(
			"apply_patch_from",
			{ metadata: { note: '{"password":"synthetic field with spaces"}' } },
			["Keep credentials private."],
		);
		expect(input.call).toContain("[redacted]");
		expect(input.call).not.toContain("synthetic field");
	});

	it("keeps same-prefix 198-character edit targets and their basenames distinct", () => {
		const prefix = `${"d".repeat(188)}/`;
		const paths = [`${prefix}AGENTS.md`, `${prefix}README.md`];
		const edits = [{ oldText: "before", newText: "after" }];
		const descriptions = paths.map((path) => {
			expect(path).toHaveLength(198);
			const { call } = constraintInput("edit", { path, edits }, []);
			expect(call).toContain(`replace text in ${JSON.stringify(path)} (1 replacement)`);
			return call;
		});
		expect(new Set(descriptions).size).toBe(2);
		const maxPath = `${"dir/".repeat(123)}notes.md`;
		expect(maxPath).toHaveLength(500);
		expect(constraintInput("edit", { path: maxPath, edits }, []).call).toContain(JSON.stringify(maxPath));
	});

	it("represents longer edit targets that differ only in the omitted directory, retaining the basename", () => {
		const head = "dir/".repeat(50);
		const tail = `${"dir/".repeat(100)}AGENTS.md`;
		const descriptions = ["a", "b"].map(
			(directory) => constraintInput("edit", { path: `${head}${directory}/${tail}` }, []).call,
		);
		for (const description of descriptions) {
			expect(description).toContain('AGENTS.md" [path digest: ');
			expect(description).toContain("[middle omitted]");
			expect(description).toMatch(/\[path digest: [a-f0-9]{64}\]/);
		}
		expect(descriptions[0]).not.toBe(descriptions[1]);
	});

	it("describes legacy top-level edit replacements after any batched replacements", () => {
		const legacy = { path: "one.txt", oldText: "remove this", newText: "" };
		expect(constraintInput("edit", legacy, []).call).toBe(
			'replace text in "one.txt" (1 replacement)\n1. oldText: "remove this"\n   newText: ""',
		);
		expect(constraintInput("edit", { ...legacy, edits: [{ oldText: "a", newText: "b" }] }, []).call).toBe(
			'replace text in "one.txt" (2 replacements)\n1. oldText: "a"\n   newText: "b"\n2. oldText: "remove this"\n   newText: ""',
		);
	});

	it.each(["active", "shadow"] as const)(
		"redacts the %s provider and opt-in ledger request before quoting or clipping",
		async (mode) => {
			const sentinel = "dummy-sentinel";
			const credential = `${sentinel}\\"\n-7890`;
			const named = "dummy-password-7493";
			vi.stubEnv("KYRN_TEST_CONSTRAINT_API_KEY", credential);
			const beginning = `Do not copy ${"x".repeat(275)} `;
			const { harness, provider } = await start(verdict(choice("compatible")), {
				mode,
				recordState: true,
				rules: [`${beginning}${credential} ${"remaining ".repeat(10)}`, `Leave {"password": "${named}"} alone.`],
			});
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("edit", {
							path: `docs/${credential}/AGENTS.md`,
							edits: [
								{ oldText: `A\n${"x".repeat(145)} ${credential} extra`, newText: `{"password": "${named}"}` },
								{ oldText: "before", newText: `a ${credential} b` },
							],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Done."),
			]);

			await harness.session.prompt("Update the document.");

			const records = () =>
				harness.sessionManager.getEntries().flatMap((entry) => {
					if (entry.type !== "custom" || entry.customType !== LEDGER_ENTRY_TYPE) return [];
					const record = entry.data as LedgerRecord;
					return record.specId === toolConstraint.id ? [record] : [];
				});
			await expect.poll(records).toHaveLength(1);
			const [record] = records();
			const [request] = provider.calls.filter((call) => "constraint_0" in call.questions);
			expect(record).toMatchObject({ mode, state: request.state, questions: request.questions });
			for (const { state, questions } of [request, record]) {
				const serialized = JSON.stringify({ state, questions });
				expect(serialized).not.toContain(sentinel);
				expect(serialized).not.toContain(named);
			}
			expect(request.state).toMatchObject({ tool_call: expect.stringContaining('"docs/[redacted]/AGENTS.md"') });
			expect(request.state).toMatchObject({
				tool_call: expect.stringContaining(
					`oldText: ${JSON.stringify(`A\n${"x".repeat(145)} [redacted] e`)} [truncated]`,
				),
			});
			expect(request.state).toMatchObject({
				tool_call: expect.stringContaining(`newText: ${JSON.stringify('{"password": "[redacted]"}')}`),
			});
			expect(request.state).toMatchObject({ tool_call: expect.stringContaining('newText: "a [redacted] b"') });
			expect(request.questions.constraint_0.instructions).toContain(
				`${JSON.stringify(`${beginning}[redacted] r`)} [truncated]`,
			);
			expect(request.questions.constraint_1.instructions).toContain(
				JSON.stringify('Leave {"password": "[redacted]"} alone.'),
			);
		},
	);

	it("bounds the edit preview and marks omitted text and replacements without changing generic descriptions", () => {
		const path = `${"dir/".repeat(200)}target.md`;
		const input = {
			path,
			edits: [
				{ oldText: "First line\nSecond line", newText: "" },
				{ oldText: `${"a".repeat(500)}hidden old`, newText: `${"b".repeat(500)}hidden new` },
				{ oldText: "Third match", newText: "Third replacement" },
				{ oldText: "hidden edit", newText: "hidden replacement" },
			],
		};
		const rules = ["Do not delete lines."];
		const { toolName, call, constraints } = constraintInput("edit", input, rules);
		expect(toolName).toBe("edit");
		expect(constraints).toEqual(rules);
		expect(call).toMatch(/^replace text in ".+target\.md" \[path digest: [a-f0-9]{64}\] \(4 replacements\)\n/);
		expect(call).toContain('oldText: "First line\\nSecond line"\n   newText: ""');
		expect(call).toMatch(/oldText: "a+" \[truncated\]\n {3}newText: "b+" \[truncated\]/);
		expect(call).toContain('oldText: "Third match"\n   newText: "Third replacement"');
		expect(call).toContain("[truncated: additional replacements omitted]");
		expect(call).not.toContain("hidden");
		expect(call.length).toBeLessThan(1200);
		expect(describeCall("edit", { ...input, path: "collage-spec.md" })).toBe("collage-spec.md");
	});

	it("hands a parent's constraints to a subagent's frame once, and ignores anything that is not a list of sentences", () => {
		const frame = createFrame({ turn: 1, text: "Task: fix the flaky test" });
		const inherited = inheritConstraints(frame, ["no new dependencies", "no new dependencies", " "]);
		expect(inherited.constraints.map((constraint) => constraint.text)).toEqual(["no new dependencies"]);
		expect(inherited.constraints[0].source).toEqual({ turn: 0 });
		expect(inheritConstraints(inherited, ["no new dependencies"])).toBe(inherited);
		expect(parseInheritedConstraints('["a", 3, "b"]')).toEqual(["a", "b"]);
		expect(parseInheritedConstraints("{not json")).toEqual([]);
		expect(parseInheritedConstraints(undefined)).toEqual([]);
	});
});
