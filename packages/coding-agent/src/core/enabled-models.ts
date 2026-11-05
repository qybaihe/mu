import type { Api, Model } from "@earendil-works/pi-ai";
import { resolveModelScopeFromModels } from "./model-resolver.ts";

/**
 * mu: choosing, one provider at a time, which models `enabledModels` lets /model and an app's model menu offer.
 *
 * `enabledModels` stays pi's list of patterns, read the way pi reads it: unset offers every model, and a list offers
 * what it matches. These functions only write it. A provider's models are written as `<provider>/**` (all of them,
 * the ones it gains later too, ids with a slash of their own as OpenRouter's included) or as one `<provider>/<id>`
 * per chosen model.
 *
 * Example: with nothing set, signed in to ChatGPT (`openai`) and Antigravity, choosing two Antigravity models gives
 *
 *   ["openai/**", "google-antigravity/gemini-3.1-pro-high", "google-antigravity/claude-sonnet-4-6"]
 */

const fullId = (model: Model<Api>): string => `${model.provider}/${model.id}`;

/** A pattern names only this provider's models when it starts with `<provider>/`. */
const namesProvider = (pattern: string, provider: string): boolean =>
	pattern.toLowerCase().startsWith(`${provider.toLowerCase()}/`);

/** `<provider>/**`, or `<provider>/*` as written before: every model of one provider. The provider is group 1. */
const wholeProvider = /^([^/*?[\]]+)\/\*\*?$/;

/** Every model of one provider, now and later: `*` would leave out ids with a slash (OpenRouter's `qwen/qwen3-coder`). */
const everyModelOf = (provider: string): string => `${provider}/**`;

/**
 * The models `patterns` enable, as `provider/id`, in the list's order. Undefined when nothing restricts them: no
 * patterns, or patterns that match none of `models`, which pi treats as no scope at all.
 */
export function enabledModelIds(
	patterns: readonly string[] | undefined,
	models: readonly Model<Api>[],
): string[] | undefined {
	if (!patterns?.length) return undefined;
	const { scopedModels } = resolveModelScopeFromModels([...patterns], models);
	return scopedModels.length > 0 ? scopedModels.map((scoped) => fullId(scoped.model)) : undefined;
}

/**
 * `patterns` with one provider's models set to `selection`, every other model as it was. `selection` is the ids to
 * enable, or "all": every model of the provider, now and later (`<provider>/*`). Undefined means pi's default, every
 * model: what is left when each provider with models gets all of them.
 *
 * A pattern of another form that reaches this provider (`*sonnet*`, a bare id) is spelled out as the other providers'
 * models it matches, so the provider's own entries alone decide its models.
 *
 * Throws when the result would enable no model at all: pi reads such a list as no scope, which offers every model.
 */
export function withProviderModels(
	patterns: readonly string[] | undefined,
	models: readonly Model<Api>[],
	provider: string,
	selection: readonly string[] | "all",
): string[] | undefined {
	const own = selection === "all" ? [everyModelOf(provider)] : selection.map((id) => `${provider}/${id}`);
	let next: string[];
	if (!patterns?.length) {
		if (selection === "all") return undefined;
		// Every other provider keeps every model, later ones included.
		const others = [...new Set(models.map((model) => model.provider))].filter((each) => each !== provider);
		next = [...others.map(everyModelOf), ...own];
	} else {
		const kept: string[] = [];
		// The provider's entries go where its first one was, so the order Ctrl+P cycles in stays.
		let at = -1;
		for (const pattern of patterns) {
			if (namesProvider(pattern, provider)) {
				if (at < 0) at = kept.length;
				continue;
			}
			// One written as `<provider>/*` before is written the way that also takes ids with a slash.
			const whole = wholeProvider.exec(pattern);
			if (whole) {
				kept.push(everyModelOf(whole[1]));
				continue;
			}
			const reached = resolveModelScopeFromModels([pattern], models).scopedModels;
			if (!reached.some((scoped) => scoped.model.provider === provider)) {
				kept.push(pattern);
				continue;
			}
			for (const scoped of reached) {
				if (scoped.model.provider === provider) continue;
				kept.push(scoped.thinkingLevel ? `${fullId(scoped.model)}:${scoped.thinkingLevel}` : fullId(scoped.model));
			}
		}
		if (at < 0) at = kept.length;
		next = [...kept.slice(0, at), ...own, ...kept.slice(at)];
	}
	const providers = new Set(models.map((model) => model.provider.toLowerCase()));
	const whole = new Set(next.map((pattern) => wholeProvider.exec(pattern)?.[1].toLowerCase()));
	if (next.every((pattern) => wholeProvider.test(pattern)) && [...providers].every((each) => whole.has(each))) {
		return undefined;
	}
	if (!enabledModelIds(next, models)) throw new Error("At least one model must stay enabled");
	return next;
}

/**
 * After a sign-in: a list that enables none of the provider's models gets `<provider>/**`, so a new account's models
 * show until its models are chosen. Undefined when nothing has to change: no list, a list that matches nothing (pi
 * offers every model then), or one that already offers some of the provider's models.
 */
export function withProviderOffered(
	patterns: readonly string[] | undefined,
	models: readonly Model<Api>[],
	provider: string,
): string[] | undefined {
	if (!models.some((model) => model.provider === provider)) return undefined;
	const enabled = enabledModelIds(patterns, models);
	if (!patterns || !enabled || enabled.some((id) => id.startsWith(`${provider}/`))) return undefined;
	return [...patterns, everyModelOf(provider)];
}
