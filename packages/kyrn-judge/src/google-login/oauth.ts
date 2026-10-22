import { createServer, type Server } from "node:http";
import {
	type OAuthAuth,
	type OAuthCredential,
	oauthErrorHtml,
	oauthSuccessHtml,
	type ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { ANTIGRAVITY_ENDPOINTS, CLOUD_CODE_ENDPOINT } from "./endpoints.ts";

/**
 * Signing in to Google's Cloud Code Assist with the OAuth clients of Gemini
 * CLI and Antigravity, as pi did until it dropped both (upstream fe66edd94,
 * 2026-04-30). They are experimental in mu and say so before the browser
 * opens: these are Google's clients for its own tools, and Google may treat
 * their use from another program as against its terms.
 *
 * The flow: consent, PKCE, a callback server on the port the client was
 * registered with (a pasted redirect URL works too, for a browser on another
 * machine), the token exchange, then the Cloud project the requests are billed
 * to. The credential keeps the project; request auth is the access token and
 * the project together.
 */
export type GoogleClientKind = "gemini-cli" | "antigravity";

export interface GoogleLoginConfig {
	readonly kind: GoogleClientKind;
	/** What the person signs in to, in the consent question. */
	readonly title: string;
	readonly clientId: string;
	readonly clientSecret: string;
	readonly callbackPort: number;
	readonly callbackPath: string;
	readonly scopes: readonly string[];
	readonly authUrl: string;
	readonly tokenUrl: string;
	readonly userInfoUrl: string;
	/** Where the project is looked up, in order. */
	readonly codeAssistEndpoints: readonly string[];
	readonly callbackHost: string;
	/** GOOGLE_CLOUD_PROJECT and friends. */
	readonly env: (name: string) => string | undefined;
}

export interface GoogleCredential extends OAuthCredential {
	readonly projectId: string;
	readonly email?: string;
}

const decode = (value: string) => atob(value);

const GOOGLE = {
	authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
	tokenUrl: "https://oauth2.googleapis.com/token",
	userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
	callbackHost: process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1",
	env: (name: string) => process.env[name],
};

const BASE_SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
];

export const GEMINI_CLI_LOGIN: GoogleLoginConfig = {
	...GOOGLE,
	kind: "gemini-cli",
	title: "Google Gemini CLI",
	clientId: decode("NjgxMjU1ODA5Mzk1LW9vOGZ0Mm9wcmRybnA5ZTNhcWY2YXYzaG1kaWIxMzVqLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t"),
	clientSecret: decode("R09DU1BYLTR1SGdNUG0tMW83U2stZ2VWNkN1NWNsWEZzeGw="),
	callbackPort: 8085,
	callbackPath: "/oauth2callback",
	scopes: BASE_SCOPES,
	codeAssistEndpoints: [CLOUD_CODE_ENDPOINT],
};

export const ANTIGRAVITY_LOGIN: GoogleLoginConfig = {
	...GOOGLE,
	kind: "antigravity",
	title: "Google Antigravity",
	clientId: decode(
		"MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
	),
	clientSecret: decode("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY="),
	callbackPort: 51121,
	callbackPath: "/oauth-callback",
	scopes: [
		...BASE_SCOPES,
		"https://www.googleapis.com/auth/cclog",
		"https://www.googleapis.com/auth/experimentsandconfigs",
	],
	codeAssistEndpoints: [CLOUD_CODE_ENDPOINT, ANTIGRAVITY_ENDPOINTS[0]],
};

/** Antigravity's own fallback when no project can be found, as its client uses. */
const ANTIGRAVITY_DEFAULT_PROJECT = "rising-fact-p41fc";

export function riskNotice(config: GoogleLoginConfig): string {
	return `Experimental: this signs in through ${config.title}'s own login, not one Google made for mu. Google may treat that as against its terms and limit or suspend the account. Use an account you can afford to lose access to, or a Gemini API key (provider "google") instead.`;
}

// ---------------------------------------------------------------------------
// PKCE and the callback server

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const verifier = base64url(bytes);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** The code of this sign-in, Google's refusal of it, or nothing (cancelled). */
type Received = { code: string; state: string } | { declined: string } | undefined;

interface Callback {
	readonly server: Server;
	readonly wait: Promise<Received>;
	readonly cancel: () => void;
}

