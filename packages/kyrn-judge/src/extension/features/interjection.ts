import type { InputEvent } from "@earendil-works/pi-coding-agent";
import { inputInterjection } from "../../decisions/interjection.ts";
import { clip, failOpen, type KyrnRuntime, within } from "../runtime.ts";

type Delivery = "steer" | "followUp";

/**
 * A8: mu decides when a message typed mid-run reaches the work. pi delivers it the way it was sent: a steer (Enter in
 * the terminal) reaches the model at its next step, a follow-up (Alt+Enter) after the run. When the judge reads it
 * differently (a correction queued for later, extra work or an unrelated question about to break into the run), the
 * message is re-sent the other way.
 *
 * Active by default. The judge has `waitMs` to answer. With no verdict in time, a judge that failed, no judge, or a
 * run that ended meanwhile, the message goes as sent. Mid-run messages reach the run in the order they were sent,
 * however long each verdict takes. In shadow the verdict is only recorded, and the message goes on its way at once.
 */
export function registerInterjection(runtime: KyrnRuntime): void {
	const options = runtime.options("interjection", { enabled: true, waitMs: 1500 });
	if (!options.enabled) return;
	const { pi } = runtime;
	// Settles once the mid-run message sent before is on its way.
	let previous: Promise<void> = Promise.resolve();

	/** The way to re-send a mid-run message when the judge reads it otherwise than it was sent; else undefined. */
	const otherWay = async (event: InputEvent, sent: Delivery): Promise<Delivery | undefined> => {
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
		if (decision.outcome === "keep" || decision.outcome === sent) return undefined;
		return decision.outcome;
	};

	pi.on(
		"input",
		failOpen(async (event, ctx) => {
			runtime.touch(ctx);
			const sent = event.streamingBehavior;
			if (event.source === "extension" || !sent || !event.text.trim()) return undefined;
			const earlier = previous;
			let release = () => {};
			previous = new Promise<void>((resolve) => {
				// A tick later: a message re-sent here takes a few more steps to reach pi's queue than one let through.
				release = () => setTimeout(resolve, 0);
			});
			try {
				const other = await otherWay(event, sent).catch(() => undefined);
				await earlier;
				// A run that ended meanwhile is started by the message as it was sent: the queue it was meant for is gone.
				if (!other || ctx.isIdle()) return undefined;
				// As pi would have read it: a prompt template or a skill (`/name …`) is expanded.
				pi.sendUserMessage(event.text, { deliverAs: other, expandPromptTemplates: true });
				return { action: "handled" as const };
			} finally {
				release();
			}
		}),
	);
}
