/**
 * The fixed loopback port OpenAI's sign-ins come back to (1455). It is registered with OpenAI, so it cannot move,
 * and the Codex CLI and the Codex app listen on it for their own logins too.
 *
 * Problem: a sign-in holds the port until it ends. When a second one starts first (two runs of `mu auth` back to
 * back, a terminal `/login` left open, the Codex CLI's login), the second one cannot listen and used to fail with
 * "Port 1455 is in use". This module makes a sign-in of ours give the port up when another sign-in asks for it, and
 * a new sign-in ask for it:
 *
 *   1. Listen. A sign-in that is just closing frees the port within a moment, so a failed attempt is retried briefly.
 *   2. Ask the holder who it is (`GET /pi-login`). One of ours answers, and is asked to let go
 *      (`POST /pi-login/take-over`); it stops its sign-in and closes its server, and this one listens.
 *   3. Anything else is left alone: the error names it (`lsof`, `ss` or `netstat`), with a stable `code`.
 *
 * The Codex CLI asks an older login server of its own to let go the same way, with `GET /cancel`: a sign-in of ours
 * answers that too, so a Codex login started while one of ours waits takes the port over instead of failing.
 *
 * NOTE: Node-only (node:http, node:child_process). Reached only through the lazily loaded OAuth flow modules.
 */

import { execFile } from "node:child_process";
import { type IncomingMessage, request, type Server, type ServerResponse } from "node:http";

/** Where a sign-in of ours answers who it is. */
export const LOGIN_PROBE_PATH = "/pi-login";
/** Where a sign-in of ours is asked to let go of the port. */
export const LOGIN_TAKE_OVER_PATH = "/pi-login/take-over";
/** The route the Codex CLI's login sends to an older login server on the port before it listens itself. */
const CODEX_CANCEL_PATH = "/cancel";
/** Marks our answers and requests. A browser cannot send it to another origin without a preflight, which fails. */
const MARKER_HEADER = "x-pi-login";
/** What pi's sign-in pages say for an unknown route: an older pi or mu, which answers no probe, holds the port. */
const OLD_PI_NOT_FOUND = "Callback route not found.";

/** How long a new sign-in keeps trying to listen while the holder lets go. */
const SETTLE_MS = 2500;
const RETRY_MS = 100;
const REQUEST_MS = 1000;
const LOOKUP_MS = 2000;

/** The program found listening on the port, as far as the system says. */
export type CallbackPortHolder = {
	pid?: number;
	/** The process name the system reports, e.g. `codex` or `node`. */
	command?: string;
	/** An earlier sign-in of pi or mu that did not hand the port over (an older version, which cannot be asked to). */
	pi?: boolean;
};

function describeHolder(holder: CallbackPortHolder | undefined): string {
	const pid = holder?.pid ? `process ${holder.pid}` : undefined;
	if (holder?.command) return pid ? `${holder.command} (${pid})` : holder.command;
	return pid ?? "another program";
}

/** The callback port is held by a program that is not a sign-in of ours, so it was left alone. */
export class CallbackPortInUseError extends Error {
	readonly code = "port_in_use";
	readonly port: number;
	readonly holder: CallbackPortHolder | undefined;

	constructor(port: number, holder: CallbackPortHolder | undefined) {
		super(
			holder?.pi
				? `Port ${port} is held by an unfinished sign-in in another pi or mu session (${describeHolder(holder)}), which did not hand it over. Finish or cancel that sign-in, then try again.`
				: `Port ${port} is in use by ${describeHolder(holder)}, probably for its own sign-in (the Codex CLI and the Codex app use this port). Finish or cancel that sign-in, then try again.`,
		);
		this.name = "CallbackPortInUseError";
		this.port = port;
		this.holder = holder;
	}
}

/** A sign-in of ours stopped because another sign-in took the port over. */
export class LoginTakenOverError extends Error {
	readonly code = "login_taken_over";

	constructor(port: number, by: "pi" | "codex") {
		super(
			by === "codex"
				? `Sign-in stopped: the Codex CLI started its own sign-in on port ${port}.`
				: `Sign-in stopped: a newer sign-in started and took over port ${port}.`,
		);
		this.name = "LoginTakenOverError";
	}
}

/**
 * Answers the requests another sign-in sends to the one holding the port: who are you, and let go. `takeOver` stops
 * this sign-in; it runs once the answer is sent. Returns false for every other request.
 *
 * Only a program on this machine may ask this one to let go, never a web page: our own request carries a header a
 * browser sends to another origin only after a preflight, which this server refuses, and the Codex CLI's `GET /cancel`
 * is a bare request, unlike any request a browser sends (those carry `Sec-Fetch-*` or `Origin`).
 */
