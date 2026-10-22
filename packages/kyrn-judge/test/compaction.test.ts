import { existsSync, readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { type CallItem, type HistoryItem, itemsFromMessages, serializeHistory } from "../src/compaction/history.ts";
import { analyze, apply, type CallVerdict, plan, termsOf } from "../src/compaction/prune.ts";
import { parseConfig } from "../src/config.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import type { KyrnPresentationEvent } from "../src/extension/presentation.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";
import { attended } from "./attended.ts";

const long = (label: string, lines = 60) =>
	Array.from({ length: lines }, (_, index) => `${label} line ${index}`).join("\n");

function call(
	id: string,
	tool: string,
	input: Record<string, unknown>,
	result: string,
	extra: Partial<CallItem> = {},
): CallItem {
	return {
		kind: "call",
		id,
		tool,
		input,
		result,
		isError: false,
		state: "full",
		resultChars: result.length,
		...extra,
	};
}

const OPTIONS = { keepThreshold: 0.5, minChars: 600, headChars: 300, targetChars: 1_000_000 };

describe("history", () => {
	it("pairs calls with results, keeps what was said word for word, and leaves thinking out", () => {
		const items = itemsFromMessages([
			{ role: "user", content: "Never edit src/generated. Fix the login test." },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private reasoning" },
					{ type: "text", text: "Reading the test." },
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "test/login.test.ts" } },
				],
			},
			{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "it('logs in')" }] },
		]);

		expect(items.map((item) => item.kind)).toEqual(["user", "assistant", "call"]);
		expect(items[2]).toMatchObject({ tool: "read", result: "it('logs in')", resultChars: 13, state: "full" });
		const text = serializeHistory(items);
		expect(text).toContain("Never edit src/generated. Fix the login test.");
		expect(text).toContain('[Tool call t1] read path="test/login.test.ts"');
		expect(text).not.toContain("private reasoning");
	});
});

describe("pruning", () => {
	const items: HistoryItem[] = [
		{ kind: "user", text: "Fix the flaky login test." },
		call("c1", "read", { path: "src/session.ts" }, long("old session")),
		call("c2", "bash", { command: "npm test" }, long("FAIL login")),
		call("c3", "edit", { path: "src/session.ts" }, "ok"),
		call("c4", "bash", { command: "npm test" }, long("PASS login")),
		call("c5", "read", { path: "docs/cookies.md" }, long("cookie notes")),
		call("c6", "grep", { pattern: "unrelatedThing", path: "vendor" }, long("vendor hit")),
	];
	const live = { text: "now update docs/cookies.md to mention the session cookie", calls: [] };

	it("knows without asking that a changed file and a rerun command left stale output", () => {
		const facts = analyze(items, live);

		expect(facts.find((fact) => fact.index === 1)?.stale).toBe("the file was changed after this read");
		expect(facts.find((fact) => fact.index === 2)?.stale).toBe("the same command was run again later");
		expect(facts.find((fact) => fact.index === 4)?.stale).toBeUndefined();
		// Relevance: the docs file is still being talked about, the vendor search is not.
		expect(facts.find((fact) => fact.index === 5)?.relevance).toBeGreaterThan(0.5);
		expect(facts.find((fact) => fact.index === 6)?.relevance).toBe(0);
		expect(termsOf(items[5] as CallItem)).toContain("cookies.md");
	});

	it("prunes by rule and by score, never touches what was said, and saves what it prunes", () => {
		const facts = analyze(items, live);
		const planned = plan(items, facts, new Map(), OPTIONS);
		const actions = Object.fromEntries(
			planned.plans.map((entry) => [(items[entry.index] as CallItem).id, entry.action]),
		);

		// No judge at all: rules, the kind implied by the tool, and relevance decide.
		expect(actions).toEqual({ c1: "prune", c2: "prune", c3: "keep", c4: "prune", c5: "keep", c6: "prune" });

		const saved: string[] = [];
		const pruned = apply(items, planned.plans, OPTIONS, (item) => {
			saved.push(item.id);
			return `/archive/${item.id}.txt`;
		});
		const text = serializeHistory(pruned);

		expect(saved).toEqual(["c1", "c2", "c4", "c6"]);
		expect(text).toContain("Fix the flaky login test.");
		expect(text).toContain("cookie notes line 59");
		expect(text).not.toContain("old session line 59");
		expect(text).toMatch(/pruned: first 300 of \d+ chars; complete text: \/archive\/c1\.txt/);
	});

	it("lets a capable judge keep, prune or drop, and then prunes the lowest scores to fit a budget", () => {
		const facts = analyze(items, live);
		const verdicts = new Map<number, CallVerdict>([
			[4, { kind: "log", keepResult: 0.9, keepCall: 0.9 }],
			[5, { kind: "content", keepResult: 0.7, keepCall: 0.9 }],
			[6, { kind: "listing", keepResult: 0.05, keepCall: 0.05 }],
		]);

		const roomy = plan(items, facts, verdicts, OPTIONS);
		// Just under what the threshold alone leaves: exactly one more result has to go.
		const tight = plan(items, facts, verdicts, { ...OPTIONS, targetChars: roomy.chars - 200 });
		const action = (plans: typeof roomy.plans, index: number) => plans.find((entry) => entry.index === index)?.action;
		const score = (index: number) => roomy.plans.find((entry) => entry.index === index)?.score ?? 0;

		expect([action(roomy.plans, 4), action(roomy.plans, 5), action(roomy.plans, 6)]).toEqual([
			"keep",
			"keep",
			"drop",
		]);
		// The budget takes the lower-scored of the two kept results first: the judge liked the test log
		// a little more, but the docs file is what the live conversation is about, and relevance counts.
		expect(score(5)).toBeGreaterThan(score(4));
		expect([action(tight.plans, 4), action(tight.plans, 5)]).toEqual(["prune", "keep"]);
		expect(tight.fits).toBe(true);
		expect(plan(items, facts, verdicts, { ...OPTIONS, targetChars: 50 }).fits).toBe(false);
	});

	it("never prunes the turn in progress or output that is already small", () => {
		const current: HistoryItem[] = [
			call("p1", "bash", { command: "npm test" }, long("pinned"), { pinned: true }),
			call("s1", "bash", { command: "ls" }, "a.ts\nb.ts"),
		];
		const planned = plan(
			current,
			analyze(current, { text: "", calls: [{ tool: "bash", input: { command: "npm test" } }] }),
			new Map(),
			OPTIONS,
		);

		expect(planned.plans.map((entry) => entry.action)).toEqual(["keep", "keep"]);
	});
});