/** Only the callback of this sign-in counts: anything else that reaches the port (a stale tab, another page) is turned away. */
function listen(config: GoogleLoginConfig, state: string): Promise<Callback> {
	return new Promise((resolve, reject) => {
		let settle: (value: Received) => void = () => {};
		const wait = new Promise<Received>((done) => {
			let settled = false;
			settle = (value) => {
				if (settled) return;
				settled = true;
				done(value);
			};
		});
		const server = createServer((request, response) => {
			const url = new URL(request.url ?? "/", `http://localhost:${config.callbackPort}`);
			// The same page every sign-in of mu ends on (pi-ai's), so the look does not depend on the provider.
			const send = (status: number, html: string) => {
				response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
				response.end(html);
			};
			if (url.pathname !== config.callbackPath) {
				return send(404, oauthErrorHtml("This address is mu's sign-in callback; there is no page here."));
			}
			const given = url.searchParams.get("state");
			const error = url.searchParams.get("error");
			if (error) {
				const said = error.replace(/[^\w.-]/g, "").slice(0, 80) || "an error";
				send(400, oauthErrorHtml("Google did not complete the sign-in.", `Google said: ${said}`));
				// Cancel on Google's page ends this sign-in; someone else's refusal does not.
				if (given === state) settle({ declined: said });
				return;
			}
			const code = url.searchParams.get("code");
			if (!code || !given) return send(400, oauthErrorHtml("The code or the state is missing."));
			if (given !== state) {
				return send(400, oauthErrorHtml("This address belongs to another sign-in. Use the tab mu opened last."));
			}
			send(200, oauthSuccessHtml("You can close this window and go back to mu."));
			settle({ code, state: given });
		});
		server.once("error", (error: NodeJS.ErrnoException) =>
			reject(
				error.code === "EADDRINUSE"
					? new Error(
							`Port ${config.callbackPort} is taken (is ${config.title} itself signing in?). Close it and try again.`,
						)
					: error,
			),
		);
		server.listen(config.callbackPort, config.callbackHost, () =>
			resolve({ server, wait, cancel: () => settle(undefined) }),
		);
	});
}

/** The code and state from a pasted redirect URL, or a bare code. */
export function parsePasted(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};
	try {
		const url = new URL(value);
		return { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined };
	} catch {
		return { code: value };
	}
}

// ---------------------------------------------------------------------------
// Tokens

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
}

async function tokenRequest(config: GoogleLoginConfig, body: Record<string, string>, signal: AbortSignal) {
	const response = await fetch(config.tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...body }),
		signal,
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`Google token request failed (${response.status}): ${text.slice(0, 300)}`);
	const data = JSON.parse(text) as TokenResponse;
	if (!data.access_token || typeof data.expires_in !== "number") {
		throw new Error("Google's token response has no access token");
	}
	return data as TokenResponse & { access_token: string; expires_in: number };
}

/** Five minutes early, so a token never dies in the middle of a request. */
const expiry = (seconds: number) => Date.now() + seconds * 1000 - 5 * 60 * 1000;

