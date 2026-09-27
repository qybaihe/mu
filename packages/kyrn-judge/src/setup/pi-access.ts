// pi itself: its sources in a checkout, its own bundle's index in the npm package (kyrn/npm/build.mjs).
import {
	CredentialSynchronizationError,
	defaultModelPerProvider,
	type ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { PiAccess } from "./wizard.ts";

/**
 * The wizard's view of pi: its providers and defaults, and its own writers for auth.json and settings.json, so that
 * both files come out exactly as pi's /login and /model leave them (a lock, mode 0600, every other field kept).
 */
export function piAccess(runtime: ModelRuntime, agentDir: string): PiAccess {
	const preferred: Readonly<Record<string, string>> = defaultModelPerProvider;
	return {
		providerExists: (provider) => runtime.getProvider(provider) !== undefined,
		models: (provider) => runtime.getModels(provider).map((model) => model.id),
		defaultModel: (provider) => preferred[provider],
		baseUrl: (provider) => runtime.getModels(provider)[0]?.baseUrl,
		credential: async (provider) => {
			const found = (await runtime.listCredentials()).find((credential) => credential.providerId === provider);
			if (!found) return undefined;
			return found.type === "oauth" ? "oauth" : "api_key";
		},
		storeKey: async (provider, key) => {
			// A provider of mu's was just written into models.json: pi reads the file again before it knows the provider.
			await runtime.refresh({ allowNetwork: false, providers: [provider] });
			if (!runtime.getProvider(provider)) {
				throw new Error(`pi has no provider ${provider}${runtime.getError() ? `: ${runtime.getError()}` : ""}`);
			}
			let asked = false;
			try {
				await runtime.login(provider, "api_key", {
					// pi's key login asks one question, the key. Anything else is not answered, and nothing is guessed.
					prompt: async (prompt) => {
						if (asked || prompt.type !== "secret") throw new Error(`pi asked ${provider} for more than a key`);
						asked = true;
						return key;
					},
					notify: () => {},
				});
			} catch (error) {
				// The key is in auth.json; only pi's view of the models in this process lags, and this process ends soon.
				if (!(error instanceof CredentialSynchronizationError)) throw error;
			}
		},
		setDefaultModel: async (provider, model) => {
			const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
			// A settings.json pi cannot read is never written over: pi keeps it as it is, and says why.
			const unreadable = settings.drainErrors().find((problem) => problem.scope === "global");
			if (unreadable) throw new Error(`settings.json cannot be read: ${unreadable.error.message}`);
			settings.setDefaultModelAndProvider(provider, model);
			await settings.flush();
			const failed = settings.drainErrors()[0];
			if (failed) throw new Error(`settings.json was not written: ${failed.error.message}`);
		},
	};
}
