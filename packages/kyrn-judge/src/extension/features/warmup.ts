import { isIP } from "node:net";
import type { KyrnConfig } from "../../config.ts";
import { clmEndpoint } from "../../providers/typesafe.ts";
import { resolveJudgeConfig } from "../../registry.ts";
import { classifyAddress } from "../../web/ssrf.ts";
import type { KyrnRuntime } from "../runtime.ts";
import { isUnattended } from "./unattended.ts";

/**
 * True for an address on this machine or the local network (loopback, 10/8, 172.16/12, 192.168/16, link-local,
 * `localhost`, `*.local`, Docker's `host.docker.internal`): a new connection there costs about a millisecond.
 * 100.64/10 is private too, but it is a carrier's NAT or a mesh VPN (Tailscale), which can cross an ocean.
 */
export function isNearby(url: string | undefined): boolean {
	if (!url || !URL.canParse(url)) return false;
	const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
	if (host === "host.docker.internal") return true;
	if (isIP(host) === 0) return false;
	const kind = classifyAddress(host);
	return kind === "loopback" || kind === "link-local" || (kind === "private" && !host.startsWith("100."));
}

/** Where the first judge is reached, when its configuration says (a hosted route by name says nothing). */
function judgeAddress(config: KyrnConfig): string | undefined {
	const judge = resolveJudgeConfig(config.tiers[0] ?? "", config);
	return judge?.type === "clm" ? clmEndpoint(judge.baseUrl) : judge?.baseUrl;
}

/**
 * Keeps the connection to the judge warm while the session is in use.
 *
 * The first question of a turn is the one that waits for a connection, and
 * from a long route that is most of its time: measured 2026-09-23 from the
 * user's network, the questions asked before a turn take 1.7 s cold (HTTP/2)
 * or 3.9 s (HTTP/1.1) and 0.3-0.5 s warm, and the server drops a connection
 * idle for about 90 s. So while something happened in the last `idleMs`, one
 * trivial question goes out when the judge has been asked nothing for
 * `intervalMs`: 281 input tokens each, well under a cent an hour. A real
 * question keeps the connection warm as well as a probe does, so a session
 * that asks the judge often sends few or none. Not counted as a decision:
 * `/status` counts probes apart.
 *
 * None for a judge on this machine or the local network (`nearby`), where a
 * new connection costs nothing worth saving and a probe would only queue in
 * front of real questions. None in an unattended run (`mu --print`, json mode;
 * `unattended`): it saves at most a tenth of a second on a short route there,
 * and costs about 19 requests a run.
 */
export function registerWarmup(runtime: KyrnRuntime): void {
	const options = runtime.options("warmup", {
		enabled: true,
		intervalMs: 50_000,
		idleMs: 900_000,
		/** Keep a judge on this machine or the local network warm too. */
		nearby: false,
		/** Keep the judge warm in a `mu --print` or json run too. */
		unattended: false,
	});
	if (!options.enabled) return;
	if (!options.nearby && isNearby(judgeAddress(runtime.config))) return;
	const { engine } = runtime;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let probing: AbortController | undefined;
	const stop = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		// A probe still on its way must not keep a finished run (`mu --print`) alive until the judge's own timeout.
		probing?.abort();
		probing = undefined;
	};
	const wait = (ms: number) => {
		timer = setTimeout(tick, ms);
		// A timer must never keep a finished process alive: a sub-agent ends when its work does.
		timer.unref?.();
	};
	const tick = () => {
		const quiet = Date.now() - engine.lastUsedAt;
		// Used less than an interval ago, by a real question or another probe: warm until an interval after that.
		if (quiet < options.intervalMs) {
			wait(options.intervalMs - quiet);
			return;
		}
		// No judge to keep warm when none is asked (`mu setup --judge off`).
		if (!probing && Date.now() - runtime.lastActivityAt <= options.idleMs && engine.asksJudge()) {
			const controller = new AbortController();
			probing = controller;
			void engine.probe(controller.signal).finally(() => {
				if (probing === controller) probing = undefined;
			});
		}
		wait(options.intervalMs);
	};
	runtime.pi.on("session_start", (_event, ctx) => {
		stop();
		if (!options.unattended && isUnattended(ctx)) return;
		wait(options.intervalMs);
	});
	runtime.pi.on("session_shutdown", stop);
}
