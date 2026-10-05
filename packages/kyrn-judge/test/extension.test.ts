import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { inputPreflight } from "../src/decisions/input-preflight.ts";
import { JudgeError } from "../src/errors.ts";
import { PREFLIGHT_HINTS } from "../src/extension/features/preflight.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { userWords } from "../src/extension/runtime.ts";
import type { LedgerRecord } from "../src/ledger.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer, JudgeProvider } from "../src/types.ts";

const yes: Answer = { type: "boolean", probability: 0.95 };
const no: Answer = { type: "boolean", probability: 0.04 };

const chatVerdict: Record<string, Answer> = {
	turn_type: { type: "choice", choice: "chat_question", probabilities: { chat_question: 0.9 } },
	is_side_question: yes,
	needs_clarification: no,
	needs_files_changed: no,
	needs_memory: no,
	swarm_worthy: no,
	plan_first: no,
	task_complexity: { type: "score", score: 0.5 },
	reasoning_depth: { type: "score", score: 1 },
	tool_complexity: { type: "score", score: 0.2 },
};

function ledgerRecords(harness: Harness): LedgerRecord[] {
	const records: LedgerRecord[] = [];
	for (const entry of harness.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === "kyrn.decision") records.push(entry.data as LedgerRecord);
	}
	return records;
}

/**
 * The records of the decision these tests are about. A default session holds hidden capability packs,
 * so every message is also asked which of them it needs (`capability.disclosure`).
 */
function preflightRecords(harness: Harness): LedgerRecord[] {
	return ledgerRecords(harness).filter((record) => record.specId === inputPreflight.id);
}

