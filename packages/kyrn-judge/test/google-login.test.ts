import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import {
	type Api,
	type AssistantMessage,
	type AuthEvent,
	type AuthPrompt,
	type Context,
	type Model,
	normalizeContext,
	type OAuthCredential,
	type ProviderAuthInteraction,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { freePort } from "../src/dap/client.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import {
	buildCloudCodeRequest,
	endpointsFor,
	retryDelay,
	stream,
	streamSimple,
} from "../src/google-login/cloud-code.ts";
import {
	ANTIGRAVITY_CLI_VERSION,
	ANTIGRAVITY_ENDPOINTS,
	antigravityUserAgent,
	CLOUD_CODE_API,
	CLOUD_CODE_ENDPOINT,
} from "../src/google-login/endpoints.ts";
import {
	ANTIGRAVITY_LOGIN,
	cloudCodeKey,
	GEMINI_CLI_LOGIN,
	type GoogleLoginConfig,
	googleOAuth,
	parsePasted,
} from "../src/google-login/oauth.ts";
import {
	antigravityBaseline,
	antigravityModelsFrom,
	fetchAntigravityModels,
	geminiCliModels,
} from "../src/google-login/providers.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";

// ---------------------------------------------------------------------------
// A stand-in for Google: token, userinfo and Cloud Code Assist on one local server

interface Seen {
	path: string;
	body: string;
	headers: IncomingHttpHeaders;
}

type Route = (body: string) => { status?: number; json: unknown };

const servers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of servers.splice(0)) await close();
});

