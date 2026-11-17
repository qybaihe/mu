import { type Calibration, curveOf, readThrough } from "./calibration.ts";
import { isLasting, JudgeError } from "./errors.ts";
import type { JudgeCall, JudgeLike, JudgeResult, JudgeTierReport } from "./judge.ts";
import { addUsage, validateQuestions } from "./judge.ts";
import { neutralAnswer } from "./policy.ts";
import type { Answer, AnswersFor, Capability, JudgeUsage, JudgeWarning, Question, Questions } from "./types.ts";

/**
 * What a judge is asked, and how its answers are read. Profiles are per model and measured, not assumed: a small base
 * classifier can read a single text well and still answer "yes" to nearly every relational question, or fail to use
 * an ordinal rubric (kyrn/docs/03-local-judge.md). Over-confidence is the one failure that does not show in the
 * probabilities, so it has to be declared here: as a capability the judge is not asked about, or as the curve its
 * probabilities are read through.
 */
export interface JudgeProfile {
	/** Capabilities this judge is trusted on; `false` sends the question to the next judge. Default: all. */
	readonly capabilities?: Partial<Record<Capability, boolean>>;
	/** How its probabilities are read, where that was measured (calibration.ts). Default: as it gives them. */
	readonly calibration?: Calibration;
}

/** Ordinal rubrics need `rate`; everything else defaults to `classify` unless the decision says otherwise. */
export function capabilityOf(question: Question, declared?: Capability): Capability {
	return declared ?? (question.type === "score" ? "rate" : "classify");
}

export function isTrusted(profile: JudgeProfile | undefined, capability: Capability): boolean {
	return profile?.capabilities?.[capability] !== false;
}

export interface CascadeTier {
	readonly judge: JudgeLike;
	readonly profile?: JudgeProfile;
}

export type TierReport = JudgeTierReport;

/**
 * Judges in order. The first one that can answer a question answers it, and the ones behind it stand in when it
 * cannot: it failed (down, slow, no key), or it is not trusted with what the question takes (`JudgeProfile`).
 *
 * An answer stands as it was given, sure or not. Up to mu 0.3.12 a yes/no answer between 0.2 and 0.8, or a weak pick,
 * went on to the next judge. A policy reads such an answer as "unsure" and the decision takes its fallback, which
 * changes nothing. Passing it on put the next judge's confident answer in that place, on exactly the questions the
 * first judge found hard. Measured with a fine-tuned 4B judge and Nemotron 3 Ultra behind it (docs/nebius.md): on
 * real held-out requests the 4B judge alone scored 68.2, and 20.0 with Ultra answering what it was unsure of, a few
 * confident mistakes in costly places outweighing the rest.
 *
 * A question no judge is trusted on gets a neutral answer, which every policy reads as "unsure": a judge's known
 * weakness must never drive behavior.
 */
export class CascadeJudge implements JudgeLike {
	private readonly tiers: readonly CascadeTier[];

	constructor(tiers: readonly CascadeTier[]) {
		if (tiers.length === 0) throw new TypeError("A cascade needs at least one judge");
		this.tiers = tiers;
	}

	/**
	 * The tiers by their ids, as they are now: a judge with several services (`jev`) goes by the one that answered
	 * last, so the ledger names the service a verdict came from.
	 */
	get id(): string {
		const ids = this.tiers.map((tier) => tier.judge.id);
		return ids.length === 1 ? ids[0] : `cascade(${ids.join(">")})`;
	}

	/** Whether any tier is trusted on a capability: when none is, every such question gets a neutral answer. */
	trusts(capability: Capability): boolean {
		return this.tiers.some((tier) => isTrusted(tier.profile, capability));
	}

	async evaluate<const Qs extends Questions>(request: JudgeCall<Qs>): Promise<JudgeResult<Qs>> {
		validateQuestions(request.questions);
		const startedAt = performance.now();
		const settled: Record<string, Answer> = {};
		const usage: JudgeUsage = { inputTokens: 0, outputTokens: 0 };
		const warnings: JudgeWarning[] = [];
		const reports: TierReport[] = [];
		let requests = 0;
		let queuedMs = 0;
		let modelId: string | undefined;
		const errors: unknown[] = [];
		let pending: string[] = Object.keys(request.questions);

		const capability = (id: string) => capabilityOf(request.questions[id], request.capabilities?.[id]);

		for (const tier of this.tiers) {
			if (pending.length === 0) break;
			if (request.signal?.aborted) throw new JudgeError("aborted", "Judge call was aborted");
			// Questions this tier is not trusted on skip it without costing a call.
			const mine = pending.filter((id) => isTrusted(tier.profile, capability(id)));
			if (mine.length === 0) continue;
			const questions = Object.fromEntries(mine.map((id) => [id, request.questions[id]])) as Questions;

			let result: JudgeResult<Questions>;
			try {
				result = await tier.judge.evaluate({
					state: request.state,
					questions,
					signal: request.signal,
					latency: request.latency,
					neededBy: request.neededBy,
				});
			} catch (error) {
				errors.push(error);
				reports.push({
					judgeId: tier.judge.id,
					asked: mine.length,
					kept: 0,
					error: error instanceof JudgeError ? error.kind : "unexpected",
				});
				continue;
			}

			requests += result.requests;
			addUsage(usage, result.usage);
			warnings.push(...result.warnings);
			modelId ??= result.modelId;
			for (const id of mine) {
				const curve = curveOf(tier.profile?.calibration, {
					decision: request.decision,
					question: id,
					model: result.modelId,
				});
				const answer = curve ? readThrough(result.answers[id], curve) : result.answers[id];
				settled[id] = { ...answer, judge: tier.judge.id };
			}
			queuedMs += result.queuedMs ?? 0;
			reports.push({
				judgeId: tier.judge.id,
				asked: mine.length,
				kept: mine.length,
				latencyMs: result.latencyMs,
				...(result.queuedMs === undefined ? {} : { queuedMs: result.queuedMs }),
			});
			pending = pending.filter((id) => !mine.includes(id));
		}

		if (pending.length > 0) {
			// Nothing at all came back: that is an outage. Otherwise fail open question by question.
			if (reports.length > 0 && reports.every((report) => report.error !== undefined)) {
				// What the next call can expect, whatever the order of the tiers: a judge that may answer then (down, slow)
				// says more than one that cannot until the user sets it up (no key, no credit).
				const telling = [...errors].reverse().find((error) => !isLasting(error)) ?? errors.at(-1);
				if (telling instanceof JudgeError) throw telling;
				throw new JudgeError("unreachable", "No judge in the cascade answered", { cause: telling });
			}
			const trustedSomewhere = (id: string) => this.tiers.some((tier) => isTrusted(tier.profile, capability(id)));
			for (const id of pending) {
				const judge = trustedSomewhere(id) ? "unavailable" : "untrusted";
				settled[id] = { ...neutralAnswer(request.questions[id]), judge };
			}
		}

		return {
			answers: settled as AnswersFor<Qs>,
			usage,
			latencyMs: Math.round(performance.now() - startedAt),
			requests,
			providerId: this.id,
			modelId,
			warnings,
			tiers: reports,
			...(queuedMs > 0 ? { queuedMs } : {}),
		};
	}
}
