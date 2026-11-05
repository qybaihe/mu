import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * A sub-agent's own session, tied to the parent's tool call that started it. Written in the parent's session when the
 * sub-agent starts, so the link survives a parent that is killed while it runs. A custom entry (`pi.appendEntry`):
 * kept in the session file, never sent to the model. Format: kyrn/docs/features/subagent-sessions.md.
 */
export const SUBAGENT_SESSION_ENTRY = "kyrn.subagent-session";

export interface SubagentSessionEntry {
	/** The parent's `delegate` or `hive` tool call. */
	toolCallId: string;
	kind: "delegate" | "hive";
	/** The sub-agent's name in that call, as `/swarm` and the board show it: a task's title, an investigator's name. */
	name: string;
	/** Absolute path of the sub-agent's session file. */
	session: string;
}

/**
 * Where the sub-agents of one session keep theirs. Not under `sessions/`: no session list shows them, and no total over
 * that folder counts their spend a second time, since it is already in the parent's `kyrn.usage` entries.
 */
export function subagentSessionDir(parentSessionId: string, agentDir: string = getAgentDir()): string {
	return join(agentDir, "subagents", parentSessionId);
}

/** What a session file is named after: letters and digits of any script, so a title in Chinese stays readable. */
const UNSAFE = /[^\p{L}\p{N}._-]+/gu;

/**
 * A new session file for a sub-agent of `parent`, or undefined when the parent keeps no session file (`--no-session`,
 * an in-memory session): then the sub-agent keeps none either. The random part keeps two sub-agents of the same name
 * apart, also when a provider reuses a tool call id: pi would reopen an existing file and carry on its conversation.
 */
export function subagentSessionFile(
	parent: { getSessionFile(): string | undefined; getSessionId(): string },
	name: string,
	agentDir?: string,
	now: Date = new Date(),
): string | undefined {
	if (!parent.getSessionFile()) return undefined;
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	const label = name.replace(UNSAFE, "_").slice(0, 48) || "subagent";
	return join(
		subagentSessionDir(parent.getSessionId(), agentDir),
		`${stamp}_${label}_${randomUUID().slice(0, 8)}.jsonl`,
	);
}
