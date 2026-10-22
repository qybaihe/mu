import { JudgeError } from "./errors.ts";
import type { JudgeCall, JudgeLike, JudgeResult, JudgeTierReport } from "./judge.ts";
import { validateQuestions } from "./judge.ts";
import { DEFAULT_THRESHOLDS, neutralAnswer, type Thresholds } from "./policy.ts";
import type { Answer, AnswersFor, Capability, JudgeUsage, JudgeWarning, Question, Questions } from "./types.ts";

/**
 * What a judge is good at. Profiles are per model and measured, not assumed:
 * the base Laya checkpoint classifies a single text well but answers "yes" to
 * nearly every relational question and cannot use an ordinal rubric
 * (kyrn/docs/03-local-judge.md). Over-confidence is the one failure a cascade
 * cannot see in the probabilities, so it has to be declared here.
 */
export interface JudgeProfile {
	/** Capabilities this judge is trusted on; `false` sends the question to the next tier. Default: all. */
	readonly capabilities?: Partial<Record<Capability, boolean>>;
	/** A boolean answer strictly inside this band is uncertain and escalates. */
	readonly thresholds?: Thresholds;
	/** A choice whose picked option is below this is uncertain and escalates. */
	readonly minChoiceProbability?: number;
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

export function isUncertain(_question: Question, answer: Answer, profile: JudgeProfile = {}): boolean {
	if (answer.type === "boolean") {
		const band = profile.thresholds ?? DEFAULT_THRESHOLDS;
		return answer.probability > band.no && answer.probability < band.yes;
	}
	if (answer.type === "choice") {
		const probability = answer.probabilities?.[answer.choice];
		return probability !== undefined && probability < (profile.minChoiceProbability ?? 0.6);
	}
	return false;
}

/**
 * Judges in order of cost: a fast local model first, a stronger one behind it.
 * Each tier only sees the questions the previous tier could not settle, so the
 * expensive judge is paid for the grey zone alone. A tier that fails is
 * skipped; an uncertain answer beats none, so it is kept when every later
 * tier fails too.
 *
 * A question no tier is trusted on gets a neutral answer, which every policy
 * reads as "unsure": a judge's known weakness must never drive behavior.
 */
export class CascadeJudge implements JudgeLike {
	readonly id: string;
	private readonly tiers: readonly CascadeTier[];

	constructor(tiers: readonly CascadeTier[]) {
		if (tiers.length === 0) throw new TypeError("A cascade needs at least one judge");
		this.tiers = tiers;
		this.id = tiers.length === 1 ? tiers[0].judge.id : `cascade(${tiers.map((tier) => tier.judge.id).join(">")})`;
	}

	/** Whether any tier is trusted on a capability: when none is, every such question gets a neutral answer. */
	trusts(capability: Capability): boolean {
		return this.tiers.some((tier) => isTrusted(tier.profile, capability));
	}

	async evaluate<const Qs extends Questions>(request: JudgeCall<Qs>): Promise<JudgeResult<Qs>> {
		validateQuestions(request.questions);
		const startedAt = performance.now();
		const settled: Record<string, Answer> = {};
		const tentative: Record<string, Answer> = {};
		const usage: JudgeUsage = { inputTokens: 0, outputTokens: 0 };
		const warnings: JudgeWarning[] = [];
		const reports: TierReport[] = [];
		let requests = 0;
		let modelId: string | undefined;
		const errors: unknown[] = [];
		let pending: string[] = Object.keys(request.questions);

		const capability = (id: string) => capabilityOf(request.questions[id], request.capabilities?.[id]);

		for (const [index, tier] of this.tiers.entries()) {
			if (pending.length === 0) break;
			if (request.signal?.aborted) throw new JudgeError("aborted", "Judge call was aborted");
			const isLast = index === this.tiers.length - 1;
			// Questions this tier is not trusted on skip it without costing a call.
			const mine = pending.filter((id) => isTrusted(tier.profile, capability(id)));
			if (mine.length === 0) continue;
			const questions = Object.fromEntries(mine.map((id) => [id, request.questions[id]])) as Questions;
			const others = pending.filter((id) => !mine.includes(id));

			let result: JudgeResult<Questions>;
			try {
				result = await tier.judge.evaluate({ state: request.state, questions, signal: request.signal });
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
			usage.inputTokens = (usage.inputTokens ?? 0) + (result.usage.inputTokens ?? 0);
			usage.outputTokens = (usage.outputTokens ?? 0) + (result.usage.outputTokens ?? 0);
			warnings.push(...result.warnings);
			modelId ??= result.modelId;

			const stillPending: string[] = [...others];
			let kept = 0;
			for (const id of mine) {
				const answer: Answer = { ...result.answers[id], judge: tier.judge.id };
				if (!isLast && isUncertain(request.questions[id], answer, tier.profile)) {
					tentative[id] = answer;
					stillPending.push(id);
				} else {
					settled[id] = answer;
					kept++;
				}
			}
			reports.push({ judgeId: tier.judge.id, asked: mine.length, kept, latencyMs: result.latencyMs });
			pending = stillPending;
		}

		const trustedSomewhere = (id: string) => this.tiers.some((tier) => isTrusted(tier.profile, capability(id)));
		for (const id of pending) {
			if (tentative[id]) settled[id] = tentative[id];
			else if (!trustedSomewhere(id)) settled[id] = { ...neutralAnswer(request.questions[id]), judge: "untrusted" };
		}
		const missing = Object.keys(request.questions).filter((id) => !(id in settled));
		if (missing.length > 0) {
			// Nothing at all came back: that is an outage. Otherwise fail open question by question.
			if (reports.every((report) => report.error !== undefined)) {
				// What the next call can expect, whatever the order of the tiers: a judge that may answer then (down, slow)
				// says more than one that cannot until the user sets it up (no key, no credit).
				const lasting = (error: unknown) =>
					error instanceof JudgeError && (error.kind === "auth" || error.kind === "payment_required");
				const telling = [...errors].reverse().find((error) => !lasting(error)) ?? errors.at(-1);
				if (telling instanceof JudgeError) throw telling;
				throw new JudgeError("unreachable", "No judge in the cascade answered", { cause: telling });
			}
			for (const id of missing) settled[id] = { ...neutralAnswer(request.questions[id]), judge: "unavailable" };
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
		};
	}
}
