import type { AuthInteraction, AuthPrompt, LoginOptions, Provider } from "@earendil-works/pi-ai";

/**
 * `mu auth`: signing in to a provider's subscription outside any session, for the desktop app, with pi's own
 * OAuth flows and pi's credential store (<agent dir>/auth.json), exactly as /login does in the terminal.
 *
 *   mu auth status                     who is signed in, and what this mu can sign in to
 *   mu auth login <provider>           one sign-in, from the browser's page to the stored credential
 *   mu auth login <provider> --paste   the same, taking the address the browser ends on as pasted, with no
 *                                      callback server (for when another program holds the callback port)
 *   mu auth logout <provider>          signs that subscription out, then says who is still signed in
 *
 * It speaks JSON lines. Out: `event` (what the flow reports: the page to open, a device code, progress),
 * `prompt` and `prompt_done` (a question for the person, and its withdrawal when the browser answered first),
 * `signed_in` (the credential is stored), `done` (with what the account can use), `status`, and `error`, after
 * which it exits with 1. An `error` the app can act on carries a `code`: `port_in_use` (another program holds the
 * callback port; with `port`, and `holder`: its `pid` and `command` when the system says, and `pi` when it is an older
 * pi or mu sign-in) and `login_taken_over` (a newer sign-in took the port over). In, during a sign-in: `answer` (to
 * the open prompt) and `cancel`; the input ending cancels too. No line ever carries a credential.
 */

/** What of pi's model runtime a sign-in uses. */
export interface AuthRuntime {
	login(providerId: string, type: "oauth", interaction: AuthInteraction, options?: LoginOptions): Promise<unknown>;
	logout(providerId: string): Promise<void>;
	getModels(providerId?: string): readonly { readonly id: string; readonly name?: string }[];
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
const USAGE = "usage: mu auth status | mu auth login <provider> [--paste] | mu auth logout <provider>";
/** The error codes of pi's flows an app can act on, passed on in the `error` line. */
const ERROR_CODES: readonly string[] = ["port_in_use", "login_taken_over"];

/** The subcommands `mu auth` answers itself. The others (`check`, `print-api-key`, ...) are pi's own. */
export const AUTH_COMMANDS: readonly string[] = ["status", "login", "logout"];

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
		if (extra.length > 0 || flags.some((flag) => flag !== "--paste") || (paste && mode !== "login")) {
			throw new Error(USAGE);
		}
		for (const extra of options.extra) runtime.registerNativeProvider(extra);
		if (options.extra.length > 0) {
			await runtime.refresh({ allowNetwork: false, providers: options.extra.map((extra) => extra.id) });
		}
		const offered = [...BUILT_IN_PROVIDERS, ...options.extra.map((extra) => extra.id)];
		const known = [...offered, ...LEGACY_PROVIDERS];
		const status = async () => ({
			type: "status",
			offered,
			signedIn: (await runtime.listCredentials())
				.filter((credential) => credential.type === "oauth" && known.includes(credential.providerId))
				.map((credential) => ({
					provider: credential.providerId,
					models: modelsOf(runtime, credential.providerId, preferred),
				})),
		});

		if (mode === "status") {
			io.say(await status());
			return 0;
		}
		if (!provider) throw new Error(USAGE);
		if (!(mode === "login" ? offered : known).includes(provider)) {
			throw new Error(`This version of mu can't sign in to ${provider}`);
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
	{ runtime, preferred, io, modelsReadMs, login, signal: ending }: AuthOptions,
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
	io.say({ type: "done", provider, models: modelsOf(runtime, provider, preferred) });
}
