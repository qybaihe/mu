import { existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthInteraction, LoginOptions, ModelsStore, Provider } from "@earendil-works/pi-ai";
import * as pi from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH_USAGE, AUTH_COMMANDS as LAUNCHER_COMMANDS } from "../../../kyrn/bin/mu.mjs";
import { exitWhenUnlocked, holdLocksUntilExit } from "../src/auth/exit.ts";
import {
	AUTH_COMMANDS,
	type AuthIo,
	type AuthRuntime,
	BUILT_IN_PROVIDERS,
	modelsOf,
	runAuth,
} from "../src/auth/runner.ts";
import { antigravityProvider, geminiCliProvider } from "../src/google-login/providers.ts";

/**
 * `mu auth`, the desktop app's subscription sign-in, against a stand-in for pi's model runtime: the JSON lines it
 * speaks are the contract with the app (process/agent/kyrn/login.ts there).
 */

type Credential = { providerId: string; type: string };
const SECRET = "sk-oauth-refresh-token-that-must-never-be-printed";

class FakeRuntime implements AuthRuntime {
	credentials: Credential[] = [];
	registered: string[] = [];
	refreshed: { providers?: string[]; allowNetwork?: boolean }[] = [];
	loggedOut: string[] = [];
	/** What each sign-in told the flow about this mu. */
	loginOptions: (LoginOptions | undefined)[] = [];
	models: Record<string, { id: string; name?: string }[]> = {
		"openai-codex": [{ id: "gpt-5.4", name: "GPT-5.4" }, { id: "gpt-5.5", name: "GPT-5.5" }, { id: "gpt-5.5-mini" }],
		openai: [{ id: "gpt-5.4", name: "GPT-5.4" }, { id: "gpt-5.5", name: "GPT-5.5" }, { id: "gpt-5.5-mini" }],
		anthropic: [{ id: "claude-opus-4-8", name: "Claude Opus 4.8" }],
		"google-antigravity": [{ id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" }],
	};
	flow: (interaction: AuthInteraction) => Promise<void> = async () => {};

	async login(
		providerId: string,
		type: "oauth",
		interaction: AuthInteraction,
		options?: LoginOptions,
	): Promise<unknown> {
		this.loginOptions.push(options);
		await this.flow(interaction);
		this.credentials.push({ providerId, type });
		// What pi hands back is the credential itself: it must stay inside the runner.
		return { type: "oauth", access: SECRET, refresh: SECRET, expires: 0 };
	}
	async logout(providerId: string): Promise<void> {
		this.loggedOut.push(providerId);
		this.credentials = this.credentials.filter((credential) => credential.providerId !== providerId);
	}
	getModels(providerId?: string) {
		return providerId ? (this.models[providerId] ?? []) : Object.values(this.models).flat();
	}
	async listCredentials() {
		return this.credentials;
	}
	registerNativeProvider(provider: Provider): void {
		this.registered.push(provider.id);
	}
	async refresh(options: { providers?: string[]; allowNetwork?: boolean }) {
		this.refreshed.push({ providers: options.providers, allowNetwork: options.allowNetwork });
		if (options.allowNetwork && options.providers?.includes("google-antigravity")) {
			this.models["google-antigravity"] = [...this.models["google-antigravity"], { id: "claude-sonnet-4-6" }];
		}
		return {};
	}
}

/** The app's side of the pipe: what the runner said, and a way to write lines to it. */
function pipe() {
	const said: Record<string, unknown>[] = [];
	let write: (text: string) => void = () => {};
	let close: () => void = () => {};
	const io: AuthIo = {
		say: (message) => said.push(JSON.parse(JSON.stringify(message)) as Record<string, unknown>),
		listen: (line, end) => {
			write = line;
			close = end;
		},
	};
	return {
		io,
		said,
		send: (message: unknown) => write(JSON.stringify(message)),
		raw: (text: string) => write(text),
		close: () => close(),
	};
}

const preferred = { "openai-codex": "gpt-5.5", openai: "gpt-5.5", anthropic: "claude-opus-4-8" };
const googleish = (id: string) => ({ id }) as Provider;

describe("mu auth", () => {
	it("says who is signed in with a subscription, and what this mu can sign in to", async () => {
		// ChatGPT is offered through Sign in with ChatGPT (`openai`). An account signed in before through the Codex CLI's
		// login or with a Claude subscription still shows and signs out, but neither sign-in is offered any more.
		const runtime = new FakeRuntime();
		runtime.credentials = [
			{ providerId: "openai-codex", type: "oauth" },
			{ providerId: "anthropic", type: "oauth" },
			// A key is not a subscription sign-in, and an unknown provider is not the app's business.
			{ providerId: "xai", type: "api_key" },
			{ providerId: "openrouter", type: "oauth" },
		];
		const { io, said } = pipe();
		const code = await runAuth(["status"], { runtime, preferred, extra: [], io });
		expect(code).toBe(0);
		expect(said).toEqual([
			{
				type: "status",
				offered: ["openai", "xai"],
				signedIn: [
					{
						provider: "openai-codex",
						// pi's starting model first, the rest in the catalogue's order; a model without a name shows its id.
						models: [
							{ id: "gpt-5.5", name: "GPT-5.5" },
							{ id: "gpt-5.4", name: "GPT-5.4" },
							{ id: "gpt-5.5-mini", name: "gpt-5.5-mini" },
						],
					},
					{ provider: "anthropic", models: [{ id: "claude-opus-4-8", name: "Claude Opus 4.8" }] },
				],
			},
		]);
		expect(runtime.refreshed).toEqual([]);
	});

	it("offers mu's own sign-ins when they are on, loaded without going to the network", async () => {
		const runtime = new FakeRuntime();
		const { io, said } = pipe();
		const extra = [googleish("google-gemini-cli"), googleish("google-antigravity")];
		await runAuth(["status"], { runtime, preferred, extra, io });
		expect(runtime.registered).toEqual(["google-gemini-cli", "google-antigravity"]);
		expect(runtime.refreshed).toEqual([
			{ providers: ["google-gemini-cli", "google-antigravity"], allowNetwork: false },
		]);
		expect(said[0].offered).toEqual([...BUILT_IN_PROVIDERS, "google-gemini-cli", "google-antigravity"]);
	});

	it("signs out a subscription only, and then says who is still signed in", async () => {
		const runtime = new FakeRuntime();
		runtime.credentials = [
			{ providerId: "openai-codex", type: "oauth" },
			{ providerId: "anthropic", type: "api_key" },
		];
		const { io, said } = pipe();
		expect(await runAuth(["logout", "anthropic"], { runtime, preferred, extra: [], io })).toBe(0);
		expect(runtime.loggedOut).toEqual([]);
		expect(await runAuth(["logout", "openai-codex"], { runtime, preferred, extra: [], io })).toBe(0);
		expect(runtime.loggedOut).toEqual(["openai-codex"]);
		expect(said.at(-1)).toMatchObject({ type: "status", signedIn: [] });
	});

	it("walks a sign-in: the page to open, the browser chosen for the person, a pasted code, then the models", async () => {
		const runtime = new FakeRuntime();
		const asked: string[] = [];
		runtime.flow = async (interaction) => {
			interaction.notify({
				type: "auth_url",
				url: "https://auth.example/authorize?state=1",
				instructions: "Sign in",
			});
			const method = await interaction.prompt({
				type: "select",
				message: "How do you want to sign in?",
				options: [
					{ id: "browser", label: "Browser" },
					{ id: "device", label: "Device code" },
				],
			});
			asked.push(method);
			asked.push(
				await interaction.prompt({ type: "manual_code", message: "Paste the code", placeholder: "http://…" }),
			);
		};
		const app = pipe();
		const running = runAuth(["login", "openai"], { runtime, preferred, extra: [], io: app.io });
		await new Promise((resolve) => setTimeout(resolve, 0));
		// The method question never reaches the app: from the app it is always the browser on this machine.
		expect(app.said).toEqual([
			{
				type: "event",
				event: { type: "auth_url", url: "https://auth.example/authorize?state=1", instructions: "Sign in" },
			},
			{ type: "prompt", prompt: { type: "manual_code", message: "Paste the code", placeholder: "http://…" } },
		]);
		app.raw("not json");
		app.send({ type: "answer", value: "code-123" });
		expect(await running).toBe(0);
		expect(asked).toEqual(["browser", "code-123"]);
		expect(app.said.slice(2)).toEqual([
			{ type: "signed_in" },
			{
				type: "done",
				provider: "openai",
				models: [
					{ id: "gpt-5.5", name: "GPT-5.5" },
					{ id: "gpt-5.4", name: "GPT-5.4" },
					{ id: "gpt-5.5-mini", name: "gpt-5.5-mini" },
				],
			},
		]);
		expect(JSON.stringify(app.said)).not.toContain(SECRET);
	});

	it("signs in with ChatGPT as mu, with this installation's id", async () => {
		const runtime = new FakeRuntime();
		const login: LoginOptions = { agentName: "mu", getDeviceId: () => "device-1" };
		const app = pipe();
		expect(await runAuth(["login", "openai"], { runtime, preferred, extra: [], io: app.io, login })).toBe(0);
		expect(runtime.loginOptions).toEqual([login]);
		expect(runtime.credentials).toEqual([{ providerId: "openai", type: "oauth" }]);
		expect(app.said.at(-1)).toMatchObject({ type: "done", provider: "openai" });
	});

	it("reads what an account can use once it is signed in, where the account decides that", async () => {
		const runtime = new FakeRuntime();
		const app = pipe();
		const extra = [googleish("google-antigravity")];
		expect(await runAuth(["login", "google-antigravity"], { runtime, preferred, extra, io: app.io })).toBe(0);
		expect(runtime.refreshed.at(-1)).toEqual({ providers: ["google-antigravity"], allowNetwork: true });
		expect(app.said.at(-1)).toEqual({
			type: "done",
			provider: "google-antigravity",
			models: [
				{ id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
				{ id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" },
			],
		});
	});

	it("stops when the app cancels, and when the app goes away", async () => {
		for (const stop of ["cancel", "close"] as const) {
			const runtime = new FakeRuntime();
			let signal: AbortSignal | undefined;
			runtime.flow = async (interaction) => {
				signal = interaction.signal;
				await interaction.prompt({ type: "text", message: "Your e-mail" });
			};
			const app = pipe();
			const running = runAuth(["login", "xai"], { runtime, preferred, extra: [], io: app.io });
			await new Promise((resolve) => setTimeout(resolve, 0));
			if (stop === "cancel") app.send({ type: "cancel" });
			else app.close();
			const code = await Promise.race([running, new Promise((resolve) => setTimeout(() => resolve("open"), 50))]);
			expect(signal?.aborted).toBe(true);
			if (stop === "cancel") {
				expect(code).toBe(1);
				expect(app.said.at(-1)).toEqual({ type: "error", message: "cancelled" });
			}
			expect(runtime.credentials).toEqual([]);
		}
	});

	it("withdraws a question when the browser answered first", async () => {
		const runtime = new FakeRuntime();
		runtime.flow = async (interaction) => {
			const raced = new AbortController();
			const question = interaction.prompt({
				type: "manual_code",
				message: "Or paste the code",
				signal: raced.signal,
			});
			raced.abort();
			await question.catch(() => {});
		};
		const app = pipe();
		expect(await runAuth(["login", "xai"], { runtime, preferred, extra: [], io: app.io })).toBe(0);
		expect(app.said.map((message) => message.type)).toEqual(["prompt", "prompt_done", "signed_in", "done"]);
		// An answer to a withdrawn question goes nowhere.
		app.send({ type: "answer", value: "late" });
	});

	it("says what went wrong, as a line, with exit code 1", async () => {
		const cases: [string[], string][] = [
			[[], "usage: mu auth status | mu auth login <provider> | mu auth logout <provider>"],
			[["login"], "usage: mu auth status | mu auth login <provider> | mu auth logout <provider>"],
			[["login", "google-gemini-cli"], "This version of mu can't sign in to google-gemini-cli"],
			[["logout", "openrouter"], "This version of mu can't sign in to openrouter"],
			// No longer offered: signed out, never signed in anew.
			[["login", "anthropic"], "This version of mu can't sign in to anthropic"],
			[["login", "openai-codex"], "This version of mu can't sign in to openai-codex"],
		];
		for (const [argv, message] of cases) {
			const app = pipe();
			expect(await runAuth(argv, { runtime: new FakeRuntime(), preferred, extra: [], io: app.io })).toBe(1);
			expect(app.said).toEqual([{ type: "error", message }]);
		}
		const failing = new FakeRuntime();
		failing.flow = async () => {
			throw new Error("Login cancelled");
		};
		const app = pipe();
		expect(await runAuth(["login", "openai"], { runtime: failing, preferred, extra: [], io: app.io })).toBe(1);
		expect(app.said).toEqual([{ type: "error", message: "Login cancelled" }]);
	});

	it("keeps an account's model order when pi starts it on its first model, or knows no starting model", () => {
		const runtime = new FakeRuntime();
		expect(modelsOf(runtime, "anthropic", preferred).map((model) => model.id)).toEqual(["claude-opus-4-8"]);
		expect(modelsOf(runtime, "openai-codex", {}).map((model) => model.id)).toEqual([
			"gpt-5.4",
			"gpt-5.5",
			"gpt-5.5-mini",
		]);
	});

	it("answers the same subcommands the launcher sends it, and finds its starting models in pi's own index", () => {
		expect(LAUNCHER_COMMANDS).toEqual(AUTH_COMMANDS);
		// mu auth --help names them before pi's own auth commands.
		for (const command of AUTH_COMMANDS) expect(AUTH_USAGE).toContain(`mu auth ${command}`);
		// The npm package runs `mu auth` on pi's bundle, whose index must carry both.
		expect(typeof pi.ModelRuntime.create).toBe("function");
		expect(pi.defaultModelPerProvider["openai-codex"]).toEqual(expect.any(String));
	});
});

describe("how mu auth ends", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
	});
	const agentDir = () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-auth-exit-"));
		dirs.push(dir);
		return dir;
	};

	// QA on macOS, 2026-09-25: the desktop started two `mu auth` runs 0.7 s apart. The first exited with
	// models-store.json.lock still there, the second waited on it until the app killed it, and a conversation
	// started in the next 30 s found no model.
	it("does not leave the model catalogue locked while pi's background refresh is still at work", async () => {
		const dir = agentDir();
		const lock = join(dir, "models-store.json.lock");
		const extra = [geminiCliProvider(), antigravityProvider()];
		// pi's own store locks the file around each read. This one keeps the lock until the test lets go, for the
		// catalogues only pi's background refresh reads: the one `mu auth` waits for reads mu's own providers alone.
		let letGo = () => {};
		const released = new Promise<void>((resolve) => {
			letGo = resolve;
		});
		let holders = 0;
		const modelsStore: ModelsStore = {
			read: async (providerId) => {
				if (extra.some((provider) => provider.id === providerId)) return undefined;
				if (holders++ === 0) mkdirSync(lock);
				try {
					await released;
				} finally {
					if (--holders === 0) rmdirSync(lock);
				}
				return undefined;
			},
			write: async () => {},
			delete: async () => {},
		};
		const runtime = await pi.ModelRuntime.create({
			authPath: join(dir, "auth.json"),
			modelsPath: null,
			modelsStore,
			refreshOnCreate: false,
		});
		const app = pipe();
		const code = await runAuth(["status"], { runtime, preferred, extra, io: app.io });
		expect(app.said).toEqual([expect.objectContaining({ type: "status" })]);
		// The answer is out, and registering mu's own sign-ins has pi refreshing every catalogue, which nobody waits
		// for: an exit right here left the lock behind.
		expect(existsSync(lock)).toBe(true);
		setTimeout(letGo, 100);
		const exits: { code: number; locked: boolean }[] = [];
		await exitWhenUnlocked(code, [join(dir, "auth.json"), join(dir, "models-store.json")], (exitCode) =>
			exits.push({ code: exitCode, locked: existsSync(lock) }),
		);
		expect(exits).toEqual([{ code: 0, locked: false }]);
	});

	it("never holds one lock while it waits for the other, and leaves another process's lock alone", async () => {
		const dir = agentDir();
		// Another mu is inside the model catalogue, and stays there.
		const held = join(dir, "models-store.json.lock");
		mkdirSync(held);
		const seen: boolean[] = [];
		const looking = setInterval(() => seen.push(existsSync(join(dir, "auth.json.lock"))), 5);
		const exits: number[] = [];
		try {
			await exitWhenUnlocked(
				1,
				[join(dir, "auth.json"), join(dir, "models-store.json")],
				(code) => exits.push(code),
				{
					limitMs: 100,
					pollMs: 10,
				},
			);
		} finally {
			clearInterval(looking);
		}
		expect(exits).toEqual([1]);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((locked) => !locked)).toBe(true);
		expect(existsSync(held)).toBe(true);
		expect(existsSync(join(dir, "auth.json.lock"))).toBe(false);
	});

