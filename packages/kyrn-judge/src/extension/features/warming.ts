import { cacheWarming } from "../../decisions/cache-warming.ts";
import { askWithin, clip, failOpen, type KyrnRuntime } from "../runtime.ts";

/**
 * E2: replace pi's fixed continuation probability with a reading of how the last exchange ended.
 *
 * Only while the agent is idle. During a run the user is coming back by definition: a "warm" verdict would repeat
 * pi's own decision, and a "stop" (a message that reads like a sign-off but carries a task) would throw the cache
 * away mid-run. The refresh has a deadline before the cache expires, so a slow judge is not waited for past `waitMs`.
 */
export function registerWarming(runtime: KyrnRuntime): void {
	const options = runtime.options("warming", { enabled: true, waitMs: 3000 });
	if (!options.enabled) return;

	runtime.pi.on(
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
			if (decision?.source !== "judge" || decision.outcome === "default") return undefined;
			return { action: decision.outcome };
		}),
	);
}
