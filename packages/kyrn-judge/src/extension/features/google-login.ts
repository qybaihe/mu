import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ANTIGRAVITY_PROVIDER } from "../../google-login/endpoints.ts";
import { antigravityProvider, geminiCliProvider } from "../../google-login/providers.ts";
import type { KyrnRuntime } from "../runtime.ts";

/** How long reading what Antigravity serves the account may take, as a session starts. */
export const STARTUP_MODELS_READ_MS = 20_000;

/**
 * Signing in with a Google account under /login: through Gemini CLI's login
 * (the Gemini models) or Antigravity's (Gemini, Claude, GPT-OSS). pi dropped
 * both upstream; mu keeps them as experimental. Before the browser opens, the
 * sign-in says what the risk is (these are Google's logins for its own tools)
 * and goes on only when the person agrees.
 *
 * The official routes need nothing from mu: a Gemini API key (provider
 * "google") and Vertex AI with gcloud's application default credentials
 * (provider "google-vertex"). Grok's sign-in (provider "xai") is pi's own.
 */
export function registerGoogleLogin(runtime: KyrnRuntime): void {
	const options = runtime.options("googleLogin", { enabled: true, geminiCli: true, antigravity: true });
	if (!options.enabled) return;
	if (options.geminiCli) runtime.pi.registerProvider(geminiCliProvider());
	if (options.antigravity) {
		runtime.pi.registerProvider(antigravityProvider());
		readAntigravityModelsAtStart(runtime.pi);
	}
}

/**
 * What Antigravity serves an account changes (Gemini 4 Argon came for paid plans, older Claude models go), and the
 * list is otherwise read only when the account signs in. So a signed-in session of the terminal or the app reads it
 * once more as it starts, in the background; when that fails or takes too long, the list it had stands. Print and JSON
 * runs, which end with their one answer, don't, nor does a process told to stay offline (PI_OFFLINE).
 */
function readAntigravityModelsAtStart(pi: ExtensionAPI): void {
	let read = false;
	pi.on("session_start", (_event, ctx) => {
		if (read || (ctx.mode !== "tui" && ctx.mode !== "rpc") || process.env.PI_OFFLINE !== undefined) return;
		if (!ctx.modelRegistry.getProviderAuthStatus(ANTIGRAVITY_PROVIDER).configured) return;
		read = true;
		void ctx.modelRegistry
			.refresh({
				providers: [ANTIGRAVITY_PROVIDER],
				allowNetwork: true,
				signal: AbortSignal.timeout(STARTUP_MODELS_READ_MS),
			})
			.catch(() => {});
	});
}