export function answerLoginControl(
	request: IncomingMessage,
	response: ServerResponse,
	takeOver: (by: "pi" | "codex") => void,
): boolean {
	const path = new URL(request.url ?? "/", "http://localhost").pathname;
	const fromBrowser = request.headers.origin !== undefined || request.headers["sec-fetch-site"] !== undefined;
	if (request.method === "GET" && path === LOGIN_PROBE_PATH) {
		response.writeHead(200, {
			"content-type": "application/json",
			"cache-control": "no-store",
			[MARKER_HEADER]: "pi",
		});
		response.end(JSON.stringify({ pi: true, pid: process.pid }));
		return true;
	}
	const ours =
		request.method === "POST" &&
		path === LOGIN_TAKE_OVER_PATH &&
		request.headers[MARKER_HEADER] === "take-over" &&
		!fromBrowser;
	const codex = request.method === "GET" && path === CODEX_CANCEL_PATH && !fromBrowser;
	if (!ours && !codex) return false;
	// Stopped once the answer is out (closing the server first would cut the asker off), or once the asker hung up.
	response.once("close", () => takeOver(ours ? "pi" : "codex"));
	response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
	response.end("Login cancelled");
	return true;
}

/**
 * Stops a callback server for good: no new connections, and none of the idle ones a browser opens ahead of time. A
 * later sign-in in this process starts a new server with a new state; a spare connection still attached to this one
 * would carry that sign-in's callback here, where it fails with a state mismatch.
 */
export function closeCallbackServer(server: Server): void {
	server.close();
	server.closeAllConnections();
}

type Probe = { kind: "none" } | { kind: "pi"; pid?: number } | { kind: "old-pi" } | { kind: "other" };

function localRequest(
	host: string,
	port: number,
	method: "GET" | "POST",
	path: string,
	headers: Record<string, string>,
): Promise<{ status: number; headers: IncomingMessage["headers"]; body: string } | { error: string }> {
	return new Promise((resolve) => {
		const outgoing = request({ host, port, method, path, headers, timeout: REQUEST_MS, agent: false }, (incoming) => {
			let body = "";
			incoming.setEncoding("utf8");
			incoming.on("data", (chunk: string) => {
				if (body.length < 16_384) body += chunk;
			});
			incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body }));
			incoming.on("error", () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body }));
		});
		outgoing.on("timeout", () => outgoing.destroy(new Error("timeout")));
		outgoing.on("error", (error: NodeJS.ErrnoException) => resolve({ error: error.code ?? error.message }));
		outgoing.end();
	});
}

/** Who holds the port: nobody any more, a sign-in of ours, an older one of ours, or another program. */
async function probeHolder(host: string, port: number): Promise<Probe> {
	const answer = await localRequest(host, port, "GET", LOGIN_PROBE_PATH, { [MARKER_HEADER]: "probe" });
	if ("error" in answer) return answer.error === "ECONNREFUSED" ? { kind: "none" } : { kind: "other" };
	if (answer.status === 200 && answer.headers[MARKER_HEADER] === "pi") {
		try {
			const pid = (JSON.parse(answer.body) as { pid?: unknown }).pid;
			return { kind: "pi", pid: typeof pid === "number" ? pid : undefined };
		} catch {
			return { kind: "pi" };
		}
	}
	if (answer.status === 404 && answer.body.includes(OLD_PI_NOT_FOUND)) return { kind: "old-pi" };
	return { kind: "other" };
}

