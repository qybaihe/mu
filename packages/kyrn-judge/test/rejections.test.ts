import { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { type RejectionTarget, registerRejectionLog, rejectionReport } from "../src/extension/rejections.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

/** Just enough of pi to register handlers and start a session in a given mode. */
function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	const start = async (mode: ExtensionContext["mode"]) => {
		for (const handler of handlers.get("session_start") ?? [])
			await handler({ type: "session_start" }, { mode } as ExtensionContext);
	};
	return { pi, start };
}

/** A stand-in for the process: its failed promises, and what it writes to stderr. */
function fakeProcess(write: (text: string) => void = () => {}) {
	const stderr = Object.assign(new EventEmitter(), { write });
	return Object.assign(new EventEmitter(), { stderr }) as EventEmitter & RejectionTarget & { stderr: EventEmitter };
}

describe("a promise nothing handled, in RPC mode", () => {
	it("is logged to stderr, marked as mu's line by line, and mu goes on", async () => {
		const written: string[] = [];
		const target = fakeProcess((text) => written.push(text));
		const { pi, start } = fakePi();
		registerRejectionLog(pi, target);
		await start("rpc");
		// A second session in the same process (a new conversation, a switch) adds nothing.
		await start("rpc");
		expect(target.listenerCount("unhandledRejection")).toBe(1);
		expect(target.stderr.listenerCount("error")).toBe(1);

		const error = new Error("the board could not be written");
		error.stack = "Error: the board could not be written\n    at write (board.ts:1:1)\n    at look (board.ts:2:2)";
		target.emit("unhandledRejection", error);
		expect(written).toEqual([
			"[mu] a promise failed and nothing handled it; mu keeps running: Error: the board could not be written\n" +
				"[mu]     at write (board.ts:1:1)\n" +
				"[mu]     at look (board.ts:2:2)\n",
		]);
		// A stderr that fails is not a reason to end mu either.
		expect(() => target.stderr.emit("error", new Error("write EPIPE"))).not.toThrow();
	});

	it("is left to Node in the other modes", async () => {
		for (const mode of ["tui", "print", "json"] as const) {
			const target = fakeProcess();
			const { pi, start } = fakePi();
			registerRejectionLog(pi, target);
			await start(mode);
			expect(target.listenerCount("unhandledRejection"), mode).toBe(0);
		}
	});

	it("keeps going when the log cannot be written", async () => {
		const target = fakeProcess(() => {
			throw new Error("EPIPE");
		});
		const { pi, start } = fakePi();
		registerRejectionLog(pi, target);
		await start("rpc");
		expect(() => target.emit("unhandledRejection", new Error("x"))).not.toThrow();
	});

	it("describes what is not an error, too", () => {
		expect(rejectionReport({ code: "EPIPE" })).toBe(
			"[mu] a promise failed and nothing handled it; mu keeps running: { code: 'EPIPE' }\n",
		);
		expect(rejectionReport(undefined)).toBe(
			"[mu] a promise failed and nothing handled it; mu keeps running: undefined\n",
		);
		const bare = new Error("no stack");
		bare.stack = undefined;
		expect(rejectionReport(bare)).toBe(
			"[mu] a promise failed and nothing handled it; mu keeps running: Error: no stack\n",
		);
	});
});
