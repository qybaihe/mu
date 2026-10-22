import { createHash, randomUUID } from "node:crypto";
import { isJudgeError } from "./errors.ts";
import type { JudgeLike, JudgeTierReport } from "./judge.ts";
import { validateQuestions } from "./judge.ts";
import type { LedgerRecord, LedgerSink } from "./ledger.ts";
import { hasEscapeOption } from "./policy.ts";
import { environmentSecrets, redactJson } from "./redact.ts";
import type {
	Answer,
	AnswersFor,
	Capability,
	JsonValue,
	JudgeInput,
	JudgeUsage,
	JudgeWarning,
	Questions,
} from "./types.ts";

export const ABSTAIN: unique symbol = Symbol("kyrn.judge.abstain");

/** Batches up to this size record each item's answers in the ledger. */
const MAX_BATCH_ANSWERS = 8;
export type Abstain = typeof ABSTAIN;

/**
 * - `off`: the judge is not called; the fallback is returned.
 * - `shadow`: the judge is called and recorded, but the fallback is returned.
 *   New decision points start here until their verdicts have been compared
 *   with outcomes.
 * - `active`: the judged outcome is returned unless the policy abstains or the call fails.
 */
export type DecisionMode = "off" | "shadow" | "active";

/**
 * What acting on the decision does to the provider prompt cache.
 * `prefix-mutating` decisions rewrite earlier context and should only be
 * applied at cache boundaries (session start, after compaction, cold cache).
 */
export type CacheImpact = "none" | "append-only" | "prefix-mutating";

/** `inline` blocks the agent loop, `parallel` races other work, `background` never blocks. */
export type LatencyClass = "inline" | "parallel" | "background";

export interface DecisionSpec<In, Qs extends Questions, Out extends JsonValue> {
	readonly id: string;
	/** Bump whenever question wording or policy changes, so ledger records stay comparable. */
	readonly version: number;
	readonly questions: Qs;
	/**
	 * Questions built from the input, one per candidate (a skill, a memory, a
	 * file path), for decisions over a list whose length is only known at run
	 * time. Carrying the candidate in the question keeps one state for all of
	 * them, which a large-window judge answers in a single request. When set,
	 * `questions` may be empty and `policy` receives answers keyed by these ids.
	 */
	readonly questionsFor?: (input: In) => Questions;
	/** What the questions take to answer: one value for all, or per question id. See `Capability`. */
	readonly capabilities?: Capability | Readonly<Partial<Record<string, Capability>>>;
	readonly cacheImpact: CacheImpact;
	readonly latency: LatencyClass;
	/** Set only when every choice question's option set is truly closed. */
	readonly allowChoicesWithoutEscape?: boolean;
	/**
	 * The caller acts on the judge's verdict in shadow mode too, because it has no behaviour of its own to keep
	 * (the browser's next click, a sub-agent's role, the model's own question). In shadow its verdict is then the
	 * outcome, and the ledger says it came from the judge, not from the fallback. `off` still never asks.
	 */
	readonly actsInShadow?: boolean;
	/** Digest the input into a small state. The judge has a 32K window: send summaries and metadata, not bulk text. */
	buildState(input: In): JudgeInput;
	policy(answers: AnswersFor<Qs>, input: In): Out | Abstain;
	/** Deterministic default, equal to the host's behavior without a judge. */
	fallback(input: In): Out;
}

export function defineDecision<In, const Qs extends Questions, Out extends JsonValue>(
	spec: DecisionSpec<In, Qs, Out>,
): DecisionSpec<In, Qs, Out> {
	if (!Number.isInteger(spec.version) || spec.version < 1) {
		throw new TypeError(`Decision "${spec.id}" needs a positive integer version`);
	}
	if (!spec.questionsFor) validateQuestions(spec.questions);
	if (!spec.allowChoicesWithoutEscape) {
		for (const [questionId, question] of Object.entries(spec.questions)) {
			if (question.type === "choice" && !hasEscapeOption(question)) {
				throw new TypeError(
					`Choice question "${questionId}" in decision "${spec.id}" has no escape option (none, other, unclear, unknown)`,
				);
			}
		}
	}
	return spec;
}

