import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.ts";
import { defineDecision } from "../src/decision.ts";
import { isNearby, registerWarmup } from "../src/extension/features/warmup.ts";
import { KyrnRuntime } from "../src/extension/runtime.ts";
import { Judge } from "../src/judge.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

/** Just enough of pi to register handlers and fire events. */
function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		appendEntry: () => {},
		getCommands: () => [],
	} as unknown as ExtensionAPI;
	const emit = async (event: string, ctx: Partial<ExtensionContext> = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx as ExtensionContext);
	};
	return { pi, emit };
}

/** A runtime with warm-up registered, and the judge's provider: what reached the judge. */
function warmed(config: Record<string, unknown> = {}, responder?: MockResponder) {
	const { pi, emit } = fakePi();
	const provider = new MockJudgeProvider(responder);
	const runtime = new KyrnRuntime(pi, parseConfig(config), new Judge({ provider }));
	registerWarmup(runtime);
	const pings = () => provider.calls.filter((call) => "ready" in call.questions).length;
	return { runtime, provider, emit, pings };
}

const question = defineDecision({
	id: "test.question",
	version: 1,
	questions: { ok: { type: "boolean", instructions: "Is it ok?" } },
	cacheImpact: "none",
	latency: "inline",
	buildState: () => ({ text: "state" }),
	policy: () => true,
	fallback: () => false,
});

describe("judge warm-up", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("asks one trivial question every interval while the session is in use, and stops when it goes quiet or ends", async () => {
		vi.useFakeTimers();
		const { pi, emit } = fakePi();
		const provider = new MockJudgeProvider();
		const runtime = new KyrnRuntime(pi, parseConfig({}), new Judge({ provider }));
		registerWarmup(runtime);
		await emit("session_start");

		await vi.advanceTimersByTimeAsync(50_000);
		expect(provider.calls).toHaveLength(1);
		// A ping, not a decision: nothing counted, nothing recorded.
		expect(Object.keys(provider.calls[0].questions)).toEqual(["ready"]);
		expect(runtime.engine.stats.calls).toBe(0);
		expect(runtime.memory.records).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(50_000);
		expect(provider.calls).toHaveLength(2);

		// Quiet for longer than the idle limit: the connection is left to go cold.
		runtime.lastActivityAt = Date.now() - 900_001;
		await vi.advanceTimersByTimeAsync(100_000);
		expect(provider.calls).toHaveLength(2);

		// Any event reaching a feature is activity.
		runtime.touch({} as ExtensionContext);
		await vi.advanceTimersByTimeAsync(50_000);
		expect(provider.calls).toHaveLength(3);

		await emit("session_shutdown");
		await vi.advanceTimersByTimeAsync(200_000);
		expect(provider.calls).toHaveLength(3);
		// Counted apart from the decisions, for /status.
		expect(runtime.engine.stats.probes).toBe(3);
	});

	it("sends nothing in an unattended run (mu --print, json mode) unless told to, and keeps warm in a terminal or the app", async () => {
		vi.useFakeTimers();
		for (const [mode, unattended, expected] of [
			["print", false, 0],
			["json", false, 0],
			["tui", false, 2],
			["rpc", false, 2],
			["print", true, 2],
		] as const) {
			const { emit, pings } = warmed({ features: { warmup: { unattended } } });
			await emit("session_start", { mode });
			await vi.advanceTimersByTimeAsync(100_000);
			expect(pings(), `${mode}, unattended: ${unattended}`).toBe(expected);
			await emit("session_shutdown");
		}
	});

	it("sends no probe while real questions keep the connection warm, and one once the judge has been quiet for an interval", async () => {
		vi.useFakeTimers();
		const { runtime, emit, pings } = warmed();
		await emit("session_start", { mode: "tui" });
		// A real question every 30 s: the connection never sits idle for 50 s.
		for (let step = 0; step < 5; step++) {
			await vi.advanceTimersByTimeAsync(30_000);
			await runtime.engine.decide(question, {});
		}
		expect(pings()).toBe(0);
		// The last question was asked at 150 s: quiet from then on, the next probe goes out 50 s later.
		await vi.advanceTimersByTimeAsync(49_000);
		expect(pings()).toBe(0);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(pings()).toBe(1);
		await vi.advanceTimersByTimeAsync(50_000);
		expect(pings()).toBe(2);
		await emit("session_shutdown");
	});

	it("sends nothing to a judge on this machine or the local network, unless told to", async () => {
		vi.useFakeTimers();
		const judges = {
			mude: { type: "typesafe", baseUrl: "http://host.docker.internal:8642/v1/systemone" },
			lan: { type: "http", baseUrl: "http://192.168.1.20:8080" },
			clm: { type: "clm" },
			far: { type: "typesafe", baseUrl: "https://relay.example.com/v1/systemone" },
		};
		for (const [tier, nearby, expected] of [
			["mude", false, 0],
			["lan", false, 0],
			// clm-serve listens on 127.0.0.1 unless told otherwise.
			["clm", false, 0],
			["mude", true, 1],
			["far", false, 1],
		] as const) {
			const { emit, pings } = warmed({ tiers: [tier], judges, features: { warmup: { nearby } } });
			await emit("session_start", { mode: "tui" });
			await vi.advanceTimersByTimeAsync(50_000);
			expect(pings(), `${tier}, nearby: ${nearby}`).toBe(expected);
			await emit("session_shutdown");
		}
	});

	it("tells near addresses from far ones", () => {
		for (const url of [
			"http://127.0.0.1:8700",
			"http://localhost:8080/v1",
			"http://[::1]:9000",
			"http://10.0.0.5",
			"http://172.20.1.1",
			"http://192.168.0.10:47823",
			"http://169.254.10.1",
			"http://host.docker.internal:8642",
			"http://judge.local",
		]) {
			expect(isNearby(url), url).toBe(true);
		}
		// A Tailscale address, the public internet, and no address at all.
		for (const url of [
			"http://100.92.253.2:8080",
			"https://api.typesafe.ai/v1",
			"https://8.8.8.8",
			"",
			undefined,
			"nope",
		]) {
			expect(isNearby(url), String(url)).toBe(false);
		}
	});

	it("cancels a probe still on its way when the session ends, so it holds up no exit", async () => {
		vi.useFakeTimers();
		const signals: AbortSignal[] = [];
		const { emit, pings } = warmed({}, (request) => {
			if (!("ready" in request.questions) || !request.signal) return {};
			const signal = request.signal;
			signals.push(signal);
			// A judge that does not answer: only the abort ends the call.
			return new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("aborted")));
			});
		});
		await emit("session_start", { mode: "tui" });
		await vi.advanceTimersByTimeAsync(50_000);
		expect(pings()).toBe(1);
		expect(signals[0].aborted).toBe(false);
		await emit("session_shutdown");
		expect(signals[0].aborted).toBe(true);
	});

	it("does nothing for a judge on this machine: there is no connection worth keeping warm", async () => {
		vi.useFakeTimers();
		const { pi, emit } = fakePi();
		const provider = new MockJudgeProvider();
		const runtime = new KyrnRuntime(pi, parseConfig({ tiers: ["clm"] }), new Judge({ provider }));
		registerWarmup(runtime);
		await emit("session_start");
		await vi.advanceTimersByTimeAsync(200_000);
		expect(provider.calls).toHaveLength(0);
	});
});