describe("summary-free compaction in a session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("replaces pi's summary with the conversation itself, stale tool output pruned", async () => {
		const presentation: KyrnPresentationEvent[] = [];
		const tool = (name: string, output: (params: Record<string, unknown>) => string): AgentTool => ({
			name,
			label: name,
			description: name,
			parameters: Type.Object({}, { additionalProperties: true }),
			execute: async (_id, params) => ({
				content: [{ type: "text", text: output((params ?? {}) as Record<string, unknown>) }],
				details: {},
			}),
		});
		let reads = 0;
		const provider = new MockJudgeProvider((request): Record<string, Answer> => {
			// Preflight finds the work splittable, so KYRN injects a one-turn hint: advice, not something anyone said.
			if ("swarm_worthy" in request.questions) return { swarm_worthy: { type: "boolean", probability: 0.97 } };
			if (!("kind" in request.questions)) return {};
			return { kind: { type: "choice", choice: "content", probabilities: { content: 0.9 } } };
		});
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			tools: [tool("read", () => long(`version ${++reads} of session.ts`)), tool("edit", () => "ok")],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider,
					onPresentation: (event) => presentation.push(event),
					mode: "active",
					config: parseConfig({ features: attended({ memory: false, admission: false, compaction: true }) }),
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "src/session.ts" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("edit", { path: "src/session.ts" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("read", { path: "src/session.ts" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("The cookie is set now."),
			fauxAssistantMessage("You are welcome."),
		]);

		await harness.session.prompt("Set the session cookie. Never touch src/generated.");
		// The file is still being talked about, so its current contents are still worth their tokens.
		await harness.session.prompt("Thanks. Leave src/session.ts as it is now.");
		const result = await harness.session.compact();
		expect(presentation.some((event) => event.kind === "context.policy")).toBe(true);
		expect(presentation.some((event) => event.kind === "compaction.plan")).toBe(true);
		expect(result.details).toMatchObject({ kyrn: { metrics: { pruned: 1, dropped: 0 } } });
		expect(result.estimatedTokensAfter).toBeGreaterThan(0);
		expect(harness.session.getContextUsage()?.tokens).toBeNull();

		// No model wrote a summary: nothing was left in the queue to write one with, and none was needed.
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(result.summary).toContain("Nothing was summarized");
		expect(result.summary).toContain("Set the session cookie. Never touch src/generated.");
		expect(result.summary).toContain("The cookie is set now.");
		// The hint was really there, in the session file, and it is not in the history the model gets back.
		expect(JSON.stringify(harness.sessionManager.getEntries())).toContain("Consider the delegate tool");
		expect(result.summary).not.toContain("Consider the delegate tool");
		// The first read was made stale by the edit; the read after the edit is current and stays whole.
		expect(result.summary).not.toContain("version 1 of session.ts line 59");
		expect(result.summary).toContain("version 2 of session.ts line 59");
		const archived = /complete text: (\S+\.txt)\]/.exec(result.summary)?.[1];
		expect(archived && existsSync(archived) && readFileSync(archived, "utf8")).toContain(
			"version 1 of session.ts line 59",
		);
		const entry = harness.sessionManager.getEntries().find((candidate) => candidate.type === "compaction");
		expect(JSON.stringify(entry)).toContain('"kyrn":{"version":1');
	});
});