async function fakeGoogle(routes: Record<string, Route>) {
	const seen: Seen[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});
		request.on("end", () => {
			const path = new URL(request.url ?? "/", "http://google.test").pathname;
			seen.push({ path, body, headers: request.headers });
			const answer = routes[path]?.(body) ?? { status: 404, json: { error: { message: `no route ${path}` } } };
			response.writeHead(answer.status ?? 200, { "Content-Type": "application/json" });
			response.end(JSON.stringify(answer.json));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	servers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const tokens: Route = () => ({ json: { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 } });
const userinfo: Route = () => ({ json: { email: "someone@example.com" } });

async function configFor(base: GoogleLoginConfig, google: string, env: Record<string, string> = {}) {
	return {
		...base,
		authUrl: `${google}/auth`,
		tokenUrl: `${google}/token`,
		userInfoUrl: `${google}/userinfo`,
		codeAssistEndpoints: [google],
		callbackHost: "127.0.0.1",
		callbackPort: await freePort(),
		env: (name: string) => env[name],
	} satisfies GoogleLoginConfig;
}

interface Script {
	consent: string;
	/** What is typed at the paste prompt, given the sign-in address; undefined leaves it waiting. */
	paste?: (authUrl: URL) => string;
	/** Runs when the sign-in address is shown, as a browser would. */
	browser?: (authUrl: URL) => void;
}

function person(script: Script) {
	const prompts: AuthPrompt[] = [];
	const events: AuthEvent[] = [];
	let authUrl: URL | undefined;
	let pasteWasCancelled = false;
	const interaction: ProviderAuthInteraction = {
		signal: new AbortController().signal,
		prompt: async (prompt) => {
			prompts.push(prompt);
			if (prompt.type === "select") return script.consent;
			if (prompt.type === "manual_code") {
				if (script.paste && authUrl) return script.paste(authUrl);
				return new Promise<string>((_resolve, reject) =>
					prompt.signal?.addEventListener("abort", () => {
						pasteWasCancelled = true;
						reject(new Error("Login cancelled"));
					}),
				);
			}
			throw new Error(`unexpected prompt ${prompt.type}`);
		},
		notify: (event) => {
			events.push(event);
			if (event.type === "auth_url") {
				authUrl = new URL(event.url);
				script.browser?.(authUrl);
			}
		},
	};
	return { interaction, prompts, events, pasteWasCancelled: () => pasteWasCancelled };
}

const redirectOf = (config: GoogleLoginConfig) => `http://localhost:${config.callbackPort}${config.callbackPath}`;

async function portIsFree(port: number): Promise<boolean> {
	const probe = createServer();
	return new Promise((resolve) => {
		probe.once("error", () => resolve(false));
		probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
	});
}

describe("Google sign-in", () => {
	it("says what the risk is first, and a no stops before any browser or server", async () => {
		const google = await fakeGoogle({});
		const config = await configFor(ANTIGRAVITY_LOGIN, google.url);
		const them = person({ consent: "cancel" });
		await expect(googleOAuth(config).login(them.interaction)).rejects.toThrow("Login cancelled");
		expect(them.prompts).toHaveLength(1);
		const consent = them.prompts[0];
		expect(consent.type).toBe("select");
		if (consent.type !== "select") return;
		expect(consent.message).toContain("Experimental");
		expect(consent.message).toContain("Google Antigravity");
		expect(consent.message).toMatch(/suspend/);
		expect(consent.options.map((option) => option.id)).toEqual(["continue", "cancel"]);
		expect(them.events.some((event) => event.type === "auth_url")).toBe(false);
		expect(google.seen).toEqual([]);
		expect(await portIsFree(config.callbackPort)).toBe(true);
	});

	it("signs in through the browser callback: PKCE, the token exchange, the account and its project", async () => {
		const google = await fakeGoogle({
			"/token": tokens,
			"/userinfo": userinfo,
			"/v1internal:loadCodeAssist": () => ({ json: { cloudaicompanionProject: "ag-project" } }),
		});
		const config = await configFor(ANTIGRAVITY_LOGIN, google.url);
		let forged = 0;
		const them = person({
			consent: "continue",
			browser: (authUrl) => {
				const state = authUrl.searchParams.get("state") ?? "";
				const base = `http://127.0.0.1:${config.callbackPort}${config.callbackPath}`;
				void (async () => {
					// Another page reaching the port first is turned away, and the sign-in goes on.
					forged = (await fetch(`${base}?code=evil&state=someone-else`)).status;
					await fetch(`${base}?code=cb-code&state=${state}`);
				})();
			},
		});
		const credential = await googleOAuth(config).login(them.interaction);
		expect(forged).toBe(400);

		const shown = them.events.find((event) => event.type === "auth_url");
		expect(shown?.type).toBe("auth_url");
		const authUrl = new URL(shown?.type === "auth_url" ? shown.url : "");
		expect(authUrl.searchParams.get("client_id")).toBe(ANTIGRAVITY_LOGIN.clientId);
		expect(authUrl.searchParams.get("redirect_uri")).toBe(redirectOf(config));
		expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authUrl.searchParams.get("access_type")).toBe("offline");
		expect(authUrl.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/cclog");
		const verifier = authUrl.searchParams.get("state") ?? "";
		expect(authUrl.searchParams.get("code_challenge")).toBe(
			createHash("sha256").update(verifier).digest("base64url"),
		);

		const exchange = new URLSearchParams(google.seen.find((request) => request.path === "/token")?.body);
		expect(exchange.get("grant_type")).toBe("authorization_code");
		expect(exchange.get("code")).toBe("cb-code");
		expect(exchange.get("code_verifier")).toBe(verifier);
		expect(exchange.get("redirect_uri")).toBe(redirectOf(config));
		expect(exchange.get("client_id")).toBe(ANTIGRAVITY_LOGIN.clientId);

		expect(credential).toMatchObject({
			type: "oauth",
			access: "access-1",
			refresh: "refresh-1",
			projectId: "ag-project",
			email: "someone@example.com",
		});
		expect(credential.expires).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
		expect(credential.expires).toBeLessThan(Date.now() + 56 * 60 * 1000);
		expect(them.pasteWasCancelled()).toBe(true);
		expect(await portIsFree(config.callbackPort)).toBe(true);
	});

	it("ends at once when the person cancels on Google's page, and frees the port; another sign-in's refusal does not end it", async () => {
		const google = await fakeGoogle({});
		const config = await configFor(GEMINI_CLI_LOGIN, google.url);
		let stranger = 0;
		const them = person({
			consent: "continue",
			browser: (authUrl) => {
				const base = `http://127.0.0.1:${config.callbackPort}${config.callbackPath}`;
				void (async () => {
					stranger = (await fetch(`${base}?error=access_denied&state=someone-else`)).status;
					await fetch(`${base}?error=access_denied<script>&state=${authUrl.searchParams.get("state")}`);
				})();
			},
		});
		await expect(googleOAuth(config).login(them.interaction)).rejects.toThrow(
			"Google sign-in was declined: access_deniedscript",
		);
		expect(stranger).toBe(400);
		expect(google.seen).toEqual([]);
		expect(them.pasteWasCancelled()).toBe(true);
		expect(await portIsFree(config.callbackPort)).toBe(true);
	});

	it("takes the address a browser on another machine ended on, and refuses one from another sign-in", async () => {
		const google = await fakeGoogle({
			"/token": tokens,
			"/userinfo": userinfo,
			"/v1internal:loadCodeAssist": () => ({
				json: { currentTier: { id: "free-tier" }, cloudaicompanionProject: "cli-project" },
			}),
		});
		const config = await configFor(GEMINI_CLI_LOGIN, google.url);
		const pasted = person({
			consent: "continue",
			paste: (authUrl) => `${redirectOf(config)}?code=pasted-code&state=${authUrl.searchParams.get("state")}`,
		});
		const credential = await googleOAuth(config).login(pasted.interaction);
		expect(credential).toMatchObject({ access: "access-1", projectId: "cli-project" });
		expect(new URLSearchParams(google.seen.find((request) => request.path === "/token")?.body).get("code")).toBe(
			"pasted-code",
		);

		const forged = person({ consent: "continue", paste: () => `${redirectOf(config)}?code=x&state=someone-else` });
		await expect(
			googleOAuth(await configFor(GEMINI_CLI_LOGIN, google.url)).login(forged.interaction),
		).rejects.toThrow("OAuth state mismatch");
		expect(parsePasted("  4/abc  ")).toEqual({ code: "4/abc" });
		expect(parsePasted("")).toEqual({});
	});

	it("Gemini CLI: an account without a project gets one on the free tier; a paid tier needs GOOGLE_CLOUD_PROJECT", async () => {
		let onboarded = "";
		const free = await fakeGoogle({
			"/token": tokens,
			"/userinfo": userinfo,
			"/v1internal:loadCodeAssist": () => ({ json: { allowedTiers: [{ id: "free-tier", isDefault: true }] } }),
			"/v1internal:onboardUser": (body) => {
				onboarded = body;
				return { json: { done: true, response: { cloudaicompanionProject: { id: "free-project" } } } };
			},
		});
		const paste = (config: GoogleLoginConfig) => (authUrl: URL) =>
			`${redirectOf(config)}?code=c&state=${authUrl.searchParams.get("state")}`;
		const freeConfig = await configFor(GEMINI_CLI_LOGIN, free.url);
		const credential = await googleOAuth(freeConfig).login(
			person({ consent: "continue", paste: paste(freeConfig) }).interaction,
		);
		expect(credential).toMatchObject({ projectId: "free-project" });
		expect(JSON.parse(onboarded)).toMatchObject({ tierId: "free-tier" });
		expect(JSON.parse(onboarded).cloudaicompanionProject).toBeUndefined();

		const paid = await fakeGoogle({
			"/token": tokens,
			"/userinfo": userinfo,
			"/v1internal:loadCodeAssist": () => ({ json: { allowedTiers: [{ id: "standard-tier", isDefault: true }] } }),
		});
		const paidConfig = await configFor(GEMINI_CLI_LOGIN, paid.url);
		await expect(
			googleOAuth(paidConfig).login(person({ consent: "continue", paste: paste(paidConfig) }).interaction),
		).rejects.toThrow("GOOGLE_CLOUD_PROJECT");
	});

	it("Antigravity falls back to its own project when the account has none", async () => {
		const google = await fakeGoogle({
			"/token": tokens,
			"/userinfo": userinfo,
			"/v1internal:loadCodeAssist": () => ({ status: 500, json: { error: { message: "down" } } }),
		});
		const config = await configFor(ANTIGRAVITY_LOGIN, google.url);
		const credential = await googleOAuth(config).login(
			person({
				consent: "continue",
				paste: (authUrl) => `${redirectOf(config)}?code=c&state=${authUrl.searchParams.get("state")}`,
			}).interaction,
		);
		expect(credential).toMatchObject({ projectId: "rising-fact-p41fc" });
	});

	it("refresh keeps the project and the refresh token Google did not rotate; request auth carries both", async () => {
		const google = await fakeGoogle({ "/token": () => ({ json: { access_token: "access-2", expires_in: 3600 } }) });
		const oauth = googleOAuth(await configFor(GEMINI_CLI_LOGIN, google.url));
		const old: OAuthCredential = {
			type: "oauth",
			access: "access-1",
			refresh: "refresh-1",
			expires: 0,
			projectId: "p",
		};
		const renewed = await oauth.refresh(old, new AbortController().signal);
		expect(renewed).toMatchObject({ access: "access-2", refresh: "refresh-1", projectId: "p" });
		expect(new URLSearchParams(google.seen[0]?.body).get("grant_type")).toBe("refresh_token");
		expect(JSON.parse((await oauth.toAuth(renewed)).apiKey ?? "")).toEqual({ token: "access-2", projectId: "p" });
		await expect(
			oauth.refresh({ type: "oauth", access: "a", refresh: "r", expires: 0 }, new AbortController().signal),
		).rejects.toThrow("no project");
		expect(cloudCodeKey(renewed)).toBe(JSON.stringify({ token: "access-2", projectId: "p" }));
	});
});

// ---------------------------------------------------------------------------
// The stream

interface Call {
	url: string;
	headers: Record<string, string>;
	body: {
		project: string;
		model: string;
		requestType?: string;
		userAgent: string;
		request: {
			contents: unknown[];
			systemInstruction?: { role?: string; parts: { text: string }[] };
			generationConfig?: { maxOutputTokens?: number; thinkingConfig?: Record<string, unknown> };
			tools?: { functionDeclarations: Record<string, unknown>[] }[];
		};
	};
}

const sse = (...chunks: unknown[]) => chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");

function google(answers: ((call: Call) => Response)[]) {
	const calls: Call[] = [];
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		const call: Call = {
			url: String(input),
			headers: init?.headers as Record<string, string>,
			body: JSON.parse(String(init?.body)),
		};
		calls.push(call);
		return answers[Math.min(calls.length - 1, answers.length - 1)](call);
	}) as typeof fetch;
	return { fetcher, calls };
}

