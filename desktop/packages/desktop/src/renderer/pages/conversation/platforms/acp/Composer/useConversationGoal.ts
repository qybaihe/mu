import { useEffect, useState } from 'react';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import { GOAL_EVENT, reduceGoalState, type GoalSnapshot } from './goalState';

/** How long to wait before asking for the next page of activity, once it is caught up. */
const IDLE_POLL_MS = 1500;

/** Only the goal travels to the renderer; the main process skips every other event of the page. */
const KINDS = [GOAL_EVENT];

type Listener = (goal: GoalSnapshot | null) => void;

type Watch = {
  goal: GoalSnapshot | null;
  listeners: Set<Listener>;
  stop: () => void;
};

/**
 * One poll per conversation, however many views read it: every reader of the goal shares a single
 * watch, and it stops when the last one goes away.
 */
const watches = new Map<string, Watch>();

function startWatch(conversationId: string): Watch {
  const watch: Watch = { goal: null, listeners: new Set(), stop: () => {} };
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cursor = 0;
  let sessionId = '';

  const publish = (goal: GoalSnapshot | null) => {
    if (goal === watch.goal) return;
    watch.goal = goal;
    for (const listener of watch.listeners) listener(goal);
  };

  const poll = async () => {
    let delay = IDLE_POLL_MS;
    try {
      const page = unwrap(await kyrnBridge.activity.invoke({ conversationId, cursor, sessionId, kinds: KINDS }));
      if (disposed) return;
      // A different session behind the same conversation (a rewind, a reopen) starts over.
      const changed = page.sessionId !== sessionId;
      sessionId = page.sessionId;
      cursor = page.cursor;
      publish(reduceGoalState(changed ? null : watch.goal, page.events));
      if (page.more) delay = 0;
    } catch {
      // The conversation may have no session yet, or the app's backend may be restarting. Neither
      // is worth a message in the send box: the goal line simply stays away and this asks again.
    }
    if (!disposed) timer = setTimeout(() => void poll(), delay);
  };

  watch.stop = () => {
    disposed = true;
    clearTimeout(timer);
  };
  void poll();
  return watch;
}

function subscribe(conversationId: string, listener: Listener): () => void {
  let watch = watches.get(conversationId);
  if (!watch) {
    watch = startWatch(conversationId);
    watches.set(conversationId, watch);
  }
  watch.listeners.add(listener);
  return () => {
    const current = watches.get(conversationId);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size > 0) return;
    current.stop();
    watches.delete(conversationId);
  };
}

/**
 * The goal this conversation is working towards, as the harness last reported it (`goal.state`), or null
 * when there is none. `enabled` false (an agent without `/goal`) reads nothing and polls nothing.
 */
export function useConversationGoal(conversationId: string, enabled: boolean): GoalSnapshot | null {
  const active = enabled && Boolean(conversationId);
  const [goal, setGoal] = useState<GoalSnapshot | null>(() =>
    active ? (watches.get(conversationId)?.goal ?? null) : null
  );

  useEffect(() => {
    if (!active) {
      setGoal(null);
      return undefined;
    }
    setGoal(watches.get(conversationId)?.goal ?? null);
    return subscribe(conversationId, setGoal);
  }, [active, conversationId]);

  return goal;
}
