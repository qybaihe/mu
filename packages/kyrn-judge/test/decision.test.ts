import { describe, expect, it, vi } from "vitest";
import { ABSTAIN, DecisionEngine, defineDecision } from "../src/decision.ts";
import { JudgeError } from "../src/errors.ts";
import { Judge } from "../src/judge.ts";
import { type LedgerSink, MemoryLedger } from "../src/ledger.ts";
import { threeZone } from "../src/policy.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer, JudgeProvider } from "../src/types.ts";

/** Keep a tool output chunk, or drop it. Without a judge, everything is kept. */
const keepChunk = defineDecision({
	id: "test.keep_chunk",
	version: 1,
	cacheImpact: "none",
	latency: "inline",
	questions: { relevant: { type: "boolean", instructions: "Is `chunk` needed for `intent`?" } },
	buildState: (input: { intent: string; chunk: string }) => ({ intent: input.intent, chunk: input.chunk }),
	policy(answers) {
		const verdict = threeZone(answers.relevant);
		if (verdict === "unsure") return ABSTAIN;
		return verdict === "yes" ? "keep" : "drop";
	},
	fallback: () => "keep" as const,
});

const input = { intent: "find the failing test", chunk: "npm warn deprecated glob@7" };

function engineWith(probability: number, mode: "off" | "shadow" | "active", ledger?: LedgerSink) {
	const provider = new MockJudgeProvider(() => ({ relevant: { type: "boolean", probability } }));
	return { provider, engine: new DecisionEngine({ judge: new Judge({ provider }), defaultMode: mode, ledger }) };
}

