import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DecisionEngine, defineDecision } from "../src/decision.ts";
import { Judge } from "../src/judge.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { threeZone } from "../src/policy.ts";
import { GatewayJudgeProvider } from "../src/providers/gateway.ts";
import { HttpJudgeProvider } from "../src/providers/http-judge.ts";
import { LogprobJudgeProvider } from "../src/providers/logprob.ts";
import { OpenAIDecisionsJudgeProvider } from "../src/providers/openai-decisions.ts";
import { TypeSafeJudgeProvider } from "../src/providers/typesafe.ts";
import type { JudgeProvider } from "../src/types.ts";

/**
 * Every way a hosted judge can fail, against every judge mu reaches over HTTP: a real server on this machine that
 * misbehaves on cue, and the real fetch. Whatever goes wrong, the decision takes its fallback and the ledger says why
 * (`error:<kind>`), so a judge that is down never changes what mu does, and the reason can be counted.
 */
type Fault =
	| "refused"
	| "reset"
	| "stall"
	| "cut"
	| "not json"
	| "no answers"
	| "rate limited"
	| "server error"
	| "no key"
	| "too long";

const FAULTS: Record<Fault, string> = {
	refused: "error:unreachable",
	reset: "error:unreachable",
	stall: "error:timeout",
	cut: "error:invalid_response",
	"not json": "error:invalid_response",
	"no answers": "error:invalid_response",
	"rate limited": "error:rate_limited",
	"server error": "error:server",
	"no key": "error:auth",
	"too long": "error:bad_request",
};

let server: Server;
let base = "";
let closedBase = "";
const sockets = new Set<Socket>();

/** The fault is the first part of the path, so one server serves them all. */
function misbehave(fault: Fault, respond: (status: number, body: string) => void, socket: Socket): void {
	const json = (status: number, body: unknown) => respond(status, JSON.stringify(body));
	switch (fault) {
		case "reset":
			socket.destroy();
			return;
		case "stall":
			return;
		case "cut":
			socket.write(
				'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 400\r\n\r\n{"answers": {"q',
			);
			socket.destroy();
			return;
		case "not json":
			respond(200, "<html>502 Bad Gateway</html>");
			return;
		case "no answers":
			json(200, { usage: {} });
			return;
		case "rate limited":
			json(429, { error: { message: "Rate limit reached" } });
			return;
		case "server error":
			json(500, { error: { message: "internal error" } });
			return;
		case "no key":
			json(401, { error: { message: "Invalid API key" } });
			return;
		case "too long":
			json(400, { error: { message: "This model's maximum context length is 8192 tokens" } });
			return;
		case "refused":
			return;
	}
}

beforeAll(async () => {
	server = createServer((request, response) => {
		const fault = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname.split("/")[1] ?? "") as Fault;
		request.resume();
		request.on("end", () =>
			misbehave(
				fault,
				(status, body) => {
					response.writeHead(status, { "Content-Type": "application/json" });
					response.end(body);
				},
				request.socket,
			),
		);
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	// A port nothing listens on: one that was free a moment ago.
	const closed = createServer();
	await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
	closedBase = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
	await new Promise<void>((resolve) => closed.close(() => resolve()));
});

afterAll(async () => {
	for (const socket of sockets) socket.destroy();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

const PROVIDERS: Record<string, (url: string) => JudgeProvider> = {
	"http judge": (url) => new HttpJudgeProvider({ baseUrl: url }),
	"AI Gateway": (url) => new GatewayJudgeProvider({ apiKey: "test-key", baseUrl: url }),
	"System One (TypeSafe, CLM)": (url) => new TypeSafeJudgeProvider({ apiKey: "test-key", baseUrl: url }),
	"OpenAI Decisions": (url) => new OpenAIDecisionsJudgeProvider({ apiKey: "test-key", baseUrl: url }),
	"log-probability judge": (url) =>
		new LogprobJudgeProvider({ baseUrl: url, model: "m", apiKey: async () => "test-key", keyName: "KEY" }),
};

const spec = defineDecision({
	id: "test.faults",
	version: 1,
	questions: { refund: { type: "boolean", instructions: "Does the customer ask for a refund?" } },
	cacheImpact: "none",
	latency: "inline",
	buildState: (message: string) => ({ message }),
	policy: (answers) => threeZone(answers.refund),
	fallback: () => "unsure" as const,
});

describe("a judge that fails", () => {
	for (const [name, make] of Object.entries(PROVIDERS)) {
		it(`${name}: every fault takes the fallback, with the reason in the ledger`, async () => {
			const seen: Record<string, string | undefined> = {};
			const outcomes = new Set<string>();
			for (const fault of Object.keys(FAULTS) as Fault[]) {
				const ledger = new MemoryLedger();
				const url = fault === "refused" ? closedBase : `${base}/${encodeURIComponent(fault)}`;
				const engine = new DecisionEngine({
					judge: new Judge({ provider: make(url), timeoutMs: 400 }),
					ledger,
					defaultMode: "active",
				});
				const decision = await engine.decide(spec, "I was charged twice");
				outcomes.add(String(decision.outcome));
				seen[fault] = ledger.records[0]?.reason;
				expect(ledger.records[0]?.source, fault).toBe("fallback");
			}
			expect(seen).toEqual(FAULTS);
			expect([...outcomes]).toEqual(["unsure"]);
		}, 30_000);
	}
});