const answer = (body: string, status = 200) =>
	new Response(body, {
		status,
		headers: { "Content-Type": status === 200 ? "text/event-stream" : "application/json" },
	});

const KEY = JSON.stringify({ token: "tok", projectId: "proj-7" });

const context = (tools = false): Context => ({
	systemPrompt: "You are mu.",
	messages: [{ role: "user", content: "Read the notes.", timestamp: 1 }],
	...(tools
		? {
				tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
			}
		: {}),
});

const cliModel = (id: string) => {
	const model = geminiCliModels().find((entry) => entry.id === id);
	if (!model) throw new Error(`no ${id}`);
	return model;
};
const agModel = (id: string) => {
	const model = antigravityBaseline().find((entry) => entry.id === id);
	if (!model) throw new Error(`no ${id}`);
	return model;
};

async function run(
	model: Model<Api>,
	fetcher: typeof fetch,
	options: Record<string, unknown> = {},
	tools = false,
): Promise<AssistantMessage> {
	const events = stream(model, normalizeContext(context(tools)), { apiKey: KEY, fetch: fetcher, ...options });
	return events.result();
}

describe("Cloud Code Assist stream", () => {
	it("reads thinking, text and a tool call out of the events, with usage", async () => {
		const { fetcher, calls } = google([
			() =>
				answer(
					sse(
						{
							response: {
								responseId: "r-1",
								candidates: [{ content: { parts: [{ text: "Plan: ", thought: true }] } }],
							},
						},
						{
							response: {
								candidates: [
									{ content: { parts: [{ text: "read it", thought: true, thoughtSignature: "c2ln" }] } },
								],
							},
						},
						{ response: { candidates: [{ content: { parts: [{ text: "Reading." }] } }] } },
						{
							response: {
								candidates: [
									{
										content: {
											parts: [{ functionCall: { name: "read", args: { path: "notes.md" }, id: "call-1" } }],
										},
										finishReason: "STOP",
									},
								],
								usageMetadata: {
									promptTokenCount: 120,
									cachedContentTokenCount: 20,
									candidatesTokenCount: 30,
									thoughtsTokenCount: 10,
									totalTokenCount: 160,
								},
							},
						},
					),
				),
		]);
		const message = await run(cliModel("gemini-3.8-flash"), fetcher, {}, true);
		expect(message.stopReason).toBe("toolUse");
		expect(message.responseId).toBe("r-1");
		expect(message.content).toEqual([
			{ type: "thinking", thinking: "Plan: read it", thinkingSignature: "c2ln" },
			{ type: "text", text: "Reading." },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "notes.md" } },
		]);
		expect(message.usage).toMatchObject({ input: 100, cacheRead: 20, output: 40, reasoning: 10, totalTokens: 160 });

		const [call] = calls;
		expect(call.url).toBe(`${CLOUD_CODE_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`);
		expect(call.headers.Authorization).toBe("Bearer tok");
		expect(call.headers["User-Agent"]).toContain("google-cloud-sdk");
		expect(call.body).toMatchObject({ project: "proj-7", model: "gemini-3.8-flash", userAgent: "pi-coding-agent" });
		expect(call.body.requestType).toBeUndefined();
		expect(call.body.request.systemInstruction).toEqual({ parts: [{ text: "You are mu." }] });
		expect(call.body.request.tools?.[0].functionDeclarations[0]).toHaveProperty("parametersJsonSchema");
	});

	it("Antigravity: the agent request, its system prompt first, and Claude's tools in the older form", async () => {
		const { fetcher, calls } = google([
			() =>
				answer(sse({ response: { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] } })),
		]);
		const message = await run(agModel("claude-sonnet-4-5-thinking"), fetcher, {}, true);
		expect(message.stopReason).toBe("stop");
		const [call] = calls;
		expect(call.url.startsWith(ANTIGRAVITY_ENDPOINTS[0])).toBe(true);
		expect(call.headers["User-Agent"]).toMatch(/^antigravity\//);
		expect(call.headers["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14");
		expect(call.body).toMatchObject({ requestType: "agent", userAgent: "antigravity" });
		const system = call.body.request.systemInstruction;
		expect(system?.role).toBe("user");
		expect(system?.parts[0].text).toMatch(/^You are Antigravity/);
		expect(system?.parts.at(-1)?.text).toBe("You are mu.");
		const declaration = call.body.request.tools?.[0].functionDeclarations[0];
		expect(declaration).toHaveProperty("parameters");
		expect(declaration).not.toHaveProperty("parametersJsonSchema");
	});

	it("moves to the next Antigravity endpoint on 403 at once, and stops on an error it cannot fix", async () => {
		const moved = google([
			() => answer("{}", 403),
			() =>
				answer(sse({ response: { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] } })),
		]);
		const message = await run(agModel("gemini-3-flash"), moved.fetcher);
		expect(message.stopReason).toBe("stop");
		expect(moved.calls.map((call) => new URL(call.url).origin)).toEqual([...ANTIGRAVITY_ENDPOINTS.slice(0, 2)]);

		const refused = google([() => answer(JSON.stringify({ error: { message: "Invalid argument" } }), 400)]);
		const failed = await run(cliModel("gemini-2.5-flash"), refused.fetcher);
		expect(failed.stopReason).toBe("error");
		expect(failed.errorMessage).toBe("Cloud Code Assist error (400): Invalid argument");
		expect(refused.calls).toHaveLength(1);

		// A wait longer than the caller allows is said, not slept through.
		const limited = google([() => answer(JSON.stringify({ error: { message: "Please retry in 120s" } }), 429)]);
		const tooLong = await run(cliModel("gemini-2.5-flash"), limited.fetcher, { maxRetryDelayMs: 5000 });
		expect(tooLong.errorMessage).toMatch(/asked to wait 121s/);
		expect(limited.calls).toHaveLength(1);
	});

	it("asks again when an answer comes back empty", async () => {
		const { fetcher, calls } = google([
			() => answer(sse({ response: { candidates: [] } })),
			() =>
				answer(
					sse({ response: { candidates: [{ content: { parts: [{ text: "here" }] }, finishReason: "STOP" }] } }),
				),
		]);
		const message = await run(cliModel("gemini-2.5-flash"), fetcher);
		expect(message.content).toEqual([{ type: "text", text: "here" }]);
		expect(calls).toHaveLength(2);
	});

	it("without a complete sign-in, it says to sign in and sends nothing", async () => {
		const { fetcher, calls } = google([() => answer("")]);
		const events = stream(cliModel("gemini-2.5-flash"), normalizeContext(context()), { fetch: fetcher });
		expect((await events.result()).errorMessage).toMatch(/\/login/);
		const partial = stream(cliModel("gemini-2.5-flash"), normalizeContext(context()), {
			apiKey: JSON.stringify({ token: "t" }),
			fetch: fetcher,
		});
		expect((await partial.result()).errorMessage).toMatch(/incomplete/);
		expect(calls).toEqual([]);
	});

	it("thinking: Gemini 3 at a level, Gemini 2.5 on a budget under the output limit, and off where it can be", async () => {
		const done = () =>
			answer(sse({ response: { candidates: [{ content: { parts: [{ text: "." }] }, finishReason: "STOP" }] } }));
		const { fetcher, calls } = google([done]);
		const simple = (model: Model<Api>, reasoning?: "medium" | "high") =>
			streamSimple(model, normalizeContext(context()), { apiKey: KEY, fetch: fetcher, reasoning }).result();

		await simple(cliModel("gemini-3.8-flash"), "high");
		expect(calls[0].body.request.generationConfig?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingLevel: "HIGH",
		});

		await simple(cliModel("gemini-2.5-flash"), "medium");
		const budget = calls[1].body.request.generationConfig;
		expect(budget?.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 8192 });
		expect(budget?.maxOutputTokens).toBe(cliModel("gemini-2.5-flash").maxTokens);

		await simple(cliModel("gemini-2.5-flash"));
		expect(calls[2].body.request.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 0 });

		// Gemini 3 Pro cannot stop thinking: "off" asks for its lowest level, without showing the thoughts.
		await simple(agModel("gemini-3.1-pro-high"));
		expect(calls[3].body.request.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
	});

	it("builds the request without a network, and knows its endpoints and the server's wait", () => {
		const request = buildCloudCodeRequest(cliModel("gemini-3.8-flash"), normalizeContext(context()), "p", {
			sessionId: "s-1",
		});
		expect(request).toMatchObject({ project: "p", model: "gemini-3.8-flash", request: { sessionId: "s-1" } });

		expect(endpointsFor(cliModel("gemini-2.5-pro"))).toEqual([CLOUD_CODE_ENDPOINT]);
		expect(endpointsFor(agModel("gemini-3-flash"))).toEqual([...ANTIGRAVITY_ENDPOINTS]);
		expect(endpointsFor({ ...agModel("gemini-3-flash"), baseUrl: CLOUD_CODE_ENDPOINT })).toEqual([
			CLOUD_CODE_ENDPOINT,
			...ANTIGRAVITY_ENDPOINTS.slice(0, 2),
		]);
		expect(endpointsFor({ ...agModel("gemini-3-flash"), baseUrl: "http://127.0.0.1:9/" })).toEqual([
			"http://127.0.0.1:9",
		]);

		expect(retryDelay("Your quota will reset after 1m2s.")).toBe(63_000);
		expect(retryDelay('{"error":{"details":[{"retryDelay": "2.5s"}]}}')).toBe(3500);
		expect(retryDelay("Please retry in 500ms")).toBe(1500);
		expect(retryDelay("", new Headers({ "retry-after": "3" }))).toBe(4000);
		expect(retryDelay("slow down")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// The providers

describe("Google providers", () => {
	it("Gemini CLI serves Google's Gemini chat models, at no charge", () => {
		const models = geminiCliModels();
		const ids = models.map((model) => model.id);
		expect(ids).toEqual(expect.arrayContaining(["gemini-2.5-pro", "gemini-3.1-pro-preview", "gemini-3.8-flash"]));
		for (const id of ids) expect(id).not.toMatch(/image|live|customtools|latest|deep-research|gemma/);
		for (const model of models) {
			expect(model).toMatchObject({
				api: CLOUD_CODE_API,
				provider: "google-gemini-cli",
				baseUrl: CLOUD_CODE_ENDPOINT,
				cost: { input: 0, output: 0 },
			});
		}
		expect(cliModel("gemini-3.8-flash").thinkingLevelMap?.minimal).toBeNull();
	});

	it("reads what Antigravity lists: known models keep what is known, new ones take their family's limits", () => {
		const models = antigravityModelsFrom({
			models: {
				"claude-sonnet-4-5": { displayName: "Claude Sonnet 4.5" },
				"claude-opus-5-thinking": { displayName: "Claude Opus 5 Thinking", maxOutputTokens: 128000 },
				"claude-haiku-5": { displayName: "Claude Haiku 5" },
				"gemini-3.8-flash": {},
				"gpt-oss-240b": { displayName: "GPT-OSS 240B" },
				"gemini-3-pro-image": {},
				chat_20706: {},
				"tab-completion": {},
			},
		});
		const byId = new Map(models.map((model) => [model.id, model]));
		expect([...byId.keys()]).toEqual([
			"claude-sonnet-4-5",
			"claude-opus-5-thinking",
			"claude-haiku-5",
			"gemini-3.8-flash",
			"gpt-oss-240b",
		]);
		expect(byId.get("claude-sonnet-4-5")).toEqual(agModel("claude-sonnet-4-5"));
		expect(byId.get("claude-opus-5-thinking")).toMatchObject({
			name: "Claude Opus 5 Thinking (Antigravity)",
			reasoning: true,
			maxTokens: 128000,
			contextWindow: 200000,
			input: ["text", "image"],
		});
		expect(byId.get("claude-haiku-5")?.reasoning).toBe(false);
		expect(byId.get("gemini-3.8-flash")).toMatchObject({ reasoning: true, contextWindow: 1048576 });
		expect(byId.get("gemini-3.8-flash")?.thinkingLevelMap?.minimal).toBe("minimal");
		expect(byId.get("gpt-oss-240b")).toMatchObject({ input: ["text"], reasoning: false });

		expect(
			antigravityModelsFrom({ models: [{ id: "claude-x-1" }, { name: "no id" }] }).map((model) => model.id),
		).toEqual(["claude-x-1"]);
		expect(antigravityModelsFrom("nonsense")).toEqual([]);
		expect(antigravityModelsFrom({ models: 3 })).toEqual([]);
	});

	it("speaks to Antigravity as its command line, from 1.3.0, which is served Gemini 4 Argon; the version can be raised", () => {
		expect(ANTIGRAVITY_CLI_VERSION).toBe("1.4.0");
		expect(antigravityUserAgent(() => undefined)).toBe("antigravity/cli/1.4.0");
		expect(antigravityUserAgent((name) => (name === "MU_ANTIGRAVITY_VERSION" ? "1.9.2" : undefined))).toBe(
			"antigravity/cli/1.9.2",
		);
	});

	it("reads Gemini 4 Argon's tiers as Antigravity lists them, and leaves out a model the account may not use", () => {
		// Fields as a paid account's fetchAvailableModels answered the command line on 2026-10-24 (trimmed).
		const argon = (tier: string) => ({
			displayName: `Gemini 4 Argon (${tier})`,
			supportsImages: true,
			supportsThinking: true,
			thinkingBudget: -1,
			minThinkingBudget: 32,
			maxTokens: 1048576,
			maxOutputTokens: 65536,
			tagTitle: "New",
		});
		const models = antigravityModelsFrom({
			models: {
				"gemini-4-argon-low": argon("Low"),
				"gemini-4-argon-medium": argon("Medium"),
				"gemini-4-argon-high": argon("High"),
				"gemini-4-argon-disabled": argon("High"),
				"gemini-3.8-flash-medium": { displayName: "Gemini 3.8 Flash (Medium)", maxTokens: 1048576 },
				"claude-opus-5-5-low": {
					displayName: "Claude Opus 5.5 (Low)",
					supportsThinking: true,
					maxTokens: 1000000,
					maxOutputTokens: 128000,
				},
				"claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6", disabled: true },
			},
		});
		const byId = new Map(models.map((model) => [model.id, model]));
		expect([...byId.keys()]).toEqual([
			"gemini-4-argon-low",
			"gemini-4-argon-medium",
			"gemini-4-argon-high",
			"gemini-3.8-flash-medium",
			"claude-opus-5-5-low",
		]);
		expect(byId.get("gemini-4-argon-medium")).toMatchObject({
			name: "Gemini 4 Argon (Medium) (Antigravity)",
			provider: "google-antigravity",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1048576,
			maxTokens: 65536,
		});
		// Gemini 4 thinks at low, medium or high: never off, never minimal (pi would send what Argon refuses).
		expect(byId.get("gemini-4-argon-medium")?.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		});
		expect(byId.get("gemini-3.8-flash-medium")?.thinkingLevelMap?.minimal).toBe("minimal");
		// The context Antigravity says, where it says one.
		expect(byId.get("claude-opus-5-5-low")).toMatchObject({
			contextWindow: 1000000,
			maxTokens: 128000,
			reasoning: true,
		});
	});

	it("asks Antigravity what this account can use, endpoint by endpoint, and only when signed in", async () => {
		const asked: { url: string; headers: Record<string, string> }[] = [];
		const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
			asked.push({ url: String(input), headers: init?.headers as Record<string, string> });
			return asked.length === 1
				? new Response("{}", { status: 503 })
				: new Response(JSON.stringify({ models: { "gemini-3-flash": {} } }), { status: 200 });
		}) as typeof fetch;
		const refresh = (credential?: RefreshModelsContext["credential"]): RefreshModelsContext => ({
			credential,
			allowNetwork: true,
			signal: new AbortController().signal,
			publish: async () => true,
		});

		expect(await fetchAntigravityModels(refresh(), fetcher)).toEqual([]);
		expect(asked).toEqual([]);

		const listed = await fetchAntigravityModels(
			refresh({ type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 60_000, projectId: "p" }),
			fetcher,
		);
		expect(listed.map((model) => model.id)).toEqual(["gemini-3-flash"]);
		expect(asked.map((request) => request.url)).toEqual(
			ANTIGRAVITY_ENDPOINTS.slice(0, 2).map((endpoint) => `${endpoint}/v1internal:fetchAvailableModels`),
		);
		expect(asked[0].headers.Authorization).toBe("Bearer tok");
		expect(asked[0].headers["User-Agent"]).toBe(`antigravity/cli/${ANTIGRAVITY_CLI_VERSION}`);
	});
});

