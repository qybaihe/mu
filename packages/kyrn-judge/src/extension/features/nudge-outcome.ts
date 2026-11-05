import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import type { Decision } from "../../decision.ts";
import type { JsonValue } from "../../types.ts";
import { failOpen, type KyrnRuntime, type TurnState } from "../runtime.ts";
import { OUTCOME_ENTRY } from "./permissions.ts";

/**
 * What the agent did with a nudge a verdict sent it (`turn.continue`, `turn.completion`): the run that answered it called
 * tools, or it ended again without one. Kept as a `kyrn.outcome` entry beside the user's answers, joined to the judge's
 * record on `ledgerId`: a nudge answered with "The work is already complete" and no call is a verdict that sent the agent
 * back for nothing, the label `mu ledger` and calibration read it as.
 */
export interface NudgeFollowed {
	readonly kind: "followed";
	readonly ledgerId: string;
	readonly specId: string;
	readonly judged?: JsonValue;
	/** `acted`: the answering run called at least one tool. `ended`: it stopped again without one. */
	readonly followed: "acted" | "ended";
	/** The tool calls the answering run made. */
	readonly calls: number;
}

interface Pending {
	readonly decision: Decision<JsonValue>;
	readonly turn: TurnState;
	/** The run whose end was sent back: the next run to end answers it. */
	readonly nudged: AgentEndEvent;
}

const callsIn = (event: AgentEndEvent): number =>
	event.messages.reduce(
		(sum, message) =>
			sum +
			(message.role === "assistant" && Array.isArray(message.content)
				? message.content.filter((part) => (part as { type?: unknown } | null)?.type === "toolCall").length
				: 0),
		0,
	);

/**
 * Records what became of each judged nudge. `sent` is called by the feature that sent one, with the verdict and the end
 * it sent back. A nudge the user overtook with a message of their own, or one no judge decided, gets no record.
 */
export function registerNudgeOutcomes(runtime: KyrnRuntime): {
	sent: (decision: Decision<JsonValue>, nudged: AgentEndEvent) => void;
} {
	const { pi } = runtime;
	let pending: Pending | undefined;
	pi.on(
		"agent_end",
		failOpen<AgentEndEvent, undefined>((event) => {
			const was = pending;
			if (!was || event === was.nudged) return undefined;
			pending = undefined;
			if (runtime.turn !== was.turn || !was.decision.ledgerId) return undefined;
			const calls = callsIn(event);
			pi.appendEntry<NudgeFollowed>(OUTCOME_ENTRY, {
				kind: "followed",
				ledgerId: was.decision.ledgerId,
				specId: was.decision.specId,
				...(was.decision.judged !== undefined ? { judged: was.decision.judged } : {}),
				followed: calls > 0 ? "acted" : "ended",
				calls,
			});
			return undefined;
		}),
	);
	return {
		sent: (decision, nudged) => {
			if (decision.source === "judge") pending = { decision, turn: runtime.turn, nudged };
		},
	};
}
