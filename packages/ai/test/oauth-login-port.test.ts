import { createServer, get, type Server } from "node:http";
import { connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallbackPortInUseError, LoginTakenOverError } from "../src/auth/oauth/callback-port.ts";
import { openaiChatGPTOAuth } from "../src/auth/oauth/openai-chatgpt.ts";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";
import type { AuthPrompt, ProviderAuthInteraction } from "../src/auth/types.ts";

/**
 * Every test here listens on the real port, 1455, which OpenAI's sign-ins share with the Codex CLI. They are in this
 * one file, run one after another, because tests in other files run at the same time and a sign-in on the port now
 * takes it over from another: the rest of the OAuth tests listen on a free port instead.
 */

const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const REQUIRED_SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const DEVICE_ID = "e61bbe28-07ef-466d-8e5d-a344f94ab305";
const neverAbortedSignal = new AbortController().signal;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function getUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

/** OpenAI's token endpoint for Sign in with ChatGPT. */
function stubChatGPTTokens() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: unknown) => {
			expect(getUrl(input)).toBe(TOKEN_URL);
			return jsonResponse({
				access_token: "access-token",
				refresh_token: "refresh-token",
				expires_in: 3600,
				id_token: "id-token",
				scope: REQUIRED_SCOPE,
			});
		}),
	);
}

function createAccessToken(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64");
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": {
				chatgpt_account_id: accountId,
			},
		}),
	).toString("base64");
	return `${header}.${payload}.signature`;
}

/**
 * The callback port, 1455, as the flow really listens on it: every way a sign-in ends gives it back, a later sign-in of
 * ours takes it over from an earlier one, and another program on it is named and left alone. QA, 2026-10-23: the
 * desktop app's Sign in with ChatGPT failed with "Port 1455 is in use, probably by an unfinished login in another pi
 * session or by the Codex CLI".
 */
