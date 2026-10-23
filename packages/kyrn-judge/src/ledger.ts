import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { JudgeTierReport } from "./judge.ts";
import type { Answer, JsonValue, JudgeUsage, JudgeWarning } from "./types.ts";

/**
 * One decision, as recorded. Later signals (a pruned item being recalled, a
 * routed model needing escalation) are joined on `id` to label it, which is
 * how thresholds get calibrated per user and per project.
 */
export interface LedgerRecord {
	readonly id: string;
	/** When the record was written. A slow judge answers long after it was asked; see `origin`. */
	readonly timestamp: string;
	/** What the engine's `origin` option returned when the question was asked, such as the asking turn. */
	readonly origin?: JsonValue;
	readonly specId: string;
	readonly specVersion: number;
	readonly mode: "shadow" | "active";
	readonly providerId: string;
	readonly modelId?: string;
	/** What the caller acted on. */
	readonly outcome: JsonValue;
	readonly source: "judge" | "fallback";
	/** Why the fallback was used: "shadow", "abstain", or "error:<kind>". */
	readonly reason?: string;
	/** What the judge path produced, when the call succeeded. */
	readonly judged?: JsonValue;
	readonly answers?: Readonly<Record<string, Answer>>;
	readonly latencyMs?: number;
	readonly usage?: JudgeUsage;
	/** What the provider cut or ignored, such as a state that did not fit its window. */
	readonly warnings?: readonly JudgeWarning[];
	/** Which judges of a cascade answered how many questions. */
	readonly tiers?: readonly JudgeTierReport[];
	/** Set when the record covers many inputs of one spec (`decideMany`); `outcome` and `judged` are arrays then. */
	readonly batch?: {
		readonly size: number;
		readonly failures: number;
		/** Per-item answers, kept only for small batches. */
		readonly answers?: readonly (Readonly<Record<string, Answer>> | null)[];
	};
	/** SHA-256 of the submitted state. The state itself is stored only when the engine is told to. */
	readonly stateDigest: string;
	readonly state?: JsonValue;
	/**
	 * The questions as asked, stored with the state for a decision that builds them from its input (`questionsFor`:
	 * one question per skill, capability or memory). A decision with fixed questions is known by `specId` and
	 * `specVersion`.
	 */
	readonly questions?: JsonValue;
}

export interface LedgerSink {
	append(record: LedgerRecord): void | Promise<void>;
}

export class MemoryLedger implements LedgerSink {
	readonly records: LedgerRecord[] = [];
	private readonly capacity: number;

	constructor(capacity = 500) {
		this.capacity = capacity;
	}

	append(record: LedgerRecord): void {
		this.records.push(record);
		if (this.records.length > this.capacity) this.records.shift();
	}
}

export class JsonlLedger implements LedgerSink {
	private readonly path: string;
	private directoryReady = false;

	constructor(path: string) {
		this.path = path;
	}

	async append(record: LedgerRecord): Promise<void> {
		if (!this.directoryReady) {
			await mkdir(dirname(this.path), { recursive: true });
			this.directoryReady = true;
		}
		await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
	}
}

/** Fans one record out to several sinks. A failing sink does not affect the others. */
export class CompositeLedger implements LedgerSink {
	private readonly sinks: readonly LedgerSink[];

	constructor(sinks: readonly LedgerSink[]) {
		this.sinks = sinks;
	}

	async append(record: LedgerRecord): Promise<void> {
		await Promise.allSettled(this.sinks.map(async (sink) => sink.append(record)));
	}
}
