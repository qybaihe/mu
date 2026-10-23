import { describe, expect, it, vi } from "vitest";
import { DecisionEngine, defineDecision } from "../src/decision.ts";
import { Judge } from "../src/judge.ts";
import { LEDGER_APPEND_TIMEOUT_MS, type LedgerSink } from "../src/ledger.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";

const decision = defineDecision({
	id: "test.ledger_timeout",
	version: 1,
	cacheImpact: "none",
	latency: "inline",
	questions: { keep: { type: "boolean", instructions: "Keep this item?" } },
	buildState: (input: { text: string }) => input,
	policy: () => "keep" as const,
	fallback: () => "drop" as const,
});

describe("DecisionEngine ledger writes", () => {
	it("does not wait forever when the ledger sink never resolves", async () => {
		vi.useFakeTimers();
		try {
			const hanging: LedgerSink = { append: () => new Promise<void>(() => {}) };
			const engine = new DecisionEngine({
				judge: new Judge({ provider: new MockJudgeProvider() }),
				defaultMode: "active",
				ledger: hanging,
			});

			const pending = engine.decide(decision, { text: "item" });
			await vi.advanceTimersByTimeAsync(LEDGER_APPEND_TIMEOUT_MS);

			await expect(pending).resolves.toMatchObject({ outcome: "keep", source: "judge" });
		} finally {
			vi.useRealTimers();
		}
	});
});
