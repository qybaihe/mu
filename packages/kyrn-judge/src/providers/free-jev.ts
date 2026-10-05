import { isJudgeError, type JudgeErrorKind } from "../errors.ts";
import type { JudgeProvider, JudgeRequest, ProviderResponse } from "../types.ts";
import type { ApiKeyResolver } from "./gateway.ts";

/** How a call to the free Jev went: answered, or the kind of its failure. */
export type FreeJevOutcome = "answered" | JudgeErrorKind;

/**
 * The `jev` judge when none of Jev's keys is set: the Vercel AI Gateway when the host keeps a key for it (a sign-in in
 * mu), else Jev 1.13 on OpenCode Zen, free for a limited time and with no key. Decided per call, so a key stored during
 * the session is used from the next call on. `onFree` hears how each call to the free Jev went, for the notice.
 */
export class FreeJevFallback implements JudgeProvider {
	private readonly gateway: JudgeProvider;
	private readonly free: JudgeProvider;
	private readonly gatewayKey: ApiKeyResolver;
	private readonly onFree: ((outcome: FreeJevOutcome) => void) | undefined;
	private last: JudgeProvider;

	constructor(options: {
		gateway: JudgeProvider;
		free: JudgeProvider;
		gatewayKey: ApiKeyResolver;
		onFree?: (outcome: FreeJevOutcome) => void;
	}) {
		this.gateway = options.gateway;
		this.free = options.free;
		this.gatewayKey = options.gatewayKey;
		this.onFree = options.onFree;
		this.last = options.free;
	}

	/** The judge that answered last; the free one before any call. */
	get id(): string {
		return this.last.id;
	}

	async evaluate(request: JudgeRequest): Promise<ProviderResponse> {
		if (await this.gatewayKey()) {
			this.last = this.gateway;
			return this.gateway.evaluate(request);
		}
		this.last = this.free;
		try {
			const response = await this.free.evaluate(request);
			this.onFree?.("answered");
			return response;
		} catch (error) {
			if (isJudgeError(error)) this.onFree?.(error.kind);
			throw error;
		}
	}
}
