import type { AssistantMessage } from "@earendil-works/pi-ai";
import { failOpen, type KyrnRuntime } from "../runtime.ts";

/** The note that gives the model back what a reply the user stopped had said. */
export const INTERRUPTED_MESSAGE = "kyrn.interrupted";

/** How much of a long stopped reply goes back: its beginning, which the user read first, and where it stopped. */
const HEAD_CHARS = 4000;
const TAIL_CHARS = 2000;

/** What a reply showed the user: its text, without its reasoning or its tool calls. */
export function visibleText(message: AssistantMessage): string {
	return message.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n")
		.trim();
}

/** The note for a reply the user stopped after it had said `text`. */
export function interruptedNote(text: string): string {
	const kept =
		text.length > HEAD_CHARS + TAIL_CHARS
			? `${text.slice(0, HEAD_CHARS)}\n[… ${text.length - HEAD_CHARS - TAIL_CHARS} characters …]\n${text.slice(-TAIL_CHARS)}`
			: text;
	return [
		"The user stopped your last reply before it finished. It is not in the conversation above, but the user saw it. What it had said so far:",
		`"""\n${kept}\n"""`,
		"The user's next message may refer to it.",
	].join("\n");
}

/**
 * A reply the user stopped (`features.interrupted`, on by default). pi leaves a stopped reply out of what the model is
 * sent next, whole: its reasoning and half-written tool calls cannot be replayed. So after "stop, and expand your
 * second point" the model has no second point to expand. This gives the model back the reply's text, which the user
 * saw, as a message for the model only, after the stopped reply. Neither its reasoning nor its tool calls go back.
 * mu's own cuts (the watchdog, the mid-stream correction) say what they cut themselves.
 */
export function registerInterrupted(runtime: KyrnRuntime): void {
	const options = runtime.options("interrupted", { enabled: true });
	if (!options.enabled) return;
	const { pi } = runtime;
	pi.on(
		"message_end",
		failOpen((event) => {
			const message = event.message;
			if (message.role !== "assistant" || message.stopReason !== "aborted" || runtime.harnessAbort) return undefined;
			const text = visibleText(message);
			if (!text) return undefined;
			// While the run still streams this waits for the end of the turn, so it lands after the stopped reply.
			pi.sendMessage(
				{
					customType: INTERRUPTED_MESSAGE,
					content: interruptedNote(text),
					display: false,
					details: { chars: text.length },
				},
				{ triggerTurn: false },
			);
			return undefined;
		}),
	);
}
