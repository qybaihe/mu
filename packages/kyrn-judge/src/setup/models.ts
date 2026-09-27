import type { ModelStep } from "./services.ts";

/**
 * The model mu starts with, from what the service lists: the table's rule when it names a listed model, else a list
 * to pick from with the likeliest first.
 */

/** Models a coding agent cannot talk to: embeddings, speech, images, moderation. Left out of the lists offered. */
const NOT_CHAT =
	/embed|rerank|\btts\b|tts-|whisper|audio|speech|\basr\b|transcri|dall-e|image|moderation|\bocr\b|paraformer|cosyvoice|sambert|wanx|flux|stable-diffusion|kolors|video|realtime|davinci|babbage/i;

export function chatModels(listed: readonly string[]): string[] {
	const chat = listed.filter((id) => !NOT_CHAT.test(id));
	return chat.length > 0 ? chat : [...listed];
}

/** The numbers in a model id from where `pattern` matched: DeepSeek-V3.2 is [3, 2], glm-4.5-air is [4, 5]. */
function versionOf(id: string, pattern: RegExp): number[] {
	const at = pattern.exec(id)?.index ?? 0;
	return [...id.slice(at).matchAll(/\d+/g)].map((match) => Number(match[0]));
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		const difference = (a[index] ?? -1) - (b[index] ?? -1);
		if (difference !== 0) return difference;
	}
	return 0;
}

/**
 * The listed models that match `pattern` (case ignored), highest version first; between equal versions the shorter
 * id, which is the plain one ("glm-4.5" before "glm-4.5-air", "deepseek-ai/DeepSeek-V3.2" before its "Pro/" copy).
 */
export function newestMatching(listed: readonly string[], pattern: string): string[] {
	const regex = new RegExp(pattern, "i");
	return listed
		.filter((id) => regex.test(id))
		.sort((a, b) => compareVersions(versionOf(b, regex), versionOf(a, regex)) || a.length - b.length);
}

export interface ModelChoiceInput {
	readonly steps: readonly ModelStep[];
	/** What the service listed; undefined when its check lists nothing (OpenRouter). */
	readonly listed: readonly string[] | undefined;
	/** The provider the key was confirmed on. */
	readonly provider: string;
	/** pi's defaultModelPerProvider. */
	readonly defaultOf: (provider: string) => string | undefined;
	/** pi's own models of a built-in provider, in pi's order; empty for a provider of mu's. */
	readonly catalog: readonly string[];
}

export interface ModelChoice {
	/** The model the table's rule names, when the service lists it (or lists nothing and pi has a default). */
	readonly chosen?: string;
	/** The models to pick from, the likeliest first: the chosen one, the rule's other matches, what pi knows, the rest. */
	readonly options: readonly string[];
}

function candidatesOf(step: ModelStep, input: ModelChoiceInput, listed: readonly string[]): string[] {
	const find = (id: string | undefined) =>
		id === undefined ? [] : listed.filter((entry) => entry.toLowerCase() === id.toLowerCase()).slice(0, 1);
	if ("piDefault" in step) return find(input.defaultOf(input.provider));
	if ("piDefaultOf" in step) return find(input.defaultOf(step.piDefaultOf));
	if ("id" in step) return find(step.id);
	if ("newest" in step) return newestMatching(listed, step.newest);
	return chatModels(listed).slice(0, 1);
}

export function chooseModel(input: ModelChoiceInput): ModelChoice {
	if (input.listed === undefined) {
		for (const step of input.steps) {
			const id =
				"piDefault" in step
					? input.defaultOf(input.provider)
					: "piDefaultOf" in step
						? input.defaultOf(step.piDefaultOf)
						: "id" in step
							? step.id
							: undefined;
			if (id) return { chosen: id, options: [...new Set([id, ...input.catalog])] };
		}
		return { chosen: input.catalog[0], options: [...input.catalog] };
	}
	const listed = input.listed;
	const matches = input.steps.map((step) => candidatesOf(step, input, listed));
	const chosen = matches.find((found) => found.length > 0)?.[0];
	const chat = chatModels(listed);
	const known = new Set(input.catalog.map((id) => id.toLowerCase()));
	const piKnows = input.catalog.flatMap((id) => chat.filter((entry) => entry.toLowerCase() === id.toLowerCase()));
	const rest = chat.filter((id) => !known.has(id.toLowerCase()));
	const options = [...new Set([...(chosen ? [chosen] : []), ...matches.flat(), ...piKnows, ...rest])];
	return { chosen, options };
}
