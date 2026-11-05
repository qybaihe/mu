import type { Api, AuthInteraction, AuthPrompt, LoginOptions, Model, Provider } from "@earendil-works/pi-ai";
import { enabledModelIds, withProviderModels, withProviderOffered } from "@earendil-works/pi-coding-agent";

/**
 * `mu auth`: signing in to a provider's subscription outside any session, for the desktop app, with pi's own
 * OAuth flows and pi's credential store (<agent dir>/auth.json), exactly as /login does in the terminal.
 *
 *   mu auth status                     who is signed in, what this mu can sign in to, and what else is usable
 *   mu auth login <provider>           one sign-in, from the browser's page to the stored credential
 *   mu auth login <provider> --paste   the same, taking the address the browser ends on as pasted, with no
 *                                      callback server (for when another program holds the callback port)
 *   mu auth logout <provider>          signs that subscription out, then says who is still signed in
 *   mu auth enable <provider> <model>...
 *                                      the provider's models /model and the app's model menus offer: these, the
 *                                      other providers' as they were (pi's `enabledModels`, global settings); then
 *                                      says who is signed in. With --default, all of them, the ones the provider
 *                                      gains later too; with no model, none. Any provider with a usable model: a
 *                                      signed-in account, or one an API key or models.json makes usable.
 *
 * It speaks JSON lines. Out: `event` (what the flow reports: the page to open, a device code, progress),
 * `prompt` and `prompt_done` (a question for the person, and its withdrawal when the browser answered first),
 * `signed_in` (the credential is stored), `done` (with what the account can use), `status`, and `error`, after
 * which it exits with 1. An `error` the app can act on carries a `code`: `port_in_use` (another program holds the
 * callback port; with `port`, and `holder`: its `pid` and `command` when the system says, and `pi` when it is an older
 * pi or mu sign-in) and `login_taken_over` (a newer sign-in took the port over). In, during a sign-in: `answer` (to
 * the open prompt) and `cancel`; the input ending cancels too. No line ever carries a credential.
 *
 * Each signed-in account in `status`, and `done`, carries `enabled`: the ids of its models the settings enable.
 * `status` also lists, as `usable`, every other provider with a usable model (an API key's, models.json's), each with
 * its models and `enabled` the same way, so the app can choose those models too.
 */

/** What of pi's model runtime a sign-in uses. */
export interface AuthRuntime {
	login(providerId: string, type: "oauth", interaction: AuthInteraction, options?: LoginOptions): Promise<unknown>;
	logout(providerId: string): Promise<void>;
	getModels(providerId?: string): readonly { readonly id: string; readonly name?: string }[];
	/** Every model a credential or key makes usable: what pi reads `enabledModels` against. */
	getAvailable(): Promise<readonly Model<Api>[]>;
	listCredentials(): Promise<readonly { readonly providerId: string; readonly type: string }[]>;
	registerNativeProvider(provider: Provider): void;
	refresh(options: { providers?: string[]; allowNetwork?: boolean; signal?: AbortSignal }): Promise<unknown>;
}

export interface AuthIo {
	/** One message, as one line. */
	say(message: Readonly<Record<string, unknown>>): void;
	/** The lines the app writes to a sign-in, then `end` once it stops writing. Only a sign-in listens. */
	listen(line: (text: string) => void, end: () => void): void;
}

export interface AuthOptions {
	readonly runtime: AuthRuntime;
	/** The model pi starts each provider on (pi's defaultModelPerProvider). */
	readonly preferred: Readonly<Record<string, string>>;
	/** mu's own sign-ins (the Google ones), present while its googleLogin feature is on. */
	readonly extra: readonly Provider[];
	readonly io: AuthIo;
	/** Aborts when the process is told to end (SIGTERM at the app's quit): a sign-in under way stops at once. */
	readonly signal?: AbortSignal;
	/** How long reading an account's models may take once it is signed in. */
	readonly modelsReadMs?: number;
	/** What a flow is told about this mu: its name, and the stable id of this installation (Sign in with ChatGPT). */
	readonly login?: LoginOptions;
	/** Drops what pi keeps of a provider's models between runs (its catalogue store, models-store.json). */
	readonly forgetModels?: (providerId: string) => Promise<void>;
	/** pi's `enabledModels` in the global settings: which models /model and the app's model menus offer. */
	readonly enabledModels?: EnabledModelsSetting;
}

