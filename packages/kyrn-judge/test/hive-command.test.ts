import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionError, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { HIVE_REQUEST_ENTRY } from "../src/extension/features/hive.ts";
import type { SwarmRunner } from "../src/extension/features/swarm.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { hiveRequest, parseHiveArgs } from "../src/hive/request.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";

describe("/hive, what it reads from its argument", () => {
	it("keeps /swarm's words and takes anything longer as a question", () => {
		expect(parseHiveArgs("")).toEqual({ kind: "status" });
		expect(parseHiveArgs("  status ")).toEqual({ kind: "status" });
		expect(parseHiveArgs("stop")).toEqual({ kind: "control", verb: "stop" });
		expect(parseHiveArgs("kill repro")).toEqual({ kind: "control", verb: "kill", name: "repro" });
		expect(parseHiveArgs("stop words: where are they defined?")).toEqual({
			kind: "question",
			question: "stop words: where are they defined?",
		});
		expect(parseHiveArgs(" Why does login fail only in CI? ")).toEqual({
			kind: "question",
			question: "Why does login fail only in CI?",
		});
	});

	it("asks for the hive at once, with angles that bear on each other, and never for a question back", () => {
		const request = hiveRequest("为什么 CI 里登录会失败？");
		expect(request.startsWith("Question for a hive: 为什么 CI 里登录会失败？\n")).toBe(true);
		expect(request).toContain("Call the `hive` tool now, as your first step");
		expect(request).toContain("do not ask me anything");
		expect(request).toContain("three investigators");
		expect(request).toContain("Answer in the language of my question.");
	});
});