describe.sequential("OpenAI's sign-ins on their callback port", () => {
	const PORT = 1455;
	const HOST = "127.0.0.1";
	const blockers: Server[] = [];

	/** Whether this test process could listen on the port right now. */
	const portFree = () =>
		new Promise<boolean>((resolve) => {
			const probe = createServer();
			probe.once("error", () => resolve(false));
			probe.listen(PORT, HOST, () => probe.close(() => resolve(true)));
		});

	/** Another program on the port, which answers as `respond` says and records what it is sent. */
	const occupy = async (respond: (path: string) => { status: number; body: string }) => {
		const seen: string[] = [];
		const blocker = createServer((request, response) => {
			seen.push(`${request.method} ${request.url}`);
			const { status, body } = respond(request.url ?? "/");
			response.writeHead(status, { "content-type": "text/html" }).end(body);
		});
		await new Promise<void>((resolve, reject) => {
			blocker.once("error", reject);
			blocker.listen(PORT, HOST, () => resolve());
		});
		blockers.push(blocker);
		return seen;
	};

	/** The browser coming back from the authorize page to the redirect address. */
	const browserReturns = (authorizeUrl: URL, clientId = "oaiapp_issued") => {
		const callback = new URL(authorizeUrl.searchParams.get("redirect_uri") ?? "");
		callback.searchParams.set("code", "authorization-code");
		callback.searchParams.set("state", authorizeUrl.searchParams.get("state") ?? "");
		callback.searchParams.set("client_id", clientId);
		return new Promise<number>((resolve, reject) => {
			get(callback, { agent: false }, (response) => {
				response.resume();
				resolve(response.statusCode ?? 0);
			}).on("error", reject);
		});
	};

	/**
	 * A sign-in as the app runs it: the page to open, and a paste field that stays open until the flow withdraws it.
	 * `browser` makes the browser come back by itself; `ignoresSignal` is a prompt that never settles.
	 */
	const signIn = (options: { signal?: AbortSignal; browser?: boolean; ignoresSignal?: boolean; paste?: string }) => {
		let opened: (url: URL) => void = () => {};
		const authorize = new Promise<URL>((resolve) => {
			opened = resolve;
		});
		const interaction: ProviderAuthInteraction = {
			signal: options.signal ?? new AbortController().signal,
			notify: (event) => {
				if (event.type !== "auth_url") return;
				const url = new URL(event.url);
				opened(url);
				if (options.browser) void browserReturns(url);
			},
			prompt: (prompt: AuthPrompt) =>
				new Promise<string>((resolve, reject) => {
					if (options.paste !== undefined) {
						void authorize.then((url) => {
							const pasted = new URL(options.paste ?? "");
							pasted.searchParams.set("state", url.searchParams.get("state") ?? "");
							resolve(pasted.toString());
						});
						return;
					}
					if (options.ignoresSignal) return;
					prompt.signal?.addEventListener("abort", () => reject(new Error("withdrawn")), { once: true });
				}),
		};
		const login = openaiChatGPTOAuth.login(interaction, {
			getDeviceId: () => DEVICE_ID,
			pasteOnly: options.paste !== undefined,
		});
		login.catch(() => undefined);
		return { login, authorize };
	};

	beforeEach(async (context) => {
		// A real program on this machine holds the port (the Codex CLI's login): leave it alone.
		if (!(await portFree())) context.skip();
		stubChatGPTTokens();
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		for (const blocker of blockers.splice(0)) await new Promise((resolve) => blocker.close(resolve));
		// Nothing a test started is left listening.
		expect(await portFree()).toBe(true);
	});

	it("signs in twice in a row, and gives the port back after each", async () => {
		const first = signIn({ browser: true });
		await expect(first.login).resolves.toMatchObject({ access: "access-token", clientId: "oaiapp_issued" });
		expect(await portFree()).toBe(true);
		const second = signIn({ browser: true });
		await expect(second.login).resolves.toMatchObject({ access: "access-token" });
		expect(await portFree()).toBe(true);
	});

	it("gives the port back when cancelled, and signs in again right after", async () => {
		const controller = new AbortController();
		const cancelled = signIn({ signal: controller.signal });
		await cancelled.authorize;
		expect(await portFree()).toBe(false);
		controller.abort();
		await expect(cancelled.login).rejects.toThrow("Login cancelled");
		expect(await portFree()).toBe(true);

		await expect(signIn({ browser: true }).login).resolves.toMatchObject({ access: "access-token" });
	});

	it("gives the port back when cancelled while its prompt never settles", async () => {
		const controller = new AbortController();
		const stuck = signIn({ signal: controller.signal, ignoresSignal: true });
		await stuck.authorize;
		controller.abort();
		await expect(stuck.login).rejects.toThrow("Login cancelled");
		expect(await portFree()).toBe(true);
	});

	it("takes the port over from an earlier sign-in of ours, which stops and says why", async () => {
		const earlier = signIn({});
		await earlier.authorize;
		const later = signIn({ browser: true });

		const stopped = await earlier.login.catch((error: unknown) => error);
		expect(stopped).toBeInstanceOf(LoginTakenOverError);
		expect(stopped).toMatchObject({ code: "login_taken_over" });
		expect((stopped as Error).message).toBe("Sign-in stopped: a newer sign-in started and took over port 1455.");
		await expect(later.login).resolves.toMatchObject({ access: "access-token" });
	});

	it("lets the Codex CLI's login take the port over", async () => {
		const pending = signIn({});
		await pending.authorize;
		// What the Codex CLI's login sends an older login server on the port before it listens itself.
		await new Promise<void>((resolve, reject) => {
			const socket = connect(PORT, HOST, () => {
				socket.end(`GET /cancel HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nConnection: close\r\n\r\n`);
			});
			socket.resume();
			socket.on("close", () => resolve());
			socket.on("error", reject);
		});
		await expect(pending.login).rejects.toThrow("the Codex CLI started its own sign-in on port 1455");
		expect(await portFree()).toBe(true);
	});

	it("names another program on the port, with a code an app can read, and leaves it alone", async () => {
		const seen = await occupy(() => ({ status: 404, body: "Not Found" }));
		const error = await signIn({ browser: true }).login.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(CallbackPortInUseError);
		expect(error).toMatchObject({ code: "port_in_use", port: 1455 });
		if (process.platform === "darwin") expect(error).toMatchObject({ holder: { pid: process.pid } });
		expect(seen).toEqual(["GET /pi-login"]);
		expect(await portFree()).toBe(false);
	});

	it("signs in with the pasted address alone, whoever holds the port", async () => {
		const seen = await occupy(() => ({ status: 400, body: "State mismatch" }));
		const pasted = signIn({
			paste: "http://127.0.0.1:1455/auth/callback?code=authorization-code&client_id=oaiapp_pasted",
		});
		await expect(pasted.login).resolves.toMatchObject({ access: "access-token", clientId: "oaiapp_pasted" });
		// It never listened, and never asked the holder anything.
		expect(seen).toEqual([]);
		expect((await pasted.authorize).searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
	});

	it("signs in the Codex way with the pasted redirect URL when another program keeps the port", async () => {
		// Another program on the port that answers no HTTP at all.
		const blocker = createServer();
		await new Promise<void>((resolve) => blocker.listen(PORT, HOST, () => resolve()));
		try {
			let exchangeBody: URLSearchParams | undefined;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: unknown, init?: RequestInit) => {
					expect(getUrl(input)).toBe("https://auth.openai.com/oauth/token");
					exchangeBody = new URLSearchParams(String(init?.body));
					return jsonResponse({
						access_token: createAccessToken("acct"),
						refresh_token: "refresh",
						expires_in: 3600,
					});
				}),
			);

			let authUrl = "";
			const infos: string[] = [];
			const credential = await openaiCodexOAuth.login({
				signal: neverAbortedSignal,
				notify: (event) => {
					if (event.type === "auth_url") authUrl = event.url;
					if (event.type === "info") infos.push(event.message);
				},
				prompt: async (prompt) => {
					if (prompt.type === "select") return "browser";
					if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
					const state = new URL(authUrl).searchParams.get("state");
					return `http://localhost:1455/auth/callback?code=pasted-code&state=${state}`;
				},
			});

			expect(credential.accountId).toBe("acct");
			expect(exchangeBody?.get("code")).toBe("pasted-code");
			expect(exchangeBody?.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
			// The person is told why the browser cannot finish by itself.
			expect(infos).toEqual([expect.stringMatching(/^Port 1455 is (in use by|held by)/)]);
		} finally {
			await new Promise((resolve) => blocker.close(resolve));
		}
	});

	it("signs in the Codex way after taking the port over from a Sign in with ChatGPT still waiting", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({ access_token: createAccessToken("acct"), refresh_token: "refresh", expires_in: 3600 }),
			),
		);
		// A prompt as an app shows it: open until the flow withdraws it.
		const waiting = (prompt: { signal?: AbortSignal }) =>
			new Promise<string>((_resolve, reject) => {
				prompt.signal?.addEventListener("abort", () => reject(new Error("withdrawn")), { once: true });
			});
		let chatgptOpened: () => void = () => {};
		const chatgptWaiting = new Promise<void>((resolve) => {
			chatgptOpened = resolve;
		});
		const chatgpt = openaiChatGPTOAuth.login(
			{
				signal: neverAbortedSignal,
				notify: (event) => {
					if (event.type === "auth_url") chatgptOpened();
				},
				prompt: waiting,
			},
			{ getDeviceId: () => DEVICE_ID },
		);
		chatgpt.catch(() => undefined);
		await chatgptWaiting;

		const credential = await openaiCodexOAuth.login({
			signal: neverAbortedSignal,
			notify: (event) => {
				if (event.type !== "auth_url") return;
				// The browser comes back to this sign-in's server.
				const state = new URL(event.url).searchParams.get("state");
				get(`http://127.0.0.1:1455/auth/callback?code=browser-code&state=${state}`, { agent: false }, (response) =>
					response.resume(),
				);
			},
			prompt: async (prompt) => (prompt.type === "select" ? "browser" : waiting(prompt)),
		});

		expect(credential.accountId).toBe("acct");
		await expect(chatgpt).rejects.toBeInstanceOf(LoginTakenOverError);
	});
});