	it("exits at once when nothing is locked, or when there is no agent folder yet", async () => {
		const exits: number[] = [];
		const dir = agentDir();
		await exitWhenUnlocked(0, [join(dir, "auth.json"), join(dir, "models-store.json")], (code) => exits.push(code));
		await exitWhenUnlocked(2, [join(dir, "missing", "auth.json")], (code) => exits.push(code), { limitMs: 60_000 });
		expect(exits).toEqual([0, 2]);
		expect(existsSync(join(dir, "auth.json.lock"))).toBe(false);
		expect(existsSync(join(dir, "missing"))).toBe(false);
	});
});

describe("how a session of mu ends", () => {
	const dirs: string[] = [];
	const releases: (() => void)[] = [];
	afterEach(() => {
		while (releases.length > 0) releases.pop()?.();
		while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
	});
	const stores = () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-quit-"));
		dirs.push(dir);
		return { dir, files: [join(dir, "auth.json"), join(dir, "models-store.json")] };
	};

	it("takes pi's lock folders once none is held, and keeps them until the process exits", async () => {
		const { dir, files } = stores();
		// This process's own catalogue refresh is inside the model store, and leaves it 50 ms later.
		const busy = join(dir, "models-store.json.lock");
		mkdirSync(busy);
		setTimeout(() => rmdirSync(busy), 50);
		const release = await holdLocksUntilExit(files, { pollMs: 5 });
		expect(release).toBeTypeOf("function");
		if (release) releases.push(release);
		// Held now: whatever of this process wants a lock waits, and cannot be cut off by the exit halfway.
		expect(existsSync(join(dir, "auth.json.lock"))).toBe(true);
		expect(existsSync(busy)).toBe(true);
		release?.();
		expect(existsSync(join(dir, "auth.json.lock"))).toBe(false);
		expect(existsSync(busy)).toBe(false);
	});

	it("takes nothing when another process keeps a lock past the limit, and leaves that lock alone", async () => {
		const { dir, files } = stores();
		const held = join(dir, "auth.json.lock");
		mkdirSync(held);
		expect(await holdLocksUntilExit(files, { limitMs: 60, pollMs: 5 })).toBeUndefined();
		expect(existsSync(held)).toBe(true);
		expect(existsSync(join(dir, "models-store.json.lock"))).toBe(false);
	});

	it("gives the folders back when the process lives on after its session ended", async () => {
		const { dir, files } = stores();
		const release = await holdLocksUntilExit(files, { holdMs: 30 });
		if (release) releases.push(release);
		expect(existsSync(join(dir, "auth.json.lock"))).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(existsSync(join(dir, "auth.json.lock"))).toBe(false);
		expect(existsSync(join(dir, "models-store.json.lock"))).toBe(false);
	});
});