export interface EnabledModelsSetting {
	read(): string[] | undefined;
	write(patterns: string[] | undefined): Promise<void>;
}

export type AuthModel = { id: string; name: string };

/** pi's own subscription flows, in every mu. ChatGPT is OpenAI's own Sign in with ChatGPT, on the `openai` provider. */
export const BUILT_IN_PROVIDERS: readonly string[] = ["openai", "xai"];
/**
 * Sign-ins no longer offered: an account signed in with one is listed and can be signed out, never signed in anew.
 * ChatGPT through the Codex CLI's own login (`openai-codex`), which Sign in with ChatGPT replaces, and a Claude
 * subscription (`anthropic`), which Anthropic doesn't allow other apps to sign in with.
 */
export const LEGACY_PROVIDERS: readonly string[] = ["openai-codex", "anthropic"];
/** A provider whose list of models comes from the account: read again once it is signed in. */
const LISTED_BY_ACCOUNT = new Set(["google-antigravity"]);
/** The sign-in itself is done by then, and the list the account had stands. */
const MODELS_READ_MS = 20_000;
/** pi's Codex flow asks how to sign in; from the app it is always the browser on this machine, never the headless way. */
const BROWSER_METHOD = "browser";
const USAGE =
	"usage: mu auth status | mu auth login <provider> [--paste] | mu auth logout <provider> | mu auth enable <provider> [--default | <model>...]";
/** The error codes of pi's flows an app can act on, passed on in the `error` line. */
const ERROR_CODES: readonly string[] = ["port_in_use", "login_taken_over"];

/** The subcommands `mu auth` answers itself. The others (`check`, `print-api-key`, ...) are pi's own. */
export const AUTH_COMMANDS: readonly string[] = ["status", "login", "logout", "enable"];

/** What an account can use, from pi's catalogue, with the model pi starts that provider on first. */
export function modelsOf(
	runtime: AuthRuntime,
	provider: string,
	preferred: Readonly<Record<string, string>>,
): AuthModel[] {
	const models = runtime.getModels(provider).map((model) => ({ id: model.id, name: model.name || model.id }));
	const first = models.findIndex((model) => model.id === preferred[provider]);
	return first > 0 ? [models[first], ...models.slice(0, first), ...models.slice(first + 1)] : models;
}

/** What the settings enable (`provider/id`), undefined while they restrict nothing. */
async function enabledNow(
	runtime: AuthRuntime,
	setting: EnabledModelsSetting | undefined,
): Promise<string[] | undefined> {
	const patterns = setting?.read();
	return patterns?.length ? enabledModelIds(patterns, await runtime.getAvailable()) : undefined;
}

/** The ids of an account's models the settings enable, in the account's order. */
const enabledIn = (enabled: readonly string[] | undefined, provider: string, models: readonly AuthModel[]) =>
	models.filter((model) => !enabled || enabled.includes(`${provider}/${model.id}`)).map((model) => model.id);

const isBrowserChoice = (prompt: AuthPrompt): boolean =>
	prompt.type === "select" && prompt.options.some((option) => option.id === BROWSER_METHOD);

/** A prompt as the app sees it: what to ask, never the flow's signal. */
function shown(prompt: AuthPrompt): Record<string, unknown> {
	return {
		type: prompt.type,
		message: prompt.message,
		placeholder: "placeholder" in prompt ? prompt.placeholder : undefined,
		options: prompt.type === "select" ? prompt.options : undefined,
	};
}

