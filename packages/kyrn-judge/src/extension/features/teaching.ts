import type { AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { turnTeaching, type TeachingKind } from "../../decisions/teaching.ts";
import { turnDigest } from "../../memory/phrasing.ts";
import { clip, failOpen, type KyrnRuntime, textOf } from "../runtime.ts";
import { describeCall } from "./admission.ts";

const WRITER_TIMEOUT_MS = 20_000;
const MAX_KEPT_STEPS = 20;
const HEAD_KEPT_STEPS = 6;

export const TEACHING_PROMPT = `You turn one judged moment of a coding session into a two-line teaching card for the person who watched it happen.
Input: what the user asked, what the agent did step by step, how the answer ended, and the kind of moment it was judged to be.
Answer with strict JSON only, no markdown, no words around it:
{"why": "...", "ruledOut": ["...", "..."], "kind": "..."}
- why: at most 120 characters, the reason behind the choice, said to the person, not to the model.
- ruledOut: one or two options that were considered and rejected, each at most 60 characters.
- kind: the kind string from the input, unchanged.`;

/** The card the writer phrased, as presented. */
export interface TeachingCard {
	readonly kind: TeachingKind;
	readonly why: string;
	readonly ruledOut: readonly string[];
}

/** The writer's card, or undefined when it did not answer in shape (then no card shows). */
export function parseTeachingCard(reply: string, kind: TeachingKind): TeachingCard | undefined {
	const start = reply.indexOf("{");
	const end = reply.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		const parsed = JSON.parse(reply.slice(start, end + 1)) as { why?: unknown; ruledOut?: unknown; kind?: unknown };
		if (typeof parsed.why !== "string" || !parsed.why.trim()) return undefined;
		if (parsed.kind !== undefined && parsed.kind !== kind) return undefined;
		const ruledOut = Array.isArray(parsed.ruledOut)
			? parsed.ruledOut.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 2)
			: [];
		return { kind, why: clip(parsed.why.trim(), 200), ruledOut };
	} catch {
		return undefined;
	}
}

/**
 * The teaching card of a turn (`turn.teaching`): when a turn hinged on a product trade-off, an
 * architectural weighing or a counterintuitive pitfall, the writer model phrases why the answer went
 * the way it went, and the card is presented to the person — the model is never given it. Asked once
 * per completed turn, in the background; a `routine` verdict, a missing writer or a writer that does
 * not answer in shape shows nothing anywhere. Ships in shadow: the card is recorded (ledger and
 * presentation), and the presentation says `shadow`, so no client shows it as part of the reply.
 */
export function registerTeaching(runtime: KyrnRuntime): void {
	const options = runtime.options("teaching", { enabled: true });
	if (!options.enabled) return;
	const pi = runtime.pi;
	let turnOf = -1;
	let steps: string[] = [];
	let dropped = 0;

	pi.on(
		"tool_result",
		failOpen((event) => {
			if (turnOf !== runtime.userTurns) {
				turnOf = runtime.userTurns;
				steps = [];
				dropped = 0;
			}
			const toolName = "toolName" in event ? String(event.toolName) : "tool";
			const input = (event.input ?? {}) as Record<string, unknown>;
			steps.push(`${describeCall(toolName, input)} -> ${event.isError ? "error" : "ok"}`);
			if (steps.length > MAX_KEPT_STEPS) {
				steps.splice(HEAD_KEPT_STEPS, 1);
				dropped++;
			}
			return undefined;
		}),
	);

	pi.on(
		"agent_end",
		failOpen<AgentEndEvent, undefined>((event: AgentEndEvent, ctx: ExtensionContext) => {
			runtime.touch(ctx);
			if (turnOf !== runtime.userTurns) {
				turnOf = runtime.userTurns;
				steps = [];
				dropped = 0;
			}
			const last = [...event.messages].reverse().find((message) => message.role === "assistant") as
				| { content?: unknown; stopReason?: string }
				| undefined;
			// Cut short by the user or by an error: nothing to teach about how it ended.
			if (!last || last.stopReason === "aborted" || last.stopReason === "error") return undefined;
			const finalMessage = textOf(last.content);
			const digest = turnDigest({ request: runtime.turn.userMessage, steps, dropped, finalMessage });
			steps = [];
			dropped = 0;
			const active = runtime.mode(turnTeaching.id) === "active";
			void runtime.engine
				.decide(turnTeaching, { turnDigest: digest })
				.then(async (decision) => {
					// `judged` carries the verdict in shadow mode too, where the outcome stays the fallback: the whole
					// chain runs and is presented (as `shadow`) before the point is turned on.
					const verdict = decision.judged ?? decision.outcome;
					if (verdict === "routine") return;
					const card = await phrase(verdict, digest);
					if (!card) return;
					// `shadow` is what a client reads to keep the card out of the reply's history.
					runtime.present("turn.teaching", { ...card, state: active ? "applied" : "shadow" });
				})
				.catch(() => {});
			return undefined;
		}),
	);

	/** The writer phrases the card. Without one, nothing shows: quiet first. */
	const phrase = async (kind: TeachingKind, digest: string): Promise<TeachingCard | undefined> => {
		const writer = runtime.writer();
		if (!writer) return undefined;
		try {
			const reply = await writer({
				system: TEACHING_PROMPT,
				user: `The moment was judged to be: ${kind}\n\nWhat happened, oldest first:\n${digest}`,
				signal: AbortSignal.timeout(WRITER_TIMEOUT_MS),
			});
			return parseTeachingCard(reply.text, kind);
		} catch {
			return undefined;
		}
	};
}