describe("kyrn judge extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("judges each user message in shadow mode without changing what the model sees", async () => {
		const provider = new MockJudgeProvider(() => chatVerdict);
		const harness = await createHarness({
			extensionFactories: [createKyrnJudgeExtension({ provider, mode: "shadow" })],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("It refreshes the access token.")]);

		await harness.session.prompt("By the way, what does the refreshToken helper do?");
		await vi.waitFor(() => expect(preflightRecords(harness)).toHaveLength(1));

		const [record] = preflightRecords(harness);
		expect(record).toMatchObject({
			specId: "input.preflight",
			specVersion: inputPreflight.version,
			mode: "shadow",
			source: "fallback",
			reason: "shadow",
			providerId: "mock",
		});
		// First message of the session: the side-question rule overrides the judge's "yes".
		expect(record.judged).toMatchObject({ turnType: "chat_question", gear: "chat", sideQuestion: "no" });
		// Shadow mode: the outcome acted on is the stock default, not the verdict.
		expect(record.outcome).toMatchObject({ turnType: "unknown", gear: "standard" });

		const preflightCalls = provider.calls.filter((call) => "turn_type" in call.questions);
		expect(preflightCalls).toHaveLength(1);
		expect(preflightCalls[0].state).toMatchObject({
			user_message: "By the way, what does the refreshToken helper do?",
		});
		// Ledger entries live in the session file but never reach the model.
		expect(harness.session.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
	});

	it("passes recent turns to the judge as short digests", async () => {
		const provider = new MockJudgeProvider(() => chatVerdict);
		const harness = await createHarness({ extensionFactories: [createKyrnJudgeExtension({ provider })] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("First answer."), fauxAssistantMessage("Second answer.")]);

		await harness.session.prompt("first question");
		await harness.session.prompt("second question");
		const preflights = () => provider.calls.filter((call) => "turn_type" in call.questions);
		await vi.waitFor(() => expect(preflights()).toHaveLength(2));

		expect(preflights()[0].state).toMatchObject({ recent_turns: [] });
		expect(preflights()[1].state).toMatchObject({
			recent_turns: ["user: first question", "assistant: First answer."],
			user_message: "second question",
		});
	});

	it("asks about capabilities alongside preflight, so the turn starts after the slowest question and not after all", async () => {
		const started = new Map<string, number>();
		const provider = new MockJudgeProvider(async (request) => {
			const kind =
				"turn_type" in request.questions
					? "preflight"
					: "capability_0" in request.questions
						? "capabilities"
						: "other";
			started.set(kind, Math.min(started.get(kind) ?? Number.POSITIVE_INFINITY, performance.now()));
			if (kind === "preflight") await new Promise((resolve) => setTimeout(resolve, 250));
			return chatVerdict;
		});
		const harness = await createHarness({
			extensionFactories: [createKyrnJudgeExtension({ provider, mode: "active" })],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Sure.")]);

		await harness.session.prompt("what does the refreshToken helper do?");

		await vi.waitFor(() => expect(started.has("capabilities")).toBe(true));
		// The capability question went out while preflight's was still being answered, not after it.
		expect((started.get("capabilities") ?? 0) - (started.get("preflight") ?? 0)).toBeLessThan(150);
	});

	it("with a judge that answers one call at a time, the other questions wait for preflight's answer", async () => {
		const started = new Map<string, number>();
		const provider = new MockJudgeProvider(async (request) => {
			const kind =
				"turn_type" in request.questions
					? "preflight"
					: "capability_0" in request.questions
						? "capabilities"
						: "other";
			started.set(kind, Math.min(started.get(kind) ?? Number.POSITIVE_INFINITY, performance.now()));
			if (kind === "preflight") await new Promise((resolve) => setTimeout(resolve, 250));
			return chatVerdict;
		});
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({ provider, mode: "active", config: parseConfig({ tiers: ["laya"] }) }),
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Sure.")]);

		await harness.session.prompt("what does the refreshToken helper do?");

		await vi.waitFor(() => expect(started.has("capabilities")).toBe(true));
		// A local sidecar serves one request at a time: preflight's answer comes first, the rest queue behind it.
		expect((started.get("capabilities") ?? 0) - (started.get("preflight") ?? 0)).toBeGreaterThanOrEqual(200);
	});

	it("in shadow mode hands a long tool result over at once and records the admission verdict behind it", async () => {
		const lines = Array.from({ length: 120 }, (_, index) => `line ${index} ${"x".repeat(60)}`).join("\n");
		const dump: AgentTool = {
			name: "dump",
			label: "Dump",
			description: "Print a lot",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: lines }], details: {} }),
		};
		const provider = new MockJudgeProvider(async (request) => {
			if ("kind" in request.questions) await new Promise((resolve) => setTimeout(resolve, 400));
			return {};
		});
		const harness = await createHarness({
			tools: [dump],
			extensionFactories: [createKyrnJudgeExtension({ provider, only: ["preflight", "admission"] })],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("dump", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("Read it."),
		]);

		const startedAt = performance.now();
		await harness.session.prompt("dump everything");
		// A verdict that is only recorded is not worth holding the model for.
		expect(performance.now() - startedAt).toBeLessThan(300);
		await vi.waitFor(() =>
			expect(ledgerRecords(harness).some((record) => record.specId === "tool.admission")).toBe(true),
		);
	});

	it("never tells the model to ask, and makes it act on the reply to a question it did ask", async () => {
		// Replayed from a real session: "analyse how Jev is used here" read as vague and read-only, the model asked
		// what Jev was, and "go and find it yourself" read as vague again.
		let preflights = 0;
		const provider = new MockJudgeProvider((request) => {
			if (!("turn_type" in request.questions)) return {};
			preflights++;
			return {
				...chatVerdict,
				turn_type: { type: "choice", choice: preflights === 1 ? "research" : "quick_lookup", probabilities: {} },
				is_side_question: no,
				needs_clarification: { type: "boolean", probability: preflights === 1 ? 0.84 : 0.91 },
				// The reply is judged as one that changes files: the resolve hint would apply, were it not a reply.
				needs_files_changed: preflights === 1 ? no : yes,
				task_complexity: { type: "score", score: 2.5 },
			};
		});
		const harness = await createHarness({
			extensionFactories: [createKyrnJudgeExtension({ provider, mode: "active" })],
		});
		harnesses.push(harness);
		const seen: string[] = [];
		harness.setResponses([
			(context) => {
				seen.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("你说的 Jev 具体指项目里的哪个组件？给我一个文件路径即可。");
			},
			(context) => {
				seen.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("找到了：packages/kyrn-judge。");
			},
		]);

		await harness.session.prompt("深度分析一下 Jev 在我们这个项目里的应用");
		await harness.session.prompt("我们的这个工作目录，你自己去找吧。");

		expect(seen).toHaveLength(2);
		// A vague request that changes nothing is simply looked into: no hint about it, least of all "ask".
		expect(seen[0]).not.toMatch(/clarifying question/i);
		expect(seen[0]).not.toContain(PREFLIGHT_HINTS.resolve);
		expect(seen[0]).not.toContain(PREFLIGHT_HINTS.answered);
		// The reply to its own question: act, do not ask again; the judge's "vague" is overruled.
		expect(seen[1]).toContain(PREFLIGHT_HINTS.answered);
		expect(seen[1]).not.toContain(PREFLIGHT_HINTS.resolve);
		expect(seen[1]).not.toMatch(/clarifying question/i);
	});

	it("gives the resolve hint, not a question, when a loosely worded request may change files", async () => {
		const vague: Record<string, Answer> = {
			...chatVerdict,
			turn_type: { type: "choice", choice: "single_edit", probabilities: { single_edit: 0.6 } },
			is_side_question: no,
			needs_clarification: yes,
			needs_files_changed: yes,
		};
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({ provider: new MockJudgeProvider(() => vague), mode: "active" }),
			],
		});
		harnesses.push(harness);
		let promptSeen = "";
		harness.setResponses([
			(context) => {
				promptSeen = JSON.stringify(context.messages);
				return fauxAssistantMessage("Reading the module first.");
			},
		]);

		await harness.session.prompt("优化一下。");

		expect(promptSeen).toContain(PREFLIGHT_HINTS.resolve);
		expect(promptSeen).not.toMatch(/ask one focused clarifying question/i);
	});

	it("judges the person's own words past a host's preamble, while the model still gets the whole message", async () => {
		const provider = new MockJudgeProvider(() => chatVerdict);
		const harness = await createHarness({
			extensionFactories: [createKyrnJudgeExtension({ provider, mode: "active" })],
		});
		harnesses.push(harness);
		let promptSeen = "";
		harness.setResponses([
			(context) => {
				promptSeen = JSON.stringify(context.messages);
				return fauxAssistantMessage("Sure.");
			},
			fauxAssistantMessage("Done."),
		]);
		// What AionUi's core puts in front of the first message of a conversation.
		const preamble =
			"[Assistant Rules]\n## Available Skills\n\n- **aionui-config**: Configure AionUi itself with the bundled aioncore CLI.\n[/Assistant Rules]\n\n";

		await harness.session.prompt(`${preamble}现在深度分析一下这个项目`);
		await harness.session.prompt("继续");

		const preflights = () => provider.calls.filter((call) => "turn_type" in call.questions);
		await vi.waitFor(() => expect(preflights()).toHaveLength(2));
		expect(preflights()[0].state).toMatchObject({ user_message: "现在深度分析一下这个项目" });
		expect(preflights()[1].state).toMatchObject({
			recent_turns: ["user: 现在深度分析一下这个项目", "assistant: Sure."],
		});
		expect(promptSeen).toContain("Available Skills");

		expect(userWords("[Assistant Rules]\nrules\n[/Assistant Rules]\n\nhello")).toBe("hello");
		// Only a preamble is stripped: the words themselves are never edited.
		expect(userWords("hello [Assistant Rules] x [/Assistant Rules]")).toBe(
			"hello [Assistant Rules] x [/Assistant Rules]",
		);
		expect(userWords("plain")).toBe("plain");
	});

	const heavyVerdict: Record<string, Answer> = {
		...chatVerdict,
		turn_type: { type: "choice", choice: "multi_step_task", probabilities: { multi_step_task: 0.9 } },
		needs_files_changed: yes,
		plan_first: yes,
		task_complexity: { type: "score", score: 2.8 },
	};

	/** A heavy turn in active mode: what reasoning level the model was called with, and what it was told. */
	async function heavyTurn(config?: ReturnType<typeof parseConfig>) {
		const harness = await createHarness({
			models: [{ id: "faux-reasoner", reasoning: true }],
			extensionFactories: [
				createKyrnJudgeExtension({ provider: new MockJudgeProvider(() => heavyVerdict), mode: "active", config }),
			],
		});
		harnesses.push(harness);
		harness.session.setThinkingLevel("low");
		let reasoningSent: string | undefined;
		let promptSeen = "";
		harness.setResponses([
			(context, options) => {
				reasoningSent = options?.reasoning;
				promptSeen = JSON.stringify(context.messages);
				return fauxAssistantMessage("Here is the plan.");
			},
		]);
		await harness.session.prompt("Rewrite the authentication module to use OAuth2 across the whole app.");
		return { reasoningSent, promptSeen, levelAfter: harness.session.thinkingLevel };
	}

	it("in active mode hints at a plan for a heavy turn and leaves the user's thinking level alone: a switch loses the cache", async () => {
		const turn = await heavyTurn();
		expect(turn.promptSeen).toContain("Write a short plan");
		expect(turn.reasoningSent).toBe("low");
		expect(turn.levelAfter).toBe("low");
	});

	it("raises thinking for a heavy turn only when asked to, then restores the user's level", async () => {
		const turn = await heavyTurn(parseConfig({ features: { preflight: { thinking: true } } }));
		expect(turn.reasoningSent).toBe("high");
		expect(turn.promptSeen).toContain("Write a short plan");
		expect(turn.levelAfter).toBe("low");
	});

	it("never blocks or breaks a prompt when the judge is down", async () => {
		const down: JudgeProvider = {
			id: "down",
			evaluate: async () => {
				throw new JudgeError("payment_required", "AI Gateway requires a valid credit card on file", {
					status: 403,
				});
			},
		};
		const harness = await createHarness({
			extensionFactories: [createKyrnJudgeExtension({ provider: down, mode: "active" })],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");
		await vi.waitFor(() => expect(preflightRecords(harness)).toHaveLength(1));

		// Every decision of the turn fell back, the one about hidden capabilities included.
		for (const record of ledgerRecords(harness)) {
			expect(record).toMatchObject({ source: "fallback", reason: "error:payment_required" });
		}
		expect(harness.session.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
	});
});