// ---------------------------------------------------------------------------
// Through pi: the sign-in shows up in /login, and a stored sign-in streams

describe("googleLogin feature", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	const start = async (features: Record<string, unknown> = {}) => {
		harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(),
					config: parseConfig({ features }),
					only: ["googleLogin"],
				}),
			],
		});
		await harness.session.bindExtensions({});
		return harness;
	};

	it("adds both sign-ins to pi's providers, experimental in name, and a no at the risk question ends the login", async () => {
		const { session } = await start();
		const runtime = session.modelRuntime;
		const cli = runtime.getProvider("google-gemini-cli");
		const antigravity = runtime.getProvider("google-antigravity");
		expect(cli?.auth.oauth?.name).toBe("Google Gemini CLI (experimental)");
		expect(antigravity?.auth.oauth?.loginLabel).toBe("Sign in with Google through Google Antigravity (experimental)");
		expect(runtime.getModel("google-gemini-cli", "gemini-3.8-flash")).toBeDefined();
		expect(runtime.getModel("google-antigravity", "claude-opus-4-6-thinking")).toBeDefined();

		const prompts: AuthPrompt[] = [];
		await expect(
			runtime.login("google-antigravity", "oauth", {
				prompt: async (prompt) => {
					prompts.push(prompt);
					return "cancel";
				},
				notify: () => {},
			}),
		).rejects.toThrow("Login cancelled");
		expect(prompts.map((prompt) => prompt.type)).toEqual(["select"]);
	});

	it("streams with a stored sign-in: the credential becomes the token and project the request carries", async () => {
		const { session, authStorage } = await start();
		await authStorage.modify("google-gemini-cli", async () => ({
			type: "oauth",
			access: "stored-token",
			refresh: "stored-refresh",
			expires: Date.now() + 3_600_000,
			projectId: "stored-project",
		}));
		const model = session.modelRuntime.getModel("google-gemini-cli", "gemini-2.5-flash");
		if (!model) throw new Error("no model");
		const { fetcher, calls } = google([
			() =>
				answer(
					sse({ response: { candidates: [{ content: { parts: [{ text: "hello" }] }, finishReason: "STOP" }] } }),
				),
		]);
		const message = await session.modelRuntime.completeSimple(model, context(), { fetch: fetcher });
		expect(message.content).toEqual([{ type: "text", text: "hello" }]);
		expect(calls[0].headers.Authorization).toBe("Bearer stored-token");
		expect(calls[0].body.project).toBe("stored-project");
	});

	it("reads what Antigravity serves a signed-in account again as a terminal or app session starts", async () => {
		const asked: { url: string; userAgent: string }[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
			asked.push({ url: String(input), userAgent: (init?.headers as Record<string, string>)["User-Agent"] });
			return new Response(
				JSON.stringify({ models: { "gemini-4-argon-medium": { displayName: "Gemini 4 Argon (Medium)" } } }),
				{ status: 200 },
			);
		});
		const ui = new Proxy({}, { get: () => () => undefined }) as unknown as ExtensionUIContext;
		const session = async (mode: "rpc" | "print", signedIn: boolean) => {
			harness?.cleanup();
			harness = await createHarness({
				extensionFactories: [
					createKyrnJudgeExtension({
						provider: new MockJudgeProvider(),
						config: parseConfig({ features: {} }),
						only: ["googleLogin"],
					}),
				],
			});
			if (signedIn) {
				await harness.authStorage.modify("google-antigravity", async () => ({
					type: "oauth",
					access: "stored-token",
					refresh: "stored-refresh",
					expires: Date.now() + 3_600_000,
					projectId: "stored-project",
				}));
				// As a process that starts signed in has it: the stored sign-in read before the session starts.
				await harness.session.modelRuntime.refresh({ allowNetwork: false });
			}
			await harness.session.bindExtensions(mode === "rpc" ? { uiContext: ui, mode } : {});
			return harness.session.modelRuntime;
		};
		try {
			// Told to stay offline (as these tests run), not signed in, or a one-off print run: nothing is asked.
			await session("rpc", true);
			vi.stubEnv("PI_OFFLINE", undefined);
			await session("rpc", false);
			await session("print", true);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(asked).toEqual([]);

			const runtime = await session("rpc", true);
			await vi.waitFor(() => expect(runtime.getModel("google-antigravity", "gemini-4-argon-medium")).toBeDefined());
			expect(asked).toEqual([
				{
					url: `${ANTIGRAVITY_ENDPOINTS[0]}/v1internal:fetchAvailableModels`,
					userAgent: `antigravity/cli/${ANTIGRAVITY_CLI_VERSION}`,
				},
			]);
			// Once per session's process: a new session in it does not ask again.
			await harness?.session.bindExtensions({ uiContext: ui, mode: "rpc" });
			expect(asked).toHaveLength(1);
		} finally {
			vi.unstubAllEnvs();
			vi.unstubAllGlobals();
		}
	});

	it("each sign-in can be switched off", async () => {
		const { session } = await start({ googleLogin: { antigravity: false } });
		expect(session.modelRuntime.getProvider("google-gemini-cli")).toBeDefined();
		expect(session.modelRuntime.getProvider("google-antigravity")).toBeUndefined();
	});
});