describe("/hive in a session", () => {
	const harnesses: Harness[] = [];
	beforeEach(() => {
		// Nothing here calls a model: whatever credentials the shell has must not make one callable either.
		for (const name of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
			vi.stubEnv(name, undefined);
		}
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const QUESTION = "Why does login fail only in CI?";
	const BEES = [
		{ name: "where", focus: "Where the login flow is implemented" },
		{ name: "config", focus: "How CI configures the login tests" },
		{ name: "run", focus: "What running the login tests shows" },
	];
	const callHive = () =>
		fauxAssistantMessage([fauxToolCall("hive", { goal: QUESTION, bees: BEES })], { stopReason: "toolUse" });

	/** A hive whose bees report at once, or when `hold` lets them. */
	async function start(
		options: {
			hold?: Promise<void>;
			tools?: AgentTool[];
			permissions?: "full" | "jev";
			responder?: MockResponder;
		} = {},
	) {
		const bees: string[] = [];
		const runner: SwarmRunner = async (task, _assignment, signal, env) => {
			bees.push(env?.KYRN_HIVE_BEE ?? "");
			if (options.hold) {
				await Promise.race([
					options.hold,
					new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("stopped")))),
				]);
			}
			return `${task.title}: found it`;
		};
		const harness = await createHarness({
			tools: options.tools,
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(options.responder ?? (() => ({}))),
					mode: "active",
					config: parseConfig({
						features: { memory: false, permissions: { mode: options.permissions ?? "full" } },
					}),
					swarmRunner: runner,
				}),
			],
		});
		harnesses.push(harness);
		return { harness, bees };
	}

	/** Binds the session as the desktop app does (RPC), with a UI whose notices are kept. */
	async function asRpc(harness: Harness): Promise<string[]> {
		const notes: string[] = [];
		const known: Record<string, unknown> = { notify: (message: string) => notes.push(message) };
		const ui = new Proxy(known, {
			get: (target, key) => (key in target ? target[key as string] : () => undefined),
		}) as unknown as ExtensionUIContext;
		await harness.session.bindExtensions({ uiContext: ui, mode: "rpc" });
		return notes;
	}

	/** The hive requests in the session that the chat does not show. */
	const hiddenRequests = (harness: Harness) =>
		harness.session.messages.flatMap((message) =>
			message.role === "custom" && message.customType === HIVE_REQUEST_ENTRY && message.display === false
				? [message.content]
				: [],
		);

	const toolResult = (harness: Harness) =>
		JSON.stringify(harness.session.messages.find((message) => message.role === "toolResult"));

	it("in print mode: starts the hive on the question and returns only once the answer is in", async () => {
		const { harness, bees } = await start();
		let asked = "";
		harness.setResponses([
			(context) => {
				asked = JSON.stringify(context.messages);
				return callHive();
			},
			fauxAssistantMessage("It fails because CI sets TZ=UTC; see the reports."),
		]);

		// The harness session is in print mode, as `mu -p "/hive …"` is: the process ends when this returns.
		await harness.session.prompt(`/hive ${QUESTION}`);

		expect(harness.getPendingResponseCount()).toBe(0);
		// The chat shows what was typed; the request rides along as a message only the model reads.
		expect(getUserTexts(harness)).toEqual([`/hive ${QUESTION}`]);
		expect(hiddenRequests(harness)).toEqual([hiveRequest(QUESTION)]);
		expect(asked).toContain("Question for a hive: Why does login fail only in CI?");
		expect(bees).toEqual(["where", "config", "run"]);
		expect(toolResult(harness)).toContain("where: found it");
		expect(JSON.stringify(harness.session.messages.at(-1))).toContain("CI sets TZ=UTC");
	});

	it("over RPC: returns at once and the hive runs as a typed message's turn would", async () => {
		let release: () => void = () => {};
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { harness, bees } = await start({ hold });
		const notes = await asRpc(harness);
		harness.setResponses([callHive(), fauxAssistantMessage("The answer.")]);

		await harness.session.prompt(`/hive ${QUESTION}`);
		// The desktop's prompt is answered while the bees still work.
		await vi.waitFor(() => expect(bees).toEqual(["where", "config", "run"]));
		expect(harness.getPendingResponseCount()).toBe(1);

		release();
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0));
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual([`/hive ${QUESTION}`]);
		expect(hiddenRequests(harness)).toEqual([hiveRequest(QUESTION)]);
		expect(JSON.stringify(harness.session.messages.at(-1))).toContain("The answer.");
		expect(notes).toEqual([]);
	});

	it("in Jev-approves mode: the hive is judged against /hive as the user's own words, not the turn before", async () => {
		const approvals: Record<string, unknown>[] = [];
		const responder: MockResponder = (request): Record<string, Answer> => {
			if (!("verdict" in request.questions)) return {};
			const state = request.state as Record<string, unknown>;
			approvals.push(state);
			const asked = String(state.user_message).startsWith("/hive ");
			const choice = asked ? "needed" : "unrelated";
			return { verdict: { type: "choice", choice, probabilities: { [choice]: 0.95 } } };
		};
		const { harness, bees } = await start({ permissions: "jev", responder });
		const notes = await asRpc(harness);
		harness.setResponses([
			fauxAssistantMessage("Hello."),
			callHive(),
			fauxAssistantMessage("The answer, from the hive."),
		]);

		await harness.session.prompt("hi");
		await harness.session.prompt(`/hive ${QUESTION}`);
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0));
		await harness.session.waitForIdle();

		expect(approvals.map((state) => state.user_message)).toEqual([`/hive ${QUESTION}`]);
		expect(String(approvals[0]?.tool_call)).toContain("hive");
		expect(bees).toEqual(["where", "config", "run"]);
		// Nobody was asked: Jev approved it.
		expect(notes).toEqual([]);
		expect(JSON.stringify(harness.session.messages.at(-1))).toContain("The answer, from the hive.");
	});

	it("without a question it is /swarm: it shows what runs, and stops or ends a bee by name", async () => {
		let release: () => void = () => {};
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { harness, bees } = await start({ hold });
		const notes = await asRpc(harness);

		await harness.session.prompt("/hive");
		expect(notes.at(-1)).toContain("No subagents are running.");
		expect(notes.at(-1)).toContain("/hive <question> puts several investigators to work on your question.");

		harness.setResponses([callHive(), fauxAssistantMessage("Two of three reported.")]);
		await harness.session.prompt(`/hive ${QUESTION}`);
		await vi.waitFor(() => expect(bees).toHaveLength(3));
		await harness.session.prompt("/hive kill config", { streamingBehavior: "steer" });
		expect(notes.at(-1)).toBe("Stopped 1 subagent. Their findings so far are kept.");
		release();
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0));
		await harness.session.waitForIdle();
		expect(toolResult(harness)).toContain("STOPPED: ended by the user");
		expect(toolResult(harness)).toContain("run: found it");
	});

	it("while a turn runs: the hive waits for it to end instead of cutting in", async () => {
		let release: () => void = () => {};
		const reading = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started: () => void = () => {};
		const inTool = new Promise<void>((resolve) => {
			started = resolve;
		});
		const slow: AgentTool = {
			name: "read",
			label: "read",
			description: "read",
			parameters: Type.Object({}, { additionalProperties: true }),
			execute: async () => {
				started();
				await reading;
				return { content: [{ type: "text", text: "export const ok = true;" }], details: {} };
			},
		};
		const { harness, bees } = await start({ tools: [slow] });
		const notes = await asRpc(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxText("Reading first."), fauxToolCall("read", { path: "src/login.ts" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("The file is fine."),
			callHive(),
			fauxAssistantMessage("The answer, from the hive."),
		]);

		const first = harness.session.prompt("Look at src/login.ts");
		await inTool;
		// What the terminal does with anything typed while the agent works.
		await harness.session.prompt(`/hive ${QUESTION}`, { streamingBehavior: "steer" });
		expect(notes).toEqual(["The hive will start when the current turn ends."]);
		expect(bees).toEqual([]);
		release();
		await first;
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0));
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["Look at src/login.ts", hiveRequest(QUESTION)]);
		expect(bees).toEqual(["where", "config", "run"]);
		expect(JSON.stringify(harness.session.messages.at(-1))).toContain("The answer, from the hive.");
	});

	it("says why it cannot start one when the hive tool is left out, and sends nothing", async () => {
		const { harness } = await start();
		harness.session.setActiveToolsByName(["read"]);
		const notes = await asRpc(harness);
		harness.setResponses([callHive()]);

		await harness.session.prompt(`/hive ${QUESTION}`);

		expect(notes).toEqual([
			"The hive tool isn't active in this session (--tools leaves it out), so /hive can't start one.",
		]);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);

		// Print mode has nobody to notify: the reason is the error it prints.
		const { harness: printing } = await start();
		printing.session.setActiveToolsByName(["read"]);
		const errors: ExtensionError[] = [];
		await printing.session.bindExtensions({ onError: (error) => errors.push(error) });
		await printing.session.prompt(`/hive ${QUESTION}`);
		expect(errors.map((error) => error.error)).toEqual([
			"The hive tool isn't active in this session (--tools leaves it out), so /hive can't start one.",
		]);
		expect(getUserTexts(printing)).toEqual([]);
	});
});
