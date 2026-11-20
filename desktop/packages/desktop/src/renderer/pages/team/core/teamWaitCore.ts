/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure core of the team wait watcher: folds the team run / slot-work wire into
 * one question — "is this team's run stalled waiting on a teammate?" — and
 * reports only the transitions (stalled / cleared), never the raw ticks.
 *
 * A stall is the certain deadlock shape: the run is alive (accepted/running)
 * yet every slot — the lead included — sits idle with nothing queued, so
 * nobody will move again by itself. The lead-blocked-inside-a-tool shape (lead
 * running while teammates idle) is deliberately NOT a stall: on the wire it is
 * indistinguishable from the lead simply working (backend gap, tracked).
 */

import type {
  ITeamRunEvent,
  ITeamSlotWork,
  ITeamSlotWorkChangedEvent,
  TeamRunStatus,
} from '@/common/types/team/teamTypes';

export type TeamWaitTransition = 'stalled' | 'cleared' | null;

/** The one team's folded wire state the watcher keeps. */
export type TeamWaitState = {
  runId: string | null;
  status: TeamRunStatus | null;
  slotWorkBySlot: ReadonlyMap<string, ITeamSlotWork>;
};

export const emptyTeamWaitState = (): TeamWaitState => ({ runId: null, status: null, slotWorkBySlot: new Map() });

const LIVE_RUN_STATUSES = new Set<TeamRunStatus>(['accepted', 'running']);

/** A slot is truly idle only when nothing is queued behind it either. */
const isSlotTrulyIdle = (work: ITeamSlotWork): boolean =>
  work.state === 'idle' && work.queued_foreground_count === 0 && work.queued_background_count === 0;

/**
 * The stall verdict: a live run whose every known slot is idle with empty
 * queues. An empty slot map is not a verdict — a run with no slot data yet is
 * just a wire that has not spoken, not a deadlock.
 */
export const isWaitingStall = (state: TeamWaitState): boolean => {
  if (!state.runId || !state.status || !LIVE_RUN_STATUSES.has(state.status)) return false;
  if (state.slotWorkBySlot.size === 0) return false;
  for (const work of state.slotWorkBySlot.values()) if (!isSlotTrulyIdle(work)) return false;
  return true;
};

export const foldRunEvent = (
  state: TeamWaitState,
  event: ITeamRunEvent
): { state: TeamWaitState; transition: TeamWaitTransition } => {
  const wasStalled = isWaitingStall(state);
  // A terminal run is not carried forward: the next run's events rebuild it.
  const next: TeamWaitState =
    event.status === 'completed' || event.status === 'cancelled' || event.status === 'failed'
      ? emptyTeamWaitState()
      : {
          runId: event.team_run_id,
          status: event.status,
          slotWorkBySlot: new Map(event.slot_work?.map((work) => [work.slot_id, work] as const) ?? []),
        };
  return transitionOf(wasStalled, next);
};

export const foldSlotWorkChanged = (
  state: TeamWaitState,
  event: ITeamSlotWorkChangedEvent
): { state: TeamWaitState; transition: TeamWaitTransition } => {
  const wasStalled = isWaitingStall(state);
  const slotWorkBySlot = new Map(state.slotWorkBySlot);
  slotWorkBySlot.set(event.slot_work.slot_id, event.slot_work);
  const next: TeamWaitState = { runId: state.runId, status: state.status, slotWorkBySlot };
  return transitionOf(wasStalled, next);
};

const transitionOf = (
  wasStalled: boolean,
  next: TeamWaitState
): { state: TeamWaitState; transition: TeamWaitTransition } => {
  const stalled = isWaitingStall(next);
  if (stalled === wasStalled) return { state: next, transition: null };
  return { state: next, transition: stalled ? 'stalled' : 'cleared' };
};

/** The lead slot of a stall, for the give-up action (interrupt + wake the lead). */
export const findLeadSlot = (state: TeamWaitState): ITeamSlotWork | undefined => {
  for (const work of state.slotWorkBySlot.values()) if (work.role === 'lead') return work;
  return undefined;
};
