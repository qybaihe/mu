import type { Activity } from '@/common/kyrn/types';

/** The harness's own goal states, as `goal.state` reports them. */
export type GoalStatus = 'active' | 'paused' | 'met' | 'cleared';

/** The goal of a conversation, as the line above the send box needs it. */
export type GoalSnapshot = {
  status: GoalStatus;
  /** The condition, in the person's own words. */
  text: string;
};

/**
 * mu's command. A goal is one long command the person types: `/goal <condition>` sets it and mu works until the
 * condition holds; `/goal clear` ends it. The send box never writes the first one for them.
 */
export const GOAL_COMMAND_NAME = 'goal';
export const GOAL_CLEAR_COMMAND = `/${GOAL_COMMAND_NAME} clear`;

/** The presentation event the harness sends each time the goal changes, with the whole state. */
export const GOAL_EVENT = 'goal.state';
const STATUSES: ReadonlySet<string> = new Set(['active', 'paused', 'met', 'cleared']);

/**
 * Whether the agent behind the send box runs goals: only mu offers `/goal`. Another agent has no goal to show, so the
 * send box neither reads one nor offers to end one.
 */
export function offersGoal(commands: readonly { name: string }[]): boolean {
  return commands.some((command) => command.name === GOAL_COMMAND_NAME);
}

/** One `goal.state` payload, or null when it says nothing usable. */
function readGoalEvent(payload: Record<string, unknown>): GoalSnapshot | null {
  const { status, text } = payload;
  if (typeof status !== 'string' || !STATUSES.has(status)) return null;
  if (typeof text !== 'string' || !text.trim()) return null;
  return { status: status as GoalStatus, text };
}

/**
 * The goal after this page of activity. The harness sends the whole state every time it
 * changes, so the last `goal.state` in the page wins and a page with none changes nothing.
 */
export function reduceGoalState(previous: GoalSnapshot | null, events: readonly Activity[]): GoalSnapshot | null {
  let goal = previous;
  for (const event of events) {
    if (event.kind !== GOAL_EVENT) continue;
    const next = readGoalEvent(event.payload);
    if (next) goal = next;
  }
  return goal;
}

/**
 * Whether the conversation still carries a goal. A paused goal counts: the harness picks it
 * up again on the next message, so the person should still see it and be able to end it.
 */
export function goalIsLive(goal: GoalSnapshot | null): boolean {
  return goal !== null && (goal.status === 'active' || goal.status === 'paused');
}
