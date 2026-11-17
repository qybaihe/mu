import { isJudgeError, type JudgeErrorKind } from "../errors.ts";
import type { JudgeProvider, JudgeRequest, ProviderResponse } from "../types.ts";

/** How a call to the free Jev went: answered, or the kind of its failure. */
export type FreeJevOutcome = "answered" | JudgeErrorKind;

/**
 * Jev 1.13 on OpenCode Zen, free for a limited time and with no key: the last of the `jev` judge's services
 * (`JevRoutes`), asked when no key reaches Jev another way. `onFree` hears how each call went, for the notice.
 */
export class FreeJev implements JudgeProvider {
	private readonly free: JudgeProvider;
	private readonly onFree: ((outcome: FreeJevOutcome) => void) | undefined;

	constructor(free: JudgeProvider, onFree?: (outcome: FreeJevOutcome) => void) {
		this.free = free;
		this.onFree = onFree;
	}

	get id(): string {
		return this.free.id;
	}

	async evaluate(request: JudgeRequest): Promise<ProviderResponse> {
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
