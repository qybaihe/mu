/**
 * Model spend that no assistant message of this session carries, recorded as a `kyrn.usage` session entry so whoever
 * totals a session's usage (a benchmark adapter, a cost report) can count it. Format: kyrn/docs/features/usage-accounting.md.
 *
 * - `watchdog-cut`: a reply the watchdog cut. The request is aborted and the provider reports no usage for it, so its
 *   reasoning tokens (often 20,000 or more) appear nowhere. Estimated from the reasoning text that had streamed.
 * - `subagent`: a `delegate` or `hive` sub-agent, verifiers included. Children run with `--no-session`, so their
 *   usage is only in the events they stream to the parent.
 *
 * A custom entry (`pi.appendEntry`) is kept in the session file and never sent to the model.
 */
export const USAGE_ENTRY = "kyrn.usage";

export interface UsageEntry {
	source: "watchdog-cut" | "subagent";
	/** "provider/model-id", when known. */
	model?: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** USD at the model's catalog price. Absent when the price is unknown. */
	cost?: number;
	/** Some of the tokens are mu's estimate, not a count a provider reported: `estimatedOutput` of the output. */
	estimated?: true;
	estimatedOutput?: number;
	/** More was spent than is counted here: the sub-agent was stopped, failed or ended early, mid-request perhaps. */
	partial?: true;
	/** watchdog-cut: the reasoning text that had streamed when the reply was cut, and how long it had thought. */
	thoughtChars?: number;
	thinkingMs?: number;
	/** subagent: which tool ran it, its name, role and how it ended. */
	kind?: "delegate" | "hive";
	name?: string;
	role?: string;
	status?: string;
	turns?: number;
}

/**
 * Characters of reasoning text per output token. Measured on Terminal-Bench 2.1 sessions (MiMo v2.6 Pro, 10-22): over
 * 164 replies that were almost only reasoning, the median was 3.54 characters per reported output token (pooled
 * 3.36, p10 2.52, p90 4.19). pi's own token estimate uses 3.5 too. English prose runs nearer 4; code and other
 * scripts lower, so an estimate is good to about ±25% for one reply.
 */
export const REASONING_CHARS_PER_TOKEN = 3.5;

export function estimateReasoningTokens(chars: number): number {
	return chars > 0 ? Math.ceil(chars / REASONING_CHARS_PER_TOKEN) : 0;
}