async function email(config: GoogleLoginConfig, token: string, signal: AbortSignal): Promise<string | undefined> {
	try {
		const response = await fetch(config.userInfoUrl, { headers: { Authorization: `Bearer ${token}` }, signal });
		if (!response.ok) return undefined;
		const data = (await response.json()) as { email?: unknown };
		return typeof data.email === "string" ? data.email : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// The Cloud project

const CLIENT_METADATA = { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };

interface LoadCodeAssist {
	cloudaicompanionProject?: string | { id?: string };
	currentTier?: { id?: string };
	allowedTiers?: { id?: string; isDefault?: boolean }[];
}

const projectOf = (value: LoadCodeAssist["cloudaicompanionProject"]) =>
	typeof value === "string" ? value || undefined : value?.id || undefined;

const NEEDS_PROJECT =
	"This account needs a Google Cloud project: set GOOGLE_CLOUD_PROJECT (see https://goo.gle/gemini-cli-auth-docs#workspace-gca).";

/** Gemini CLI: the project the account already has, or one Google provisions on the free tier. */
async function geminiProject(
	config: GoogleLoginConfig,
	token: string,
	interaction: ProviderAuthInteraction,
): Promise<string> {
	const own = config.env("GOOGLE_CLOUD_PROJECT") || config.env("GOOGLE_CLOUD_PROJECT_ID");
	const endpoint = config.codeAssistEndpoints[0];
	const headers = {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		"User-Agent": "google-api-nodejs-client/9.15.1",
		"X-Goog-Api-Client": "gl-node/22.17.0",
	};
	interaction.notify({ type: "progress", message: "Looking up the Cloud Code Assist project..." });
	const loaded = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
		method: "POST",
		headers,
		body: JSON.stringify({ cloudaicompanionProject: own, metadata: { ...CLIENT_METADATA, duetProject: own } }),
		signal: interaction.signal,
	});
	let data: LoadCodeAssist;
	if (loaded.ok) data = (await loaded.json()) as LoadCodeAssist;
	else {
		const text = await loaded.text();
		// An organisation behind VPC Service Controls answers this way; its users are on the standard tier.
		if (!text.includes("SECURITY_POLICY_VIOLATED")) {
			throw new Error(`loadCodeAssist failed (${loaded.status}): ${text.slice(0, 300)}`);
		}
		data = { currentTier: { id: "standard-tier" } };
	}
	if (data.currentTier) {
		const found = projectOf(data.cloudaicompanionProject) ?? own;
		if (!found) throw new Error(NEEDS_PROJECT);
		return found;
	}

	const tier = data.allowedTiers?.find((candidate) => candidate.isDefault)?.id ?? "legacy-tier";
	if (tier !== "free-tier" && !own) throw new Error(NEEDS_PROJECT);
	interaction.notify({
		type: "progress",
		message: "Setting up a Cloud Code Assist project (this can take a minute)...",
	});
	const body: Record<string, unknown> = { tierId: tier, metadata: CLIENT_METADATA };
	if (tier !== "free-tier" && own) {
		body.cloudaicompanionProject = own;
		body.metadata = { ...CLIENT_METADATA, duetProject: own };
	}
	const started = await fetch(`${endpoint}/v1internal:onboardUser`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: interaction.signal,
	});
	if (!started.ok) throw new Error(`onboardUser failed (${started.status}): ${(await started.text()).slice(0, 300)}`);
	let operation = (await started.json()) as {
		name?: string;
		done?: boolean;
		response?: { cloudaicompanionProject?: { id?: string } };
	};
	for (let attempt = 0; !operation.done && operation.name && attempt < 60; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1000 : 5000));
		const polled = await fetch(`${endpoint}/v1internal/${operation.name}`, { headers, signal: interaction.signal });
		if (!polled.ok) throw new Error(`Setting up the project failed (${polled.status})`);
		operation = (await polled.json()) as typeof operation;
	}
	const provisioned = operation.response?.cloudaicompanionProject?.id ?? own;
	if (!provisioned) throw new Error(NEEDS_PROJECT);
	return provisioned;
}

/** Antigravity: the project the account has at any of its endpoints, else Antigravity's own default. */
async function antigravityProject(
	config: GoogleLoginConfig,
	token: string,
	interaction: ProviderAuthInteraction,
): Promise<string> {
	interaction.notify({ type: "progress", message: "Looking up the Antigravity project..." });
	for (const endpoint of config.codeAssistEndpoints) {
		try {
			const loaded = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					"User-Agent": "google-api-nodejs-client/9.15.1",
					"Client-Metadata": JSON.stringify(CLIENT_METADATA),
				},
				body: JSON.stringify({ metadata: CLIENT_METADATA }),
				signal: interaction.signal,
			});
			if (!loaded.ok) continue;
			const found = projectOf(((await loaded.json()) as LoadCodeAssist).cloudaicompanionProject);
			if (found) return found;
		} catch (error) {
			if (interaction.signal.aborted) throw error;
		}
	}
	return ANTIGRAVITY_DEFAULT_PROJECT;
}

// ---------------------------------------------------------------------------
// The flow

async function consent(config: GoogleLoginConfig, interaction: ProviderAuthInteraction): Promise<void> {
	const answer = await interaction.prompt({
		type: "select",
		message: riskNotice(config),
		options: [
			{ id: "continue", label: "I understand the risk, sign in" },
			{ id: "cancel", label: "Cancel" },
		],
	});
	if (answer !== "continue") throw new Error("Login cancelled");
}

