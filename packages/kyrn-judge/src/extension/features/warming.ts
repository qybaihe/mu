import { cacheWarming, type WarmingOutcome } from "../../decisions/cache-warming.ts";
import { askWithin, clip, failOpen, type KyrnRuntime } from "../runtime.ts";
import { OUTCOME_ENTRY } from "./permissions.ts";

/**
 * When the user came back after a warming verdict: a `kyrn.outcome` entry, joined to the judge's record on `ledgerId`.
 * The verdict was a forecast (the user will be back before the cache expires, or will not), and this is what happened.
 */
export interface Returned {
	readonly kind: "returned";
	readonly ledgerId: string;
	readonly specId: string;
	readonly judged?: WarmingOutcome;
	/** From the verdict to the user's next message. */
	readonly afterMs: number;
}

/**
 * E2: replace pi's fixed continuation probability with a reading of how the last exchange ended.
 *
 * Only while the agent is idle. During a run the user is coming back by definition: a "warm" verdict would repeat
 * pi's own decision, and a "stop" (a message that reads like a sign-off but carries a task) would throw the cache
 * away mid-run. The refresh has a deadline before the cache expires, so a slow judge is not waited for past `waitMs`.
 *
 * The user's next message labels the latest verdict with how long they stayed away (`Returned`).
 */
export function registerWarming(runtime: KyrnRuntime): void {
	const options = runtime.options("warming", { enabled: true, waitMs: 3000 });
	if (!options.enabled) return;
	const { pi } = runtime;
	/** The latest verdict the user has not come back from yet. */
	let asked: { ledgerId: string; judged?: WarmingOutcome; at: number } | undefined;

	pi.on(
		"cache_warming_decision",
		failOpen(async (_event, ctx) => {
			runtime.touch(ctx);
			if (!ctx.isIdle() || !runtime.turn.userMessage) return undefined;
			const input = {
				lastUserMessage: clip(runtime.turn.userMessage, 300),
				lastAssistantMessage: clip(runtime.lastAssistantText.slice(-600), 600),
			};
			const decision = await askWithin(
				(signal) => runtime.engine.decide(cacheWarming, input, { signal }),
				options.waitMs,
			);
			if (decision?.ledgerId && decision.judged !== undefined) {
				asked = { ledgerId: decision.ledgerId, judged: decision.judged, at: Date.now() };
			}
			if (decision?.source !== "judge" || decision.outcome === "default") return undefined;
			return { action: decision.outcome };
		}),
	);

	pi.on(
		"input",
		failOpen((event) => {
			if (event.source === "extension" || event.streamingBehavior || !event.text.trim()) return undefined;
			const verdict = asked;
			asked = undefined;
			if (verdict) {
				pi.appendEntry<Returned>(OUTCOME_ENTRY, {
					kind: "returned",
					ledgerId: verdict.ledgerId,
					specId: cacheWarming.id,
					...(verdict.judged !== undefined ? { judged: verdict.judged } : {}),
					afterMs: Date.now() - verdict.at,
				});
			}
			return undefined;
		}),
	);
}
