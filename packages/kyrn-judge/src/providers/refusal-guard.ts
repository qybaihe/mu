import { isRefusal, type JudgeError } from "../errors.ts";
import type { JudgeProvider, JudgeRequest, ProviderResponse } from "../types.ts";

/** Refusals without an answer in between before a service is left alone: one may be a passing mistake of the service's. */
const REFUSALS_TO_REST = 2;
/** How long a service that refused is left alone before one call asks it again. */
export const REFUSED_RETRY_MS = 60_000;

/**
 * A judge service that is not asked again right after it turned its key down.
 *
 * A key the service refuses, or an account that cannot pay, fails every call the same way until the user changes
 * something. Asked each time, it costs every decision a round trip (a second from a long route) for an answer that
 * will not come, and nothing says why. So after two refusals the service is left alone: a call fails at once with the
 * refusal it gave, and the next judge or the fallback decides without the wait. One call a minute asks again, which
 * finds a key that was replaced or an account that was topped up without a restart. `onRefused` hears the refusal
 * each time the service starts to be left alone.
 *
 * Only what the service itself refused counts (`isRefusal`). A key missing on this machine fails before any request:
 * there is no round trip to save, and a key stored during the session has to be used from the next call on. A timeout
 * or an outage says nothing about the key.
 */
export class RefusalGuard implements JudgeProvider {
	private readonly provider: JudgeProvider;
	private readonly onRefused: ((refusal: JudgeError) => void) | undefined;
	/** Refusals since the last answer. */
	private refusals = 0;
	/** What calls fail with while the service is left alone. */
	private standing: JudgeError | undefined;
	private askAgainAt = 0;

	constructor(provider: JudgeProvider, onRefused?: (refusal: JudgeError) => void) {
		this.provider = provider;
		this.onRefused = onRefused;
	}

	get id(): string {
		return this.provider.id;
	}

	async evaluate(request: JudgeRequest): Promise<ProviderResponse> {
		if (this.standing) {
			if (Date.now() < this.askAgainAt) throw this.standing;
			// This call asks again. The ones that come while it is out still get the refusal.
			this.askAgainAt = Date.now() + REFUSED_RETRY_MS;
		}
		try {
			const response = await this.provider.evaluate(request);
			this.refusals = 0;
			this.standing = undefined;
			return response;
		} catch (error) {
			if (isRefusal(error)) this.refused(error);
			throw error;
		}
	}

	private refused(refusal: JudgeError): void {
		this.refusals++;
		if (this.refusals < REFUSALS_TO_REST) return;
		const started = this.standing === undefined;
		this.standing = refusal;
		this.askAgainAt = Date.now() + REFUSED_RETRY_MS;
		if (started) this.onRefused?.(refusal);
	}
}
