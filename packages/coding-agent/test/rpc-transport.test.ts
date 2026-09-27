import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { takeOverStdout, writeRawStdout } from "../src/core/output-guard.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import type { RpcTransport } from "../src/modes/rpc/rpc-transport.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: vi.fn(),
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type OutgoingRecord = Record<string, unknown>;

/** A transport over plain function calls, the way an app would wire a message port. */
function memoryTransport() {
	const sent: OutgoingRecord[] = [];
	const state = { started: false, closed: false, flushed: false };
	let deliver: ((json: string) => void) | undefined;
	let ended: (() => void) | undefined;
	const transport: RpcTransport = {
		start() {
			state.started = true;
		},
		write(json) {
			sent.push(JSON.parse(json) as OutgoingRecord);
		},
		drained: async () => {},
		async flush() {
			state.flushed = true;
		},
		listen(onRecord, onEnd) {
			deliver = onRecord;
			ended = onEnd;
			return () => {
				deliver = undefined;
				ended = undefined;
			};
		},
		close() {
			state.closed = true;
		},
	};
	return {
		transport,
		sent,
		state,
		listening: () => deliver !== undefined,
		send: (record: object) => deliver?.(JSON.stringify(record)),
		end: () => ended?.(),
	};
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.restoreAllMocks();
	vi.mocked(writeRawStdout).mockClear();
	vi.mocked(takeOverStdout).mockClear();
});

async function runtimeHost(): Promise<AgentSessionRuntime> {
	const tempDir = join(tmpdir(), `pi-rpc-transport-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	const model = getModel("anthropic", "claude-sonnet-4-5");
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: "Test", tools: [] },
		streamFn: () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: assistantMessage("") });
				stream.push({ type: "done", reason: "stop", message: assistantMessage("done") });
			});
			return stream;
		},
	});
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(await createInMemoryModelRegistry(authStorage)),
		resourceLoader: createTestResourceLoader(),
	});
	cleanups.push(async () => {
		await session.abort().catch(() => {});
		session.dispose();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});
	return {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

describe("RPC mode over a transport of the embedder's", () => {
	it("answers commands and streams a turn over the transport, and leaves stdout alone", async () => {
		const channel = memoryTransport();
		void runRpcMode(await runtimeHost(), channel.transport);
		await vi.waitFor(() => expect(channel.listening()).toBe(true));
		expect(channel.state.started).toBe(true);

		channel.send({ id: "s1", type: "get_state" });
		await vi.waitFor(() =>
			expect(channel.sent).toContainEqual(
				expect.objectContaining({ id: "s1", type: "response", command: "get_state", success: true }),
			),
		);

		channel.send({ id: "p1", type: "prompt", message: "Hello" });
		await vi.waitFor(() => expect(channel.sent.map((record) => record.type)).toContain("agent_settled"));
		const types = channel.sent.map((record) => record.type);
		expect(types.indexOf("agent_start")).toBeGreaterThan(-1);
		expect(types.indexOf("agent_start")).toBeLessThan(types.indexOf("agent_settled"));
		expect(channel.sent).toContainEqual(
			expect.objectContaining({ id: "p1", type: "response", command: "prompt", success: true }),
		);

		// An unknown command is answered on the transport too.
		channel.send({ id: "u1", type: "no_such_command" });
		await vi.waitFor(() =>
			expect(channel.sent).toContainEqual(
				expect.objectContaining({
					id: "u1",
					type: "response",
					success: false,
					error: "Unknown command: no_such_command",
				}),
			),
		);

		expect(takeOverStdout).not.toHaveBeenCalled();
		expect(writeRawStdout).not.toHaveBeenCalled();
	});

	it("shuts down when the other side closes: disposes the runtime, stops listening and flushes", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const host = await runtimeHost();
		const channel = memoryTransport();
		void runRpcMode(host, channel.transport);
		await vi.waitFor(() => expect(channel.listening()).toBe(true));

		channel.end();
		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
		expect(host.dispose).toHaveBeenCalledOnce();
		expect(channel.listening()).toBe(false);
		expect(channel.state).toMatchObject({ closed: true, flushed: true });
		expect(writeRawStdout).not.toHaveBeenCalled();
	});
});
