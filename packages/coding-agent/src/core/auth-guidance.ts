import { join } from "node:path";
import { APP_NAME, getDocsPath } from "../config.ts";

const UNKNOWN_PROVIDER = "unknown";

/** `inSession`: said inside an interactive session, where /login is at hand. */
export function getProviderLoginHelp(options: { inSession?: boolean } = {}): string {
	// mu: the mu command line connects a model with `mu setup`; /login only exists inside a session.
	if (APP_NAME === "mu") {
		if (options.inSession) {
			return "Type /login to sign in with ChatGPT, Grok or Google, or to add an API key. Outside a session, `mu setup` does the same.";
		}
		return [
			"Run `mu setup` to connect a model: paste an API key or sign in with a subscription.",
			"Inside a session, /login does the same. `mu setup --list` lists the services mu knows.",
		].join("\n");
	}
	return [
		"Use /login to log into a provider via OAuth or API key. See:",
		`  ${join(getDocsPath(), "providers.md")}`,
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

export function formatNoModelsAvailableMessage(options: { inSession?: boolean } = {}): string {
	return `No models available. ${getProviderLoginHelp(options)}`;
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}
