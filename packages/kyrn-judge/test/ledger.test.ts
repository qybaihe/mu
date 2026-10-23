import { describe, expect, it, vi } from "vitest";
import {
	CompositeLedger,
	LEDGER_APPEND_TIMEOUT_MS,
	type LedgerRecord,
	type LedgerSink,
	MemoryLedger,
} from "../src/ledger.ts";

const record: LedgerRecord = {
	id: "record-1",
	timestamp: "2026-01-01T00:00:00.000Z",
	specId: "test.decision",
	specVersion: 1,
	mode: "active",
	providerId: "test",
	outcome: "keep",
	source: "fallback",
	stateDigest: "digest",
};

describe("CompositeLedger", () => {
	it("does not wait forever for a sink that never resolves", async () => {
		vi.useFakeTimers();
		try {
			const memory = new MemoryLedger();
			const hanging: LedgerSink = { append: () => new Promise<void>(() => {}) };
			const append = new CompositeLedger([hanging, memory]).append(record);

			await vi.advanceTimersByTimeAsync(LEDGER_APPEND_TIMEOUT_MS);
			await expect(append).resolves.toBeUndefined();
			expect(memory.records).toEqual([record]);
		} finally {
			vi.useRealTimers();
		}
	});
});