describe("DecisionEngine", () => {
	it("acts on the judged outcome in active mode", async () => {
		const ledger = new MemoryLedger();
		const { engine } = engineWith(0.03, "active", ledger);

		const decision = await engine.decide(keepChunk, input);

		expect(decision).toMatchObject({ outcome: "drop", source: "judge", judged: "drop" });
		expect(decision.reason).toBeUndefined();
		expect(ledger.records).toHaveLength(1);
		expect(ledger.records[0]).toMatchObject({ specId: "test.keep_chunk", specVersion: 1, outcome: "drop" });
	});

	it("records the verdict but returns the fallback in shadow mode", async () => {
		const ledger = new MemoryLedger();
		const { engine } = engineWith(0.03, "shadow", ledger);

		const decision = await engine.decide(keepChunk, input);

		expect(decision).toMatchObject({ outcome: "keep", source: "fallback", reason: "shadow", judged: "drop" });
		expect(ledger.records[0]).toMatchObject({ outcome: "keep", judged: "drop", mode: "shadow" });
	});

	it("in shadow mode, records a verdict the caller acts on anyway as the judge's, not as the fallback", async () => {
		// The browser's next click, a sub-agent's role: there is no rule to keep, so the verdict is used in shadow too.
		const acting = { ...keepChunk, actsInShadow: true };
		const ledger = new MemoryLedger();
		const { engine } = engineWith(0.03, "shadow", ledger);

		const decision = await engine.decide(acting, input);
		expect(decision).toMatchObject({ outcome: "drop", source: "judge", judged: "drop", mode: "shadow" });
		expect(decision.reason).toBeUndefined();
		expect(ledger.records[0]).toMatchObject({ outcome: "drop", source: "judge", judged: "drop", mode: "shadow" });
		expect(ledger.records[0].reason).toBeUndefined();

		const many = await engine.decideMany(acting, [input, input]);
		expect(many.map((one) => [one.outcome, one.source])).toEqual([
			["drop", "judge"],
			["drop", "judge"],
		]);
		expect(ledger.records[1]).toMatchObject({ outcome: ["drop", "drop"], source: "judge", mode: "shadow" });
		expect(ledger.records[1].reason).toBeUndefined();

		// With no verdict there is nothing to act on: the fallback, and why.
		const unsure = await engineWith(0.5, "shadow").engine.decide(acting, input);
		expect(unsure).toMatchObject({ outcome: "keep", source: "fallback", reason: "abstain" });
		const off = await engineWith(0.03, "off").engine.decide(acting, input);
		expect(off).toMatchObject({ outcome: "keep", source: "fallback", reason: "off" });
	});

	it("does not call the judge when the decision is off", async () => {
		const { engine, provider } = engineWith(0.03, "off");

		const decision = await engine.decide(keepChunk, input);

		expect(decision).toMatchObject({ outcome: "keep", source: "fallback", reason: "off" });
		expect(provider.calls).toHaveLength(0);
	});

	it("falls back when the policy abstains on a middling probability", async () => {
		const { engine } = engineWith(0.5, "active");

		const decision = await engine.decide(keepChunk, input);

		expect(decision).toMatchObject({ outcome: "keep", source: "fallback", reason: "abstain" });
		expect(engine.stats.abstentions).toBe(1);
	});

	it("fails open when the judge is unavailable", async () => {
		const broken: JudgeProvider = {
			id: "broken",
			evaluate: async () => {
				throw new JudgeError("payment_required", "AI Gateway requires a valid credit card on file", {
					status: 403,
				});
			},
		};
		const ledger = new MemoryLedger();
		const engine = new DecisionEngine({ judge: new Judge({ provider: broken }), defaultMode: "active", ledger });

		const decision = await engine.decide(keepChunk, input);

		expect(decision).toMatchObject({ outcome: "keep", source: "fallback", reason: "error:payment_required" });
		expect(engine.stats).toMatchObject({ calls: 1, failures: 1 });
		expect(engine.stats.lastError?.kind).toBe("payment_required");
		expect(ledger.records[0].reason).toBe("error:payment_required");
	});

	it("keeps deciding when the ledger itself fails", async () => {
		const failingLedger: LedgerSink = {
			append: () => {
				throw new Error("disk full");
			},
		};
		const { engine } = engineWith(0.97, "active", failingLedger);

		await expect(engine.decide(keepChunk, input)).resolves.toMatchObject({ outcome: "keep", source: "judge" });
	});

	it("stores a digest of the state, and the state itself only on request", async () => {
		const provider = new MockJudgeProvider();
		const quiet = new MemoryLedger();
		const verbose = new MemoryLedger();
		await new DecisionEngine({ judge: new Judge({ provider }), ledger: quiet }).decide(keepChunk, input);
		await new DecisionEngine({ judge: new Judge({ provider }), ledger: verbose, recordState: true }).decide(
			keepChunk,
			input,
		);

		expect(quiet.records[0].stateDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(quiet.records[0].state).toBeUndefined();
		expect(verbose.records[0].state).toEqual({ intent: input.intent, chunk: input.chunk });
		expect(verbose.records[0].stateDigest).toBe(quiet.records[0].stateDigest);
	});

	it("stores the questions with the state where they are built from the input, and only then", async () => {
		const pickTools = defineDecision({
			id: "test.pick_tools",
			version: 1,
			cacheImpact: "none",
			latency: "inline",
			questions: {},
			questionsFor: (input: { task: string; tools: string[] }) =>
				Object.fromEntries(
					input.tools.map((tool, index) => [
						`t${index}`,
						{ type: "boolean" as const, instructions: `Does \`task\` need ${tool}?` },
					]),
				),
			buildState: (input: { task: string; tools: string[] }) => ({ task: input.task }),
			policy: (answers) => Object.keys(answers).length,
			fallback: () => 0,
		});
		const built = { task: "deploy the site", tools: ["the shell", "a browser"] };
		const recorded = async (spec: typeof pickTools | typeof keepChunk, recordState: boolean) => {
			const ledger = new MemoryLedger();
			const engine = new DecisionEngine({
				judge: new Judge({ provider: new MockJudgeProvider() }),
				ledger,
				recordState,
			});
			await (spec === keepChunk ? engine.decide(keepChunk, input) : engine.decide(pickTools, built));
			return ledger.records[0].questions;
		};
		expect(await recorded(pickTools, true)).toEqual({
			t0: { type: "boolean", instructions: "Does `task` need the shell?" },
			t1: { type: "boolean", instructions: "Does `task` need a browser?" },
		});
		expect(await recorded(pickTools, false)).toBeUndefined();
		// Fixed questions are the spec's own: `specId` and `specVersion` name them.
		expect(await recorded(keepChunk, true)).toBeUndefined();
	});

	it("records where the caller was when it asked, not where it is when a slow judge answers", async () => {
		const waiting: ((answers: Record<string, Answer>) => void)[] = [];
		const provider = new MockJudgeProvider(
			() =>
				new Promise((resolve) => {
					waiting.push(resolve);
				}),
		);
		const ledger = new MemoryLedger();
		let turn = 1;
		const engine = new DecisionEngine({
			judge: new Judge({ provider }),
			defaultMode: "active",
			ledger,
			origin: () => ({ turn }),
		});

		const single = engine.decide(keepChunk, input);
		const batch = engine.decideMany(keepChunk, [
			{ ...input, chunk: "added 212 packages" },
			{ ...input, chunk: "audited 213 packages" },
		]);
		await vi.waitFor(() => expect(waiting).toHaveLength(3));
		turn = 2;
		for (const answer of waiting) answer({ relevant: { type: "boolean", probability: 0.03 } });
		await Promise.all([single, batch]);

		expect(ledger.records.map((record) => record.origin)).toEqual([{ turn: 1 }, { turn: 1 }]);
	});

	it("keeps deciding when the origin cannot be read", async () => {
		const ledger = new MemoryLedger();
		const provider = new MockJudgeProvider(() => ({ relevant: { type: "boolean", probability: 0.03 } }));
		const engine = new DecisionEngine({
			judge: new Judge({ provider }),
			defaultMode: "active",
			ledger,
			origin: () => {
				throw new Error("runtime disposed");
			},
		});

		await expect(engine.decide(keepChunk, input)).resolves.toMatchObject({ outcome: "drop", source: "judge" });
		expect(ledger.records[0].origin).toBeUndefined();
	});
});

describe("DecisionEngine modes", () => {
	it("with the default off, a point in shadow only by default asks no judge; one set otherwise still does", async () => {
		const provider = new MockJudgeProvider(() => ({ relevant: { type: "boolean", probability: 0.03 } }));
		const engine = new DecisionEngine({
			judge: new Judge({ provider }),
			defaultMode: "off",
			modes: { "test.keep_chunk": "shadow", "test.other": "active" },
			builtInModes: { "test.keep_chunk": "shadow" },
		});
		expect(engine.getMode("test.keep_chunk")).toBe("off");
		expect(engine.getMode("test.other")).toBe("active");
		expect(engine.asksJudge()).toBe(true);
		// /status lists what differs from the default as it takes effect: not the shadow that gave way.
		expect([...engine.overrides()]).toEqual([["test.other", "active"]]);
		const decision = await engine.decide(keepChunk, input);
		expect(decision).toMatchObject({ outcome: "keep", source: "fallback" });
		expect(provider.calls).toHaveLength(0);

		engine.setMode("test.other", "off");
		expect(engine.asksJudge()).toBe(false);
		expect(engine.overrides().size).toBe(0);
		// Turned on again, the built-in shadow comes back.
		engine.setDefaultMode("active");
		expect(engine.getMode("test.keep_chunk")).toBe("shadow");
		expect(engine.asksJudge()).toBe(true);
		expect([...engine.overrides()]).toEqual([
			["test.keep_chunk", "shadow"],
			["test.other", "off"],
		]);
	});
});

describe("defineDecision", () => {
	const base = {
		id: "test.route",
		version: 1,
		cacheImpact: "none",
		latency: "inline",
		buildState: () => "state",
		fallback: () => "none",
	} as const;

	it("rejects a choice question without an escape option", () => {
		expect(() =>
			defineDecision({
				...base,
				questions: {
					queue: { type: "choice", instructions: "Route it.", criteria: { billing: null, shipping: null } },
				},
				policy: (answers) => answers.queue.choice,
			}),
		).toThrow(/no escape option/);
	});

	it("accepts a closed option set when the spec says so", () => {
		expect(() =>
			defineDecision({
				...base,
				allowChoicesWithoutEscape: true,
				questions: {
					queue: { type: "choice", instructions: "Route it.", criteria: { billing: null, shipping: null } },
				},
				policy: (answers) => answers.queue.choice,
			}),
		).not.toThrow();
	});

	it("rejects a non-positive version", () => {
		expect(() =>
			defineDecision({
				...base,
				version: 0,
				questions: { ok: { type: "boolean", instructions: "?" } },
				policy: () => "none",
			}),
		).toThrow(/version/);
	});
});