function tryListen(server: Server, port: number, host: string): Promise<NodeJS.ErrnoException | undefined> {
	return new Promise((resolve) => {
		const onError = (error: NodeJS.ErrnoException) => {
			server.off("listening", onListening);
			resolve(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve(undefined);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});
}

function cancelled(): Error {
	return new Error("Login cancelled");
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(cancelled());
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(cancelled());
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export interface ListenOnLoginPortOptions {
	port: number;
	host: string;
	signal?: AbortSignal;
	/** How long to keep trying while a holder lets go. */
	settleMs?: number;
	/** Finds the program holding the port, for the error. Defaults to asking the system. */
	findHolder?: (port: number) => Promise<CallbackPortHolder | undefined>;
}

/**
 * Listens on a fixed login port, taking it over from an earlier sign-in of ours (see the top of this file).
 * Throws {@link CallbackPortInUseError} when another program keeps it, and "Login cancelled" when `signal` aborts.
 */
export async function listenOnLoginPort(server: Server, options: ListenOnLoginPortOptions): Promise<void> {
	const { port, host, signal } = options;
	const settleMs = options.settleMs ?? SETTLE_MS;
	let deadline = Date.now() + settleMs;
	let askedToLetGo = false;
	let probe: Probe | undefined;
	for (;;) {
		if (signal?.aborted) throw cancelled();
		const error = await tryListen(server, port, host);
		if (!error) {
			if (signal?.aborted) {
				closeCallbackServer(server);
				throw cancelled();
			}
			return;
		}
		if (error.code !== "EADDRINUSE") throw error;
		if (!askedToLetGo && probe?.kind !== "other" && probe?.kind !== "old-pi") {
			probe = await probeHolder(host, port);
			if (probe.kind === "pi") {
				await localRequest(host, port, "POST", LOGIN_TAKE_OVER_PATH, { [MARKER_HEADER]: "take-over" });
				askedToLetGo = true;
				deadline = Date.now() + settleMs;
			}
		}
		if (Date.now() >= deadline) break;
		await pause(RETRY_MS, signal);
	}
	const found = await (options.findHolder ?? findPortHolder)(port).catch(() => undefined);
	const holder: CallbackPortHolder = {
		...found,
		pid: found?.pid ?? (probe?.kind === "pi" ? probe.pid : undefined),
		...(probe?.kind === "pi" || probe?.kind === "old-pi" ? { pi: true } : {}),
	};
	throw new CallbackPortInUseError(port, holder.pid || holder.command || holder.pi ? holder : undefined);
}

/** What a command printed; undefined when there is no such command. */
function run(command: string, args: readonly string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(command, args, { timeout: LOOKUP_MS, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
			// lsof exits with 1 when it lists nothing: what it printed is what counts.
			resolve(error && (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : String(stdout ?? ""));
		});
	});
}

/** `lsof -Fpc`: a `p<pid>` line, then a `c<command>` line, per process. */
export function parseLsof(output: string): CallbackPortHolder | undefined {
	let holder: CallbackPortHolder | undefined;
	for (const line of output.split(/\r?\n/)) {
		if (line.startsWith("p")) {
			if (holder) break;
			const pid = Number(line.slice(1));
			holder = Number.isInteger(pid) && pid > 0 ? { pid } : {};
		} else if (line.startsWith("c") && holder) holder.command = line.slice(1);
	}
	return holder;
}

/** `ss -Hltnp`: `users:(("codex",pid=1234,fd=9))`. */
export function parseSs(output: string): CallbackPortHolder | undefined {
	const match = /users:\(\("([^"]*)",pid=(\d+)/.exec(output);
	return match ? { command: match[1], pid: Number(match[2]) } : undefined;
}

/** `netstat -ano -p TCP`: the process id of the line listening on the port. */
export function parseNetstat(output: string, port: number): number | undefined {
	for (const line of output.split(/\r?\n/)) {
		const columns = line.trim().split(/\s+/);
		if (columns.length < 5 || columns[0]?.toUpperCase() !== "TCP") continue;
		if (!columns[1]?.endsWith(`:${port}`) || columns[3]?.toUpperCase() !== "LISTENING") continue;
		const pid = Number(columns[4]);
		if (Number.isInteger(pid) && pid > 0) return pid;
	}
	return undefined;
}

/** `tasklist /FO CSV /NH`: the image name, first column, without `.exe`. */
export function parseTasklist(output: string): string | undefined {
	const match = /^"([^"]+)"/.exec(output.trim());
	return match?.[1]?.replace(/\.exe$/i, "");
}

/** Asks the system which process listens on the port. Undefined wherever that cannot be found out. */
export async function findPortHolder(port: number): Promise<CallbackPortHolder | undefined> {
	if (process.platform === "win32") {
		const pid = parseNetstat((await run("netstat", ["-ano", "-p", "TCP"])) ?? "", port);
		if (!pid) return undefined;
		const command = parseTasklist((await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"])) ?? "");
		return command ? { pid, command } : { pid };
	}
	// An app started from the Finder may have no /usr/sbin on its PATH.
	for (const lsof of ["lsof", "/usr/sbin/lsof", "/usr/bin/lsof"]) {
		const output = await run(lsof, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
		if (output !== undefined) return parseLsof(output);
	}
	if (process.platform === "linux") return parseSs((await run("ss", ["-Hltnp", `sport = :${port}`])) ?? "");
	return undefined;
}