export interface Decision<Out> {
	readonly specId: string;
	readonly mode: DecisionMode;
	/** What the caller must act on. */
	readonly outcome: Out;
	readonly source: "judge" | "fallback";
	readonly reason?: string;
	/** What the judge path produced; `undefined` when it abstained or the call failed. */
	readonly judged?: Out;
	readonly answers?: Readonly<Record<string, Answer>>;
	readonly latencyMs?: number;
	readonly usage?: JudgeUsage;
	readonly warnings?: readonly JudgeWarning[];
	/** Which judges answered, when a cascade was used. */
	readonly tiers?: readonly JudgeTierReport[];
	readonly ledgerId?: string;
}

export interface EngineStats {
	calls: number;
	failures: number;
	abstentions: number;
	inputTokens: number;
	/** Trivial questions that only check the judge answers or keep its connection warm (`probe`), and what they cost. */
	probes: number;
	probeInputTokens: number;
	lastError?: { kind: string; message: string; at: string };
}

export interface DecisionEngineOptions {
	/** One judge, or a cascade of them. Swappable at runtime with `setJudge`. */
	judge: JudgeLike;
	ledger?: LedgerSink;
	defaultMode?: DecisionMode;
	modes?: Readonly<Record<string, DecisionMode>>;
	/**
	 * The modes single points start with (DEFAULT_CONFIG.modes, such as a point in shadow). They refine a judge that is
	 * on: with the default mode "off", such a point is off too, so no judge is asked. A mode set to another value holds.
	 */
	builtInModes?: Readonly<Record<string, DecisionMode>>;
	/** Store submitted states in the ledger. Needed for replay and calibration; off by default because states can hold user content. */
	recordState?: boolean;
	/**
	 * Where the caller is, read when a decision is asked and stored with its record.
	 * A record is written when the answer arrives, and by then the caller may have moved on to the next turn.
	 */
	origin?: () => JsonValue | undefined;
	/**
	 * Values taken out of everything a judge is shown, wherever they appear. Default: this process's credential
	 * variables. Tokens in a shape only credentials have go whatever this returns.
	 */
	knownSecrets?: () => readonly string[];
}

/**
 * Runs decisions fail-open: `decide` never rejects because of the judge.
 * Timeouts, outages, invalid answers and abstentions all yield the spec's fallback.
 */
interface Evaluation<Out> {
	judged?: Out;
	answers?: Readonly<Record<string, Answer>>;
	latencyMs?: number;
	usage?: JudgeUsage;
	modelId?: string;
	warnings?: readonly JudgeWarning[];
	tiers?: readonly JudgeTierReport[];
	failure?: string;
}

export class DecisionEngine {
	readonly stats: EngineStats = {
		calls: 0,
		failures: 0,
		abstentions: 0,
		inputTokens: 0,
		probes: 0,
		probeInputTokens: 0,
	};
	/**
	 * When the shared judge was last asked anything, a probe included, or last answered (`Date.now()`; 0 before the
	 * first). Its connection is warm while this is recent, and whoever keeps it warm needs no probe of its own then.
	 */
	lastUsedAt = 0;
	private judge: JudgeLike;
	/** Decisions that are answered by their own judge instead of the shared one. */
	private readonly routed = new Map<string, JudgeLike>();
	private readonly ledger: LedgerSink | undefined;
	private defaultMode: DecisionMode;
	private readonly modes: Map<string, DecisionMode>;
	private readonly builtInModes: Readonly<Record<string, DecisionMode>>;
	private readonly recordState: boolean;
	private readonly origin: (() => JsonValue | undefined) | undefined;
	private readonly knownSecrets: () => readonly string[];

