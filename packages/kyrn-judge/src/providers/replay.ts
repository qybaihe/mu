import { digestOf } from "../decision.ts";
import type { LedgerRecord } from "../ledger.ts";
import { neutralAnswer } from "../policy.ts";
import type { Answer, JudgeProvider, JudgeRequest, ProviderResponse } from "../types.ts";

/** One judge call as a ledger recorded it: the digest of the state it was asked about, and the answers it got. */
export interface ReplayCall {
	readonly specId: string;
	readonly specVersion: number;
	readonly digest: string;
	readonly answers: Readonly<Record<string, Answer>>;
}

/** A request the recording has no answers for: the state a decision builds is not the one recorded. */
export interface ReplayMiss {
	readonly digest: string;
	readonly questions: readonly string[];
}

/**
 * The judge calls a ledger's records hold, for a replay: a decision's own, and each item of a batch small enough to
 * keep its items' answers and digests (`batch.digests`). A record without answers (the judge failed, or the decision
 * was off) made no call worth replaying; a large batch keeps no per-item answers, so its items cannot be replayed.
 */
export function replayCalls(records: readonly LedgerRecord[]): ReplayCall[] {
	const calls: ReplayCall[] = [];
	for (const record of records) {
		const { specId, specVersion } = record;
		if (record.batch) {
			const { answers, digests } = record.batch;
			if (!answers || !digests) continue;
			answers.forEach((each, index) => {
				const digest = digests[index];
				if (each && digest) calls.push({ specId, specVersion, digest, answers: each });
			});
		} else if (record.answers && Object.keys(record.answers).length > 0) {
			calls.push({ specId, specVersion, digest: record.stateDigest, answers: record.answers });
		}
	}
	return calls;
}

const sameQuestions = (call: ReplayCall, questions: readonly string[]) => {
	const answered = Object.keys(call.answers);
	return answered.length === questions.length && questions.every((id) => id in call.answers);
};

/**
 * A judge that answers as a recorded session's judge did (E2): each request gets the answers of the recorded call
 * about the same state, found by its digest (the ledger's `stateDigest`) and its questions. Decisions run in parallel,
 * and in another order from one run to the next, so a call is found by what it was asked, never by when.
 *
 * A request nothing was recorded for is a miss: what a decision builds for the judge changed since the recording, or
 * the run went another way. It is answered neutrally, as a judge that cannot tell, so the run goes on to show what
 * else changed, and kept in `misses` for the test to fail on. `unused()` names the recorded calls nothing asked for
 * again. The digest is of the state as built, before secrets are taken out: a state that held one is not replayed.
 */
export class ReplayJudgeProvider implements JudgeProvider {
	readonly id = "replay";
	readonly misses: ReplayMiss[] = [];
	private readonly calls: readonly ReplayCall[];
	private readonly used = new Set<ReplayCall>();

	constructor(calls: readonly ReplayCall[]) {
		this.calls = calls;
	}

	async evaluate(request: JudgeRequest): Promise<ProviderResponse> {
		const digest = digestOf(request.state);
		const questions = Object.keys(request.questions);
		const matching = this.calls.filter((call) => call.digest === digest && sameQuestions(call, questions));
		// The same question about the same state twice gets the same answers, once each while recorded calls are left.
		const call = matching.find((each) => !this.used.has(each)) ?? matching[0];
		if (!call) {
			this.misses.push({ digest, questions });
			const answers = Object.fromEntries(
				Object.entries(request.questions).map(([id, question]) => [id, neutralAnswer(question)]),
			);
			return { answers, modelId: "replay" };
		}
		this.used.add(call);
		return { answers: call.answers, modelId: "replay" };
	}

	/** The recorded calls this replay has not asked for. */
	unused(): ReplayCall[] {
		return this.calls.filter((call) => !this.used.has(call));
	}
}
