/** Presentation events contain observed decisions, never generated explanations of hidden reasoning. */
export interface KyrnPresentationEvent {
	version: 1;
	sequence: number;
	at: number;
	runtimeId: string;
	turnId: number;
	kind:
		| "preflight.pending"
		| "preflight.verdict"
		| "preflight.wait_end"
		| "decision"
		| "progress"
		| "memory.stored"
		| "memory.recalled"
		| "memory.applied"
		| "memory.retired"
		| "memory.merged"
		| "frame.updated"
		| "capability.opened"
		| "inherit.found"
		| "inherit.rule"
		| "mcp.started"
		| "mcp.failed"
		| "mcp.tools_changed"
		| "constraint.blocked"
		| "goal.state"
		| "board.update"
		| "board.note"
		| "board.switched"
		| "board.model_needed"
		| "permissions.mode"
		| "permissions.request"
		| "permissions.resolved"
		| "permissions.approved"
		| "checkpoint.taken"
		| "checkpoint.off"
		| "judge.notice"
		| "rewind.proposed"
		| "rewind.done"
		| "rewind.undone"
		| "ttsr.interrupted"
		| "browser.run"
		| "browser.step"
		| "diagnostics.delivered"
		| "diagnostics.held"
		| "diagnostics.dropped"
		| "background.start"
		| "background.exit"
		| "background.stop"
		| "background.match"
		| "web.fetch"
		| "web.search"
		| "tool.injection"
		| "swarm.worktree.created"
		| "swarm.patch.ready"
		| "swarm.patch.applied"
		| "swarm.worktree.removed"
		| "context.policy"
		| "compaction.plan";
	payload: unknown;
}

/**
 * What a `progress` event is about, for a client that translates: `step` stays
 * the English sentence, `code` says which one it is, `params` what it names.
 */
export type ProgressCode = "frame" | "lessons" | "skills" | "capabilities" | "permission_review" | "goal_check";

export const PRESENTATION_STATUS_KEY = "kyrn.presentation.v1";
export type PresentationListener = (event: KyrnPresentationEvent) => void;
