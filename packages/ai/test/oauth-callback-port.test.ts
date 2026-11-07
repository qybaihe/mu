import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
	answerLoginControl,
	CallbackPortInUseError,
	closeCallbackServer,
	findPortHolder,
	LOGIN_TAKE_OVER_PATH,
	listenOnLoginPort,
	parseLsof,
	parseNetstat,
	parseSs,
	parseTasklist,
} from "../src/auth/oauth/callback-port.ts";

/**
 * Taking a fixed login port over from an earlier sign-in of ours, and leaving any other program on it alone. These
 * run on a free port the system picks; the flows' own tests use the real one (1455).
 */

const HOST = "127.0.0.1";

type Seen = { method: string; path: string };

/** A server on a free port. `handle` answers what it is sent; every request is recorded. */
async function holder(handle: (request: IncomingMessage, response: ServerResponse) => void) {
	const seen: Seen[] = [];
	const server = createServer((incoming, response) => {
		seen.push({ method: incoming.method ?? "", path: incoming.url ?? "" });
		handle(incoming, response);
	});
	await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return { server, seen, port: address.port };
}

/** A sign-in of ours: it answers the probe and lets go when asked. */
async function ourSignIn() {
	const takenOver: string[] = [];
	let server!: Server;
	const held = await holder((incoming, response) => {
		if (
			answerLoginControl(incoming, response, (by) => {
				takenOver.push(by);
				closeCallbackServer(server);
			})
		)
			return;
		response.writeHead(404).end("Not Found");
	});
	server = held.server;
	return { ...held, takenOver };
}

function send(
	port: number,
	method: string,
	path: string,
	headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const outgoing = request({ host: HOST, port, method, path, headers, agent: false }, (incoming) => {
			let body = "";
			incoming.setEncoding("utf8");
			incoming.on("data", (chunk: string) => {
				body += chunk;
			});
			incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body }));
		});
		outgoing.on("error", reject);
		outgoing.end();
	});
}

/** The bare request the Codex CLI's login sends an older login server before it listens itself. */
function codexCancel(port: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, HOST, () => {
			socket.write(`GET /cancel HTTP/1.1\r\nHost: ${HOST}:${port}\r\nConnection: close\r\n\r\n`);
		});
		let answer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			answer += chunk;
		});
		socket.on("end", () => resolve(answer));
		socket.on("error", reject);
	});
}

const listening = (server: Server) => server.listening;

