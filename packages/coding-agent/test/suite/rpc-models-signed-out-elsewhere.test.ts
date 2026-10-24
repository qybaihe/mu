import { createAssistantMessageEventStream, type OAuthCredential, type Provider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "./harness.ts";

// mu: the desktop app signs a subscription out with `mu auth logout`, another process. A session already running in
// RPC mode (a conversation of the app) kept listing that subscription's models until it restarted.

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];
type Response = { id?: string; type: string; command?: string; success?: boolean; data?: unknown; error?: string };

type ListenerSnapshot = { stdinEnd: NodeListener[]; signals: Map<NodeJS.Signals, NodeListener[]> };

function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) process.stdin.off("end", listener);
	}
	for (const [signal, before] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!before.includes(listener)) process.off(signal, listener);
		}
	}
}

function createRuntimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

let sent = 0;
/** Sends one command and waits for its response. */
async function send(command: Record<string, unknown>): Promise<Response> {
	const id = `c${++sent}`;
	rpcIo.lineHandler?.(JSON.stringify({ ...command, id }));
	let response: Response | undefined;
	await vi.waitFor(() => {
		response = rpcIo.outputLines
			.flatMap((line) => line.split("\n"))
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as Response)
			.find((record) => record.type === "response" && record.id === id);
		expect(response).toBeDefined();
	});
	return response as Response;
}

const listed = (response: Response): string[] =>
	((response.data as { models: { provider: string; id: string }[] }).models ?? []).map(
		(model) => `${model.provider}/${model.id}`,
	);

const SIGNED_IN: OAuthCredential = {
	type: "oauth",
	access: "access",
	refresh: "refresh",
	expires: Date.now() + 3_600_000,
};

/** A subscription: usable while its OAuth credential is in the store, as ChatGPT's or Grok's sign-in. */
function subscription(harness: Harness): Provider {
	const model = { ...harness.getModel(), provider: "account", id: "plus", name: "Plus" };
	return {
		id: "account",
		name: "Account",
		auth: {
			oauth: {
				name: "Account",
				isSubscription: true,
				login: async () => SIGNED_IN,
				refresh: async (credential) => credential,
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
		getModels: () => [model],
		stream: () => createAssistantMessageEventStream(),
		streamSimple: () => createAssistantMessageEventStream(),
	};
}

describe("RPC mode after a sign-in or sign-out in another process", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	test("lists and switches to only the models whose credentials are still stored", async () => {
		const listeners = takeListenerSnapshot();
		const harness = await createHarness();
		try {
			const runtime = harness.session.modelRuntime;
			await harness.authStorage.modify("account", async () => SIGNED_IN);
			runtime.registerNativeProvider(subscription(harness));
			await runtime.refresh({ allowNetwork: false });
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
			const faux = `${harness.getModel().provider}/${harness.getModel().id}`;
			expect(listed(await send({ type: "get_available_models" }))).toEqual(
				expect.arrayContaining([faux, "account/plus"]),
			);

			// `mu auth logout account` in another process: the credential is gone, and this runtime was not told.
			await harness.authStorage.delete("account");
			const after = listed(await send({ type: "get_available_models" }));
			expect(after).toContain(faux);
			expect(after).not.toContain("account/plus");
			expect(await send({ type: "set_model", provider: "account", modelId: "plus" })).toMatchObject({
				success: false,
				error: "Model not found: account/plus",
			});

			// A sign-in elsewhere counts at once too.
			await harness.authStorage.modify("account", async () => SIGNED_IN);
			expect(listed(await send({ type: "get_available_models" }))).toContain("account/plus");
			expect(await send({ type: "set_model", provider: "account", modelId: "plus" })).toMatchObject({
				success: true,
			});
			expect(harness.session.model?.provider).toBe("account");
		} finally {
			harness.cleanup();
			restoreListeners(listeners);
		}
	});
});
