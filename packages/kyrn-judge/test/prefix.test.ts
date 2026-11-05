import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { defineDecision } from "../src/decision.ts";
import {
	fingerprint,
	PREFIX_ENTRY,
	type PrefixEntry,
	prefixBreak,
	registerPrefix,
} from "../src/extension/features/prefix.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { KyrnRuntime } from "../src/extension/runtime.ts";
import { Judge } from "../src/judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import { attended } from "./attended.ts";

/** An Anthropic request: pi marks the newest message for the cache, so the marker moves every request. */
function anthropic(messages: { role: string; text: string }[], system = "You are mu.") {
	return {
		model: "claude-x",
		max_tokens: 8000,
		system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
		tools: [{ name: "bash", input_schema: { type: "object" } }],
		messages: messages.map((message, index) => ({
			role: message.role,
			content: [
				{
					type: "text",
					text: message.text,
					...(index === messages.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
				},
			],
		})),
	};
}

const turn = [
	{ role: "user", text: "Fix the test." },
	{ role: "assistant", text: "Running it." },
];

describe("a request's prefix", () => {
	it("holds when a request only adds messages, wherever the cache marker moved", () => {
		const first = fingerprint(anthropic(turn));
		const next = fingerprint({ ...anthropic([...turn, { role: "user", text: "And now?" }]), max_tokens: 4000 });
		if (!first || !next) throw new Error("no fingerprint");
		expect(prefixBreak(first, next)).toBeUndefined();
	});

	it("says where it broke: the model, the system prompt and tools, or the first message that differs", () => {
		const first = fingerprint(anthropic([...turn, { role: "user", text: "Go on." }]));
		if (!first) throw new Error("no fingerprint");
		const model = fingerprint({ ...anthropic(turn), model: "claude-y" });
		const system = fingerprint(
			anthropic([...turn, { role: "user", text: "Go on." }], "You are mu. Today is Friday."),
		);
		const rewritten = fingerprint(
			anthropic([turn[0], { role: "assistant", text: "[output forgotten]" }, { role: "user", text: "Go on." }]),
		);
		if (!model || !system || !rewritten) throw new Error("no fingerprint");
		expect(prefixBreak(first, model)).toEqual({ part: "model", before: 3, after: 2 });
		expect(prefixBreak(first, system)).toEqual({ part: "system and tools", before: 3, after: 3 });
		expect(prefixBreak(first, rewritten)).toEqual({
			part: "messages",
			index: 1,
			kind: "assistant",
			before: 3,
			after: 3,
		});
		// A Responses API request lists items by type.
		const responses = (items: unknown[]) =>
			fingerprint({ model: "gpt-x", instructions: "You are mu.", input: items });
		const a = responses([
			{ role: "user", content: "hi" },
			{ type: "function_call", call_id: "c1", arguments: "{}" },
		]);
		const b = responses([
			{ role: "user", content: "hi" },
			{ type: "function_call", call_id: "c2", arguments: "{}" },
		]);
		if (!a || !b) throw new Error("no fingerprint");
		expect(prefixBreak(a, b)).toMatchObject({ part: "messages", index: 1, kind: "function_call" });
		expect(fingerprint({ prompt: "no list" })).toBeUndefined();
	});

	it("records a break with what mu decided since the request before, and nothing while requests only add", async () => {
		const handlers: ((event: unknown) => unknown)[] = [];
		const appended: { type: string; data: PrefixEntry }[] = [];
		// The engine writes its own ledger records there too.
		const entries = () => appended.filter((entry) => entry.type === PREFIX_ENTRY);
		const pi = {
			on: (event: string, handler: (event: unknown) => unknown) => {
				if (event === "before_provider_request") handlers.push(handler);
			},
			appendEntry: (type: string, data: PrefixEntry) => appended.push({ type, data }),
			getCommands: () => [],
		} as unknown as ExtensionAPI;
		const runtime = new KyrnRuntime(
			pi,
			parseConfig({ modes: { default: "active" } }),
			new Judge({ provider: new MockJudgeProvider(() => ({ drop: { type: "boolean", probability: 0.9 } })) }),
		);
		registerPrefix(runtime);
		const send = async (payload: unknown) => {
			for (const handler of handlers) await handler({ type: "before_provider_request", payload });
		};
		const forget = defineDecision({
			id: "test.forget",
			version: 1,
			questions: { drop: { type: "boolean", instructions: "Drop it?" } },
			cacheImpact: "prefix-mutating",
			latency: "inline",
			buildState: () => ({}),
			policy: (answers) => answers.drop.probability >= 0.8,
			fallback: () => false,
		});

		await send(anthropic(turn));
		await send(anthropic([...turn, { role: "user", text: "Go on." }]));
		expect(entries()).toEqual([]);
		await runtime.engine.decide(forget, {});
		await send(anthropic([turn[0], { role: "assistant", text: "[forgotten]" }, { role: "user", text: "Go on." }]));
		expect(entries()).toEqual([
			{
				type: PREFIX_ENTRY,
				data: {
					part: "messages",
					index: 1,
					kind: "assistant",
					before: 3,
					after: 3,
					model: "claude-x",
					decisions: [{ specId: "test.forget", cacheImpact: "prefix-mutating" }],
				},
			},
		]);
	});
});

describe("a session of mu", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const tool = (name: string): AgentTool => ({
		name,
		label: name,
		description: name,
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async () => ({ content: [{ type: "text", text: `ok ${name}` }], details: {} }),
	});

	it("only adds to what it sends the model, across tool calls and turns, with every feature on", async () => {
		const sent: { system: string; tools: string; messages: string[] }[] = [];
		const keep = (reply: ReturnType<typeof fauxAssistantMessage>) => (context: Context) => {
			sent.push({
				system: JSON.stringify(context.systemPrompt ?? ""),
				tools: JSON.stringify((context.tools ?? []).map((t) => [t.name, t.description, t.parameters])),
				messages: context.messages.map((message) => JSON.stringify(message)),
			});
			return reply;
		};
		const harness = await createHarness({
			tools: ["read", "edit", "write", "bash"].map(tool),
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(),
					mode: "active",
					config: parseConfig({ features: attended({ permissions: { mode: "judge" } }) }),
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			keep(
				fauxAssistantMessage([fauxToolCall("bash", { command: "npm test -- parse" })], { stopReason: "toolUse" }),
			),
			keep(fauxAssistantMessage([fauxToolCall("read", { path: "src/parse.ts" })], { stopReason: "toolUse" })),
			keep(fauxAssistantMessage([fauxToolCall("edit", { path: "src/parse.ts" })], { stopReason: "toolUse" })),
			keep(
				fauxAssistantMessage([fauxToolCall("bash", { command: "npm test -- parse" })], { stopReason: "toolUse" }),
			),
			keep(fauxAssistantMessage("Fixed the hours and minutes.")),
			keep(fauxAssistantMessage("Yes, all of them pass.")),
		]);
		await harness.session.prompt("The parseDuration test fails for 1h30m, can you fix it?");
		await harness.session.prompt("Do the other tests still pass?");

		expect(sent).toHaveLength(6);
		for (let i = 1; i < sent.length; i++) {
			const [before, now] = [sent[i - 1], sent[i]];
			expect(now.system, `request ${i}`).toBe(before.system);
			expect(now.tools, `request ${i}`).toBe(before.tools);
			expect(now.messages.slice(0, before.messages.length), `request ${i}`).toEqual(before.messages);
		}
	});
});