describe.sequential("a fixed login port", () => {
	const servers: Server[] = [];
	afterEach(() => {
		for (const server of servers.splice(0)) closeCallbackServer(server);
	});

	it("is taken over from an earlier sign-in of ours, which is told and closes", async () => {
		const earlier = await ourSignIn();
		servers.push(earlier.server);
		const next = createServer();
		servers.push(next);

		await listenOnLoginPort(next, { port: earlier.port, host: HOST });

		expect(earlier.takenOver).toEqual(["pi"]);
		expect(earlier.seen.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
			"GET /pi-login",
			`POST ${LOGIN_TAKE_OVER_PATH}`,
		]);
		expect(listening(earlier.server)).toBe(false);
		expect(listening(next)).toBe(true);
	});

	it("is left to another program, and the error says which one, with a code an app can read", async () => {
		const other = await holder((_incoming, response) => response.writeHead(404).end("Not Found"));
		servers.push(other.server);
		const next = createServer();
		servers.push(next);

		const error = await listenOnLoginPort(next, { port: other.port, host: HOST, settleMs: 200 }).catch(
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(CallbackPortInUseError);
		const inUse = error as CallbackPortInUseError;
		expect(inUse.code).toBe("port_in_use");
		expect(inUse.port).toBe(other.port);
		// This test process is the other program: the system names it.
		if (process.platform === "darwin") expect(inUse.holder).toMatchObject({ pid: process.pid });
		expect(inUse.holder?.pi).toBeUndefined();
		expect(inUse.message).toContain(`Port ${other.port} is in use by`);
		// Asked who it is, never to let go: it keeps the port.
		expect(other.seen).toEqual([{ method: "GET", path: "/pi-login" }]);
		expect(listening(other.server)).toBe(true);
		expect(listening(next)).toBe(false);
	});

	it("names an older pi or mu sign-in that cannot be asked to let go, and leaves it alone", async () => {
		// What pi's callback servers answered on any other route before they answered the probe.
		const older = await holder((_incoming, response) =>
			response.writeHead(404, { "content-type": "text/html" }).end("<p>Callback route not found.</p>"),
		);
		servers.push(older.server);

		const error = await listenOnLoginPort(createServer(), {
			port: older.port,
			host: HOST,
			settleMs: 200,
			findHolder: async () => ({ pid: 4242, command: "node" }),
		}).catch((caught: unknown) => caught);

		expect(error).toMatchObject({ code: "port_in_use", holder: { pid: 4242, command: "node", pi: true } });
		expect((error as Error).message).toContain(
			"unfinished sign-in in another pi or mu session (node (process 4242))",
		);
		expect(older.seen).toHaveLength(1);
		expect(listening(older.server)).toBe(true);
	});

	it("waits a moment for a sign-in that is just closing", async () => {
		const closing = await holder((_incoming, response) => response.writeHead(404).end());
		setTimeout(() => closeCallbackServer(closing.server), 150);
		const next = createServer();
		servers.push(next);

		await listenOnLoginPort(next, { port: closing.port, host: HOST });

		expect(listening(next)).toBe(true);
	});

	it("stops trying once the sign-in is cancelled", async () => {
		const other = await holder((_incoming, response) => response.writeHead(404).end());
		servers.push(other.server);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);

		await expect(
			listenOnLoginPort(createServer(), { port: other.port, host: HOST, signal: controller.signal }),
		).rejects.toThrow("Login cancelled");
		expect(listening(other.server)).toBe(true);
	});

	it("lets go for the Codex CLI's own cancel, but never for a web page", async () => {
		const ours = await ourSignIn();
		servers.push(ours.server);

		// A page in the browser can send these; the browser marks them, and they are not answered.
		expect((await send(ours.port, "GET", "/cancel", { "sec-fetch-site": "cross-site" })).status).toBe(404);
		expect(
			(
				await send(ours.port, "POST", LOGIN_TAKE_OVER_PATH, {
					"x-pi-login": "take-over",
					origin: "https://example.com",
				})
			).status,
		).toBe(404);
		// A plain form post cannot carry the header.
		expect((await send(ours.port, "POST", LOGIN_TAKE_OVER_PATH)).status).toBe(404);
		expect(ours.takenOver).toEqual([]);
		expect(listening(ours.server)).toBe(true);

		expect(await codexCancel(ours.port)).toMatch(/^HTTP\/1\.1 200/);
		expect(ours.takenOver).toEqual(["codex"]);
		expect(listening(ours.server)).toBe(false);
	});

	it.skipIf(process.platform === "win32")("finds the process listening on a port", async () => {
		const other = await holder((_incoming, response) => response.end());
		servers.push(other.server);
		const found = await findPortHolder(other.port);
		// Wherever lsof or ss can say: this process. Elsewhere nothing is known, which is no failure.
		if (found) expect(found.pid).toBe(process.pid);
		if (process.platform === "darwin") expect(found).toMatchObject({ pid: process.pid, command: expect.any(String) });
	});
});

describe("what the system says about a port", () => {
	it("reads lsof, ss, netstat and tasklist", () => {
		expect(parseLsof("p1234\nccodex\nf9\np99\ncother\n")).toEqual({ pid: 1234, command: "codex" });
		expect(parseLsof("")).toBeUndefined();
		expect(parseSs('LISTEN 0 128 127.0.0.1:1455 0.0.0.0:* users:(("codex",pid=1234,fd=9))\n')).toEqual({
			pid: 1234,
			command: "codex",
		});
		expect(parseSs("")).toBeUndefined();
		const netstat = [
			"Active Connections",
			"  Proto  Local Address          Foreign Address        State           PID",
			"  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1000",
			"  TCP    127.0.0.1:14550        0.0.0.0:0              LISTENING       2000",
			"  TCP    127.0.0.1:1455         127.0.0.1:50000        ESTABLISHED     3000",
			"  TCP    127.0.0.1:1455         0.0.0.0:0              LISTENING       4321",
		].join("\r\n");
		expect(parseNetstat(netstat, 1455)).toBe(4321);
		expect(parseNetstat(netstat, 8080)).toBeUndefined();
		expect(parseTasklist('"codex.exe","4321","Console","1","25,000 K"\r\n')).toBe("codex");
		expect(parseTasklist("INFO: No tasks are running which match the specified criteria.")).toBeUndefined();
	});
});
