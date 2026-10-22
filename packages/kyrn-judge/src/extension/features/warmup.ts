import type { KyrnRuntime } from "../runtime.ts";

/**
 * Keeps the connection to the judge warm while the session is in use.
 *
 * The first question of a turn is the one that waits for a connection, and
 * from a long route that is most of its time: measured 2026-09-23 from the
 * user's network, the questions asked before a turn take 1.7 s cold (HTTP/2)
 * or 3.9 s (HTTP/1.1) and 0.3-0.5 s warm, and the server drops a connection
 * idle for about 90 s. So while something happened in the last `idleMs`, one
 * trivial question goes out every `intervalMs`: 281 input tokens each, well
 * under a cent an hour. Not needed for a local sidecar, and not counted as a
 * decision.
 */
export function registerWarmup(runtime: KyrnRuntime): void {
	const options = runtime.options("warmup", { enabled: true, intervalMs: 50_000, idleMs: 900_000 });
	if (!options.enabled || !runtime.judgeParallel) return;
	let timer: ReturnType<typeof setInterval> | undefined;
	const stop = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};
	runtime.pi.on("session_start", () => {
		stop();
		timer = setInterval(() => {
			if (Date.now() - runtime.lastActivityAt > options.idleMs || !runtime.engine.asksJudge()) return;
			void runtime.engine.probe();
		}, options.intervalMs);
		// A timer must never keep a finished process alive: a sub-agent ends when its work does.
		timer.unref?.();
	});
	runtime.pi.on("session_shutdown", stop);
}
