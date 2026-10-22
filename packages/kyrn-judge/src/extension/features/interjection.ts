import { inputInterjection } from "../../decisions/interjection.ts";
import { clip, failOpen, type KyrnRuntime, within } from "../runtime.ts";

/**
 * A8: a message typed mid-run is delivered by which key was pressed. When the
 * judge reads it differently (a correction queued for later, an unrelated
 * question about to derail the run), the message is re-sent the other way.
 *
 * In shadow (the default) the verdict is only recorded, and the message goes
 * on its way at once instead of after the wait.
 */
export function registerInterjection(runtime: KyrnRuntime): void {
	const options = runtime.options("interjection", { enabled: true, waitMs: 1500 });
	if (!options.enabled) return;
	const { pi } = runtime;

	pi.on(
		"input",
		failOpen(async (event, ctx) => {
			runtime.touch(ctx);
			if (event.source === "extension" || !event.streamingBehavior || !event.text.trim()) return undefined;
			if (event.images?.length) return undefined;
			const goal = runtime.taskFrame()?.goal;
			if (!goal) return undefined;

			const input = {
				userMessage: clip(event.text, 400),
				goal,
				currentAction: clip(runtime.lastAssistantText, 300),
			};
			if (runtime.mode(inputInterjection.id) !== "active") {
				void runtime.engine.decide(inputInterjection, input).catch(() => {});
				return undefined;
			}
			const decision = await within(runtime.engine.decide(inputInterjection, input), options.waitMs);
			if (!decision || decision.source !== "judge") return undefined;
			if (decision.outcome === "keep" || decision.outcome === event.streamingBehavior) return undefined;
			pi.sendUserMessage(event.text, { deliverAs: decision.outcome });
			return { action: "handled" as const };
		}),
	);
}
