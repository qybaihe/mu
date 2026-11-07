import { inspect } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Whose failed promises are heard, and where the log goes: this process, or a stand-in in tests. */
export interface RejectionTarget {
	on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
	stderr: { write(text: string): unknown; on(event: "error", listener: () => void): unknown };
}

const logging = new WeakSet<RejectionTarget>();

/**
 * In RPC mode (the desktop app and other clients), a promise that failed with nothing to handle it is logged to stderr
 * and mu goes on. Node would end mu for it, and with mu the conversation and any question the person is answering. The
 * terminal UI has its own crash handling, and print and JSON modes end with their one run anyway. An exception nothing
 * caught still ends mu, as before: its state can no longer be trusted.
 *
 * Every line starts with `[mu] `: the desktop's adapter passes such lines on to the app's log as they come.
 */
export function registerRejectionLog(pi: ExtensionAPI, target: RejectionTarget = process): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "rpc" || logging.has(target)) return;
		logging.add(target);
		// A log line that cannot be written (its reader went away) must not end mu either.
		target.stderr.on("error", () => {});
		target.on("unhandledRejection", (reason) => {
			try {
				target.stderr.write(rejectionReport(reason));
			} catch {
				// Nowhere to log to.
			}
		});
	});
}

/** The log lines for a promise nothing handled: what failed, with its stack, each line marked as mu's. */
export function rejectionReport(reason: unknown): string {
	const described =
		reason instanceof Error
			? (reason.stack ?? `${reason.name}: ${reason.message}`)
			: inspect(reason, { depth: 4, breakLength: Number.POSITIVE_INFINITY });
	return described
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.map(
			(line, index) =>
				`[mu] ${index === 0 ? `a promise failed and nothing handled it; mu keeps running: ${line}` : line}`,
		)
		.join("\n")
		.concat("\n");
}