async function login(config: GoogleLoginConfig, interaction: ProviderAuthInteraction): Promise<GoogleCredential> {
	await consent(config, interaction);
	const { verifier, challenge } = await pkce();
	const redirectUri = `http://localhost:${config.callbackPort}${config.callbackPath}`;
	const callback = await listen(config, verifier);
	const pasting = new AbortController();
	const onAbort = () => callback.cancel();
	interaction.signal.addEventListener("abort", onAbort, { once: true });
	let pasted: string | undefined;
	let pasteError: Error | undefined;
	try {
		const query = new URLSearchParams({
			client_id: config.clientId,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: config.scopes.join(" "),
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
			access_type: "offline",
			prompt: "consent",
		});
		interaction.notify({
			type: "auth_url",
			url: `${config.authUrl}?${query.toString()}`,
			instructions:
				"Sign in with Google in your browser. If the browser is on another machine, paste the address it ends on here.",
		});
		const typed = interaction
			.prompt({
				type: "manual_code",
				message: "Sign in in your browser, or paste the address the browser ended on:",
				placeholder: redirectUri,
				signal: pasting.signal,
			})
			.then((value) => {
				pasted = value;
				callback.cancel();
			})
			.catch((error: unknown) => {
				pasteError = error instanceof Error ? error : new Error(String(error));
				callback.cancel();
			});

		let code: string | undefined;
		const received = await callback.wait;
		if (received && "declined" in received) throw new Error(`Google sign-in was declined: ${received.declined}`);
		if (received) {
			if (received.state !== verifier) throw new Error("OAuth state mismatch");
			code = received.code;
		} else {
			if (!pasted && !pasteError && !interaction.signal.aborted) await typed;
			if (interaction.signal.aborted) throw new Error("Login cancelled");
			if (pasteError) throw pasteError;
			const parsed = parsePasted(pasted ?? "");
			if (parsed.state && parsed.state !== verifier) throw new Error("OAuth state mismatch");
			code = parsed.code;
		}
		if (!code) throw new Error("No authorization code came back");

		interaction.notify({ type: "progress", message: "Exchanging the code for tokens..." });
		const tokens = await tokenRequest(
			config,
			{ code, grant_type: "authorization_code", redirect_uri: redirectUri, code_verifier: verifier },
			interaction.signal,
		);
		if (!tokens.refresh_token) throw new Error("Google sent no refresh token; sign in again");
		const who = await email(config, tokens.access_token, interaction.signal);
		const projectId =
			config.kind === "gemini-cli"
				? await geminiProject(config, tokens.access_token, interaction)
				: await antigravityProject(config, tokens.access_token, interaction);
		return {
			type: "oauth",
			access: tokens.access_token,
			refresh: tokens.refresh_token,
			expires: expiry(tokens.expires_in),
			projectId,
			...(who ? { email: who } : {}),
		};
	} finally {
		interaction.signal.removeEventListener("abort", onAbort);
		pasting.abort();
		callback.server.close();
		// A browser keeps its connection open; the port must be free for the next sign-in now, not when it lets go.
		callback.server.closeAllConnections();
	}
}

async function refresh(config: GoogleLoginConfig, credential: OAuthCredential, signal: AbortSignal) {
	const projectId = (credential as Partial<GoogleCredential>).projectId;
	if (!projectId) throw new Error(`The ${config.title} credential has no project; sign in again`);
	const tokens = await tokenRequest(
		config,
		{ refresh_token: credential.refresh, grant_type: "refresh_token" },
		signal,
	);
	return {
		...credential,
		type: "oauth",
		access: tokens.access_token,
		refresh: tokens.refresh_token || credential.refresh,
		expires: expiry(tokens.expires_in),
		projectId,
	} satisfies GoogleCredential;
}

/** Request auth for Cloud Code Assist: the token and the project, which the stream reads apart again. */
export function cloudCodeKey(credential: OAuthCredential): string {
	return JSON.stringify({ token: credential.access, projectId: (credential as Partial<GoogleCredential>).projectId });
}

export function googleOAuth(config: GoogleLoginConfig): OAuthAuth {
	return {
		name: `${config.title} (experimental)`,
		isSubscription: true,
		loginLabel: `Sign in with Google through ${config.title} (experimental)`,
		login: (interaction) => login(config, interaction),
		refresh: (credential, signal) => refresh(config, credential, signal),
		toAuth: async (credential) => ({ apiKey: cloudCodeKey(credential) }),
	};
}

export const geminiCliOAuth = googleOAuth(GEMINI_CLI_LOGIN);
export const antigravityOAuth = googleOAuth(ANTIGRAVITY_LOGIN);