/**
 * The `error` line: the flow's message, and when the flow says what went wrong in a way an app can act on, its
 * `code`, and for `port_in_use` the port and what the system says of the program holding it. Nothing else of the
 * error is passed on.
 */
function errorLine(error: unknown): Record<string, unknown> {
	const line: Record<string, unknown> = {
		type: "error",
		message: error instanceof Error ? error.message : String(error),
	};
	if (!(error instanceof Error)) return line;
	const { code, port, holder } = error as Error & { code?: unknown; port?: unknown; holder?: unknown };
	if (typeof code !== "string" || !ERROR_CODES.includes(code)) return line;
	line.code = code;
	if (code !== "port_in_use") return line;
	if (typeof port === "number") line.port = port;
	if (holder && typeof holder === "object") {
		const { pid, command, pi } = holder as { pid?: unknown; command?: unknown; pi?: unknown };
		line.holder = {
			...(typeof pid === "number" ? { pid } : {}),
			...(typeof command === "string" ? { command } : {}),
			...(pi === true ? { pi } : {}),
		};
	}
	return line;
}

/** Runs one `mu auth` command to its end and gives back the exit code. */
export async function runAuth(argv: readonly string[], options: AuthOptions): Promise<number> {
	const { runtime, preferred, io } = options;
	try {
		const flags = argv.filter((arg) => arg.startsWith("--"));
		const [mode, provider, ...extra] = argv.filter((arg) => !arg.startsWith("--"));
		if (!AUTH_COMMANDS.includes(mode ?? "")) throw new Error(USAGE);
		const paste = flags.includes("--paste");
		const byDefault = flags.includes("--default");
		const allowed = mode === "login" ? ["--paste"] : mode === "enable" ? ["--default"] : [];
		if (
			(mode !== "enable" && extra.length > 0) ||
			(byDefault && extra.length > 0) ||
			flags.some((flag) => !allowed.includes(flag))
		) {
			throw new Error(USAGE);
		}
		for (const extra of options.extra) runtime.registerNativeProvider(extra);
		if (options.extra.length > 0) {
			await runtime.refresh({ allowNetwork: false, providers: options.extra.map((extra) => extra.id) });
		}
		const offered = [...BUILT_IN_PROVIDERS, ...options.extra.map((extra) => extra.id)];
		const known = [...offered, ...LEGACY_PROVIDERS];
		const setting = options.enabledModels;
		const status = async () => {
			const accounts = (await runtime.listCredentials()).filter(
				(credential) => credential.type === "oauth" && known.includes(credential.providerId),
			);
			const available = await runtime.getAvailable();
			const patterns = setting?.read();
			const enabled = patterns?.length ? enabledModelIds(patterns, available) : undefined;
			const entry = (provider: string) => {
				const models = modelsOf(runtime, provider, preferred);
				return { provider, models, enabled: enabledIn(enabled, provider, models) };
			};
			const signedIn = accounts.map(({ providerId }) => providerId);
			// Usable without a sign-in here: an API key's provider, models.json's. In the order pi lists them.
			const usable = [...new Set(available.map((model) => model.provider))].filter(
				(provider) => !signedIn.includes(provider),
			);
			return { type: "status", offered, signedIn: signedIn.map(entry), usable: usable.map(entry) };
		};

		if (mode === "status") {
			io.say(await status());
			return 0;
		}
		if (!provider) throw new Error(USAGE);
		// Any provider's models can be chosen: one with none usable is refused below.
		if (mode !== "enable" && !(mode === "login" ? offered : known).includes(provider)) {
			throw new Error(`This version of mu can't sign in to ${provider}`);
		}
		if (mode === "enable") {
			if (!setting) throw new Error("This version of mu can't choose an account's models");
			const ids = modelsOf(runtime, provider, preferred).map((model) => model.id);
			const unknown = extra.filter((id) => !ids.includes(id));
			if (unknown.length > 0) throw new Error(`${provider} has no model ${unknown.join(", ")}`);
			const available = await runtime.getAvailable();
			if (!available.some((model) => model.provider === provider)) {
				throw new Error(`No models of ${provider} are available: sign in to it, or give it an API key, first`);
			}
			const patterns = withProviderModels(setting.read(), available, provider, byDefault ? "all" : extra);
			await setting.write(patterns);
			io.say(await status());
			return 0;
		}
		if (mode === "logout") {
			// Only a subscription sign-in is signed out here: a key stored for the same provider is left alone.
			const stored = (await runtime.listCredentials()).find((credential) => credential.providerId === provider);
			if (stored?.type === "oauth") {
				await runtime.logout(provider);
				// The list of models the account itself gave goes with it: the next sign-in, maybe to another account,
				// reads its own instead of starting from this one's.
				if (LISTED_BY_ACCOUNT.has(provider)) await options.forgetModels?.(provider);
			}
			io.say(await status());
			return 0;
		}
		await signIn(provider, paste ? { ...options, login: { ...options.login, pasteOnly: true } } : options);
		return 0;
	} catch (error) {
		io.say(errorLine(error));
		return 1;
	}
}

