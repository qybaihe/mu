import { join } from "node:path";
import { APP_NAME, getDocsPath } from "../config.ts";

const UNKNOWN_PROVIDER = "unknown";

export function getProviderLoginHelp(): string {
	// mu: the mu command line connects a model with `mu setup`; /login only exists inside a session.
	if (APP_NAME === "mu") {
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

export function formatNoModelsAvailableMessage(): string {
	return `No models available. ${getProviderLoginHelp()}`;
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}