	constructor(options: DecisionEngineOptions) {
		this.judge = options.judge;
		this.ledger = options.ledger;
		this.defaultMode = options.defaultMode ?? "shadow";
		this.modes = new Map(Object.entries(options.modes ?? {}));
		this.builtInModes = options.builtInModes ?? {};
		this.recordState = options.recordState ?? false;
		this.origin = options.origin;
		this.knownSecrets = options.knownSecrets ?? (() => environmentSecrets());
	}

	get providerId(): string {
		return this.judge.id;
	}

	/**
	 * One trivial question straight to the judge: is anyone answering, and how fast?
	 * Not a decision, so it is not written to the ledger; `stats.probes` counts it apart from the decisions.
	 */
	async probe(signal?: AbortSignal): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
		const startedAt = performance.now();
		this.stats.probes++;
		this.lastUsedAt = Date.now();
		try {
			const result = await this.judge.evaluate({
				state: { text: "ping" },
				questions: { ready: { type: "boolean", instructions: "Is `text` the word ping?" } },
				signal,
			});
			this.stats.probeInputTokens += result.usage.inputTokens ?? 0;
			return { ok: true, latencyMs: Math.round(performance.now() - startedAt) };
		} catch (error) {
			const kind = isJudgeError(error) ? error.kind : "error";
			return { ok: false, latencyMs: Math.round(performance.now() - startedAt), error: kind };
		} finally {
			this.lastUsedAt = Date.now();
		}
	}

	/** Give one decision its own judge, or pass undefined to return it to the shared one. */
	setJudgeFor(specId: string, judge: JudgeLike | undefined): void {
		if (judge) this.routed.set(specId, judge);
		else this.routed.delete(specId);
	}

	/** The judge that answers this decision. */
	judgeFor(specId: string): JudgeLike {
		return this.routed.get(specId) ?? this.judge;
	}

	routes(): ReadonlyMap<string, JudgeLike> {
		return this.routed;
	}

	/** Swap the decision model without touching any decision point. */
	setJudge(judge: JudgeLike): void {
		this.judge = judge;
	}

	getMode(specId: string): DecisionMode {
		const mode = this.modes.get(specId);
		if (mode === undefined || (this.defaultMode === "off" && this.builtInModes[specId] === mode))
			return this.defaultMode;
		return mode;
	}

	/** Whether any decision point asks the judge: false when every one is off. */
	asksJudge(): boolean {
		return this.defaultMode !== "off" || [...this.modes.keys()].some((specId) => this.getMode(specId) !== "off");
	}

	setMode(specId: string, mode: DecisionMode): void {
		this.modes.set(specId, mode);
	}

	setDefaultMode(mode: DecisionMode): void {
		this.defaultMode = mode;
	}

	/** Spec ids with an explicit mode, for status displays. */
	explicitModes(): ReadonlyMap<string, DecisionMode> {
		return this.modes;
	}

	private async evaluate<In, const Qs extends Questions, Out extends JsonValue>(
		spec: DecisionSpec<In, Qs, Out>,
		input: In,
		state: JudgeInput,
		signal: AbortSignal | undefined,
	): Promise<Evaluation<Out>> {
		const questions: Questions = spec.questionsFor ? spec.questionsFor(input) : spec.questions;
		if (Object.keys(questions).length === 0) return { failure: "abstain" };
		const declared = spec.capabilities;
		const capabilities =
			typeof declared === "string"
				? Object.fromEntries(Object.keys(questions).map((id) => [id, declared]))
				: (declared as Record<string, Capability> | undefined);

		this.stats.calls++;
		const shared = !this.routed.has(spec.id);
		if (shared) this.lastUsedAt = Date.now();
		try {
			// A judge weighs what a call does, never the key it does it with.
			const known = this.knownSecrets();
			const result = await this.judgeFor(spec.id).evaluate({
				state: redactJson(state, known),
				questions: redactJson(questions, known),
				signal,
				capabilities,
			});
			this.stats.inputTokens += result.usage.inputTokens ?? 0;
			const evaluation: Evaluation<Out> = {
				answers: result.answers,
				latencyMs: result.latencyMs,
				usage: result.usage,
				modelId: result.modelId,
				warnings: result.warnings.length > 0 ? result.warnings : undefined,
				tiers: result.tiers,
			};
			const verdict = spec.policy(result.answers as AnswersFor<Qs>, input);
			if (verdict === ABSTAIN) {
				this.stats.abstentions++;
				evaluation.failure = "abstain";
			} else {
				evaluation.judged = verdict;
			}
			return evaluation;
		} catch (error) {
			const kind = isJudgeError(error) ? error.kind : "unexpected";
			const message = error instanceof Error ? error.message : String(error);
			this.stats.failures++;
			this.stats.lastError = { kind, message, at: new Date().toISOString() };
			return { failure: `error:${kind}` };
		} finally {
			if (shared) this.lastUsedAt = Date.now();
		}
	}

	/** Whether a verdict is what the caller acts on in this mode. */
	private applies(spec: { readonly actsInShadow?: boolean }, mode: DecisionMode): boolean {
		return mode === "active" || (mode === "shadow" && spec.actsInShadow === true);
	}

	private asked(): JsonValue | undefined {
		try {
			return this.origin?.();
		} catch {
			// Bookkeeping, like the ledger itself: it must not change what the agent does.
			return undefined;
		}
	}

	/** The request as the judge receives it, secrets redacted: what `recordState` keeps for distilling a judge. */
	private requestAsSent<In, const Qs extends Questions, Out extends JsonValue>(
		spec: DecisionSpec<In, Qs, Out>,
		input: In,
		state: JudgeInput,
	): { state: JsonValue; questions: JsonValue } {
		const known = this.knownSecrets();
		const questions: Questions = spec.questionsFor ? spec.questionsFor(input) : spec.questions;
		return {
			state: redactJson(state, known) as JsonValue,
			questions: redactJson(questions, known) as unknown as JsonValue,
		};
	}

	private async record(record: LedgerRecord): Promise<void> {
		try {
			await this.ledger?.append(record);
		} catch {
			// A broken ledger must not change what the agent does.
		}
	}

	async decide<In, const Qs extends Questions, Out extends JsonValue>(
		spec: DecisionSpec<In, Qs, Out>,
		input: In,
		options: { signal?: AbortSignal } = {},
	): Promise<Decision<Out>> {
		const mode = this.getMode(spec.id);
		const fallback = spec.fallback(input);
		if (mode === "off") return { specId: spec.id, mode, outcome: fallback, source: "fallback", reason: "off" };

		const origin = this.asked();
		const state = spec.buildState(input);
		const asked = this.recordState ? this.requestAsSent(spec, input, state) : undefined;
		const evaluation = await this.evaluate(spec, input, state, options.signal);
		const { judged } = evaluation;
		const useJudged = this.applies(spec, mode) && judged !== undefined;
		const outcome = useJudged && judged !== undefined ? judged : fallback;
		const reason = useJudged ? undefined : (evaluation.failure ?? "shadow");
		const source = useJudged ? "judge" : "fallback";

		const record: LedgerRecord = {
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			origin,
			specId: spec.id,
			specVersion: spec.version,
			mode,
			providerId: this.judgeFor(spec.id).id,
			modelId: evaluation.modelId,
			outcome,
			source,
			reason,
			judged,
			answers: evaluation.answers,
			latencyMs: evaluation.latencyMs,
			usage: evaluation.usage,
			warnings: evaluation.warnings,
			tiers: evaluation.tiers,
			stateDigest: createHash("sha256").update(JSON.stringify(state)).digest("hex"),
			state: asked?.state,
			questions: asked?.questions,
		};
		await this.record(record);

		return {
			specId: spec.id,
			mode,
			outcome,
			source,
			reason,
			judged,
			answers: evaluation.answers,
			latencyMs: evaluation.latencyMs,
			usage: evaluation.usage,
			warnings: evaluation.warnings,
			tiers: evaluation.tiers,
			ledgerId: record.id,
		};
	}

	/**
	 * The same decision over many inputs (chunks of one tool output, candidate
	 * memories, skills), written to the ledger as one record so a 30-chunk
	 * output does not bury everything else. Order is preserved.
	 */
	async decideMany<In, const Qs extends Questions, Out extends JsonValue>(
		spec: DecisionSpec<In, Qs, Out>,
		inputs: readonly In[],
		options: { signal?: AbortSignal; concurrency?: number } = {},
	): Promise<Decision<Out>[]> {
		const mode = this.getMode(spec.id);
		if (mode === "off" || inputs.length === 0) {
			return inputs.map((input) => ({
				specId: spec.id,
				mode,
				outcome: spec.fallback(input),
				source: "fallback" as const,
				reason: "off",
			}));
		}

		const origin = this.asked();
		const startedAt = performance.now();
		const evaluations: Evaluation<Out>[] = new Array(inputs.length);
		let next = 0;
		const worker = async () => {
			while (next < inputs.length) {
				const index = next++;
				evaluations[index] = await this.evaluate(
					spec,
					inputs[index],
					spec.buildState(inputs[index]),
					options.signal,
				);
			}
		};
		const workers = Math.max(1, Math.min(options.concurrency ?? 4, inputs.length));
		await Promise.all(Array.from({ length: workers }, worker));

		const ledgerId = randomUUID();
		const decisions = inputs.map((input, index): Decision<Out> => {
			const evaluation = evaluations[index];
			const useJudged = this.applies(spec, mode) && evaluation.judged !== undefined;
			return {
				specId: spec.id,
				mode,
				outcome: useJudged && evaluation.judged !== undefined ? evaluation.judged : spec.fallback(input),
				source: useJudged ? "judge" : "fallback",
				reason: useJudged ? undefined : (evaluation.failure ?? "shadow"),
				judged: evaluation.judged,
				answers: evaluation.answers,
				latencyMs: evaluation.latencyMs,
				usage: evaluation.usage,
				warnings: evaluation.warnings,
				ledgerId,
			};
		});

		const inputTokens = evaluations.reduce((sum, evaluation) => sum + (evaluation.usage?.inputTokens ?? 0), 0);
		const failures = evaluations.filter((evaluation) => evaluation.failure?.startsWith("error:")).length;
		await this.record({
			id: ledgerId,
			timestamp: new Date().toISOString(),
			origin,
			specId: spec.id,
			specVersion: spec.version,
			mode,
			providerId: this.judgeFor(spec.id).id,
			modelId: evaluations.find((evaluation) => evaluation.modelId)?.modelId,
			outcome: decisions.map((decision) => decision.outcome),
			source: decisions.some((decision) => decision.source === "judge") ? "judge" : "fallback",
			reason:
				mode === "shadow" && !spec.actsInShadow ? "shadow" : failures === inputs.length ? "error:all" : undefined,
			judged: evaluations.map((evaluation) => evaluation.judged ?? null),
			latencyMs: Math.round(performance.now() - startedAt),
			usage: { inputTokens, outputTokens: 0 },
			batch: {
				size: inputs.length,
				failures,
				// Small batches (sub-agent routing) keep every verdict for inspection; large ones (output chunks) would bloat the session.
				answers:
					inputs.length <= MAX_BATCH_ANSWERS
						? evaluations.map((evaluation) => evaluation.answers ?? null)
						: undefined,
			},
			stateDigest: createHash("sha256")
				.update(JSON.stringify(inputs.map((input) => spec.buildState(input))))
				.digest("hex"),
		});
		return decisions;
	}
}
