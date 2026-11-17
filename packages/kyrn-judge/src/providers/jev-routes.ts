import { isLasting, isRefusal, type JudgeError } from "../errors.ts";
import type { JudgeProvider, JudgeRequest, ProviderResponse } from "../types.ts";

/**
 * The `jev` judge: the services that reach Jev, in order. A call asks the first, and goes on to the next only when a
 * service cannot answer until the user sets something up: it has no key, it turned its key down, or its account cannot
 * pay (`isLasting`). A key that stops working then costs the judge nothing: the next service answers, as it does when
 * no key is set. Decided per call, so a key stored during the session is used from the next call on.
 *
 * A service that is slow or down fails the call instead. The next call may find it up, and another service is another
 * place what the judge reads would go.
 */
export class JevRoutes implements JudgeProvider {
	private readonly routes: readonly JudgeProvider[];
	private last: JudgeProvider;

	/** `first` is the service named before any call: the one the keys that are set point to. */
	constructor(routes: readonly JudgeProvider[], first: JudgeProvider) {
		this.routes = routes;
		this.last = first;
	}

	/** The service that answered last. */
	get id(): string {
		return this.last.id;
	}

	async evaluate(request: JudgeRequest): Promise<ProviderResponse> {
		const lasting: JudgeError[] = [];
		for (const route of this.routes) {
			try {
				const response = await route.evaluate(request);
				this.last = route;
				return response;
			} catch (error) {
				if (!isLasting(error)) throw error;
				lasting.push(error);
			}
		}
		// None can answer. What a service said to a key that is set tells more than a service nobody set a key for.
		throw lasting.find(isRefusal) ?? lasting.at(-1);
	}
}