async function signIn(
	provider: string,
	{ runtime, preferred, io, modelsReadMs, login, signal: ending, enabledModels: setting }: AuthOptions,
): Promise<void> {
	const controller = new AbortController();
	// The process is ending: the flow stops now, and its callback server with it, not when the process is gone.
	ending?.addEventListener("abort", () => controller.abort(), { once: true });
	if (ending?.aborted) controller.abort();
	let pending: { resolve(value: string): void; reject(error: Error): void } | undefined;
	io.listen(
		(line) => {
			let message: Record<string, unknown>;
			try {
				message = JSON.parse(line) as Record<string, unknown>;
			} catch {
				return;
			}
			if (message.type === "answer" && pending) {
				const waiting = pending;
				pending = undefined;
				waiting.resolve(typeof message.value === "string" ? message.value : "");
			} else if (message.type === "cancel") {
				controller.abort();
				pending?.reject(new Error("cancelled"));
			}
		},
		// The app went away: nobody is left to finish the sign-in.
		() => controller.abort(),
	);

	await runtime.login(
		provider,
		"oauth",
		{
			signal: controller.signal,
			notify: (event) => io.say({ type: "event", event }),
			prompt: (prompt) =>
				isBrowserChoice(prompt)
					? Promise.resolve(BROWSER_METHOD)
					: new Promise<string>((resolve, reject) => {
							const entry = { resolve, reject };
							pending = entry;
							// A prompt raced against the browser callback is withdrawn when the callback wins.
							prompt.signal?.addEventListener(
								"abort",
								() => {
									if (pending !== entry) return;
									pending = undefined;
									reject(new Error("withdrawn"));
									io.say({ type: "prompt_done" });
								},
								{ once: true },
							);
							io.say({ type: "prompt", prompt: shown(prompt) });
						}),
		},
		login,
	);
	// The credential is stored: whatever happens next, the person is signed in.
	io.say({ type: "signed_in" });
	if (LISTED_BY_ACCOUNT.has(provider)) {
		// What the account can use now; when that cannot be read in time, the list it had before sign-in stands.
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(modelsReadMs ?? MODELS_READ_MS)]);
		await runtime.refresh({ providers: [provider], allowNetwork: true, signal }).catch(() => {});
	}
	// A list of models chosen before that leaves this account out gets all of its models, until they are chosen.
	if (setting) {
		const offered = withProviderOffered(setting.read(), await runtime.getAvailable(), provider);
		if (offered) await setting.write(offered);
	}
	const models = modelsOf(runtime, provider, preferred);
	io.say({ type: "done", provider, models, enabled: enabledIn(await enabledNow(runtime, setting), provider, models) });
}
