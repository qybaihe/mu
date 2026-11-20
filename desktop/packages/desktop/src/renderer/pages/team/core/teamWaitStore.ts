/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The team wait watcher's wire layer: listens to the team run / slot-work WS
 * events, folds them through the pure core (`teamWaitCore.ts`) and broadcasts
 * only the stall transitions. One verdict feeds the system notification, so
 * every presentation of a stall agrees. On startup every known team's
 * run-state is read once as the baseline, so a stall that predates this window
 * still surfaces.
 */
import { ipcBridge } from '@/common';
import type { ITeamRunEvent, ITeamSlotWorkChangedEvent, TTeam } from '@/common/types/team/teamTypes';
import { foldRunEvent, foldSlotWorkChanged, emptyTeamWaitState, type TeamWaitState } from './teamWaitCore';

export type TeamWaitEvent =
  | { type: 'stalled'; teamId: string; runId: string; leadConversationId: string; leadSlotId: string }
  | { type: 'cleared'; teamId: string; runId: string; leadConversationId?: string };

/** The lead conversation and slot of a team, for stall events' click targets. */
type TeamDirectory = { leadConversationId: string; leadSlotId: string };

type Listener = (event: TeamWaitEvent) => void;

const listeners = new Set<Listener>();
const waitStates = new Map<string, TeamWaitState>();
const directories = new Map<string, TeamDirectory>();
let initialized = false;

const emit = (event: TeamWaitEvent): void => {
  listeners.forEach((listener) => listener(event));
};

const broadcastTransition = (teamId: string, transition: 'stalled' | 'cleared', runId: string): void => {
  const state = waitStates.get(teamId);
  const directory = directories.get(teamId);
  if (!state || !directory) return; // No lead to point at: not actionable, stay silent.
  if (transition === 'cleared') {
    emit({ type: 'cleared', teamId, runId, leadConversationId: directory.leadConversationId });
    return;
  }
  emit({
    type: 'stalled',
    teamId,
    runId,
    leadConversationId: directory.leadConversationId,
    leadSlotId: directory.leadSlotId,
  });
};

const onRunEvent = (event: ITeamRunEvent): void => {
  const current = waitStates.get(event.team_id) ?? emptyTeamWaitState();
  const { state, transition } = foldRunEvent(current, event);
  waitStates.set(event.team_id, state);
  if (transition) broadcastTransition(event.team_id, transition, event.team_run_id);
};

const onSlotWorkChanged = (event: ITeamSlotWorkChangedEvent): void => {
  const current = waitStates.get(event.team_id) ?? emptyTeamWaitState();
  const { state, transition } = foldSlotWorkChanged(current, event);
  waitStates.set(event.team_id, state);
  if (transition && state.runId) broadcastTransition(event.team_id, transition, state.runId);
};

const indexDirectory = (team: TTeam): void => {
  const lead = team.assistants?.find((assistant) => assistant.role === 'leader');
  if (!lead) {
    directories.delete(team.id);
    return;
  }
  directories.set(team.id, { leadConversationId: lead.conversation_id, leadSlotId: lead.slot_id });
};

const refreshDirectories = (): void => {
  void ipcBridge.auth.currentUser
    .invoke()
    .catch((): undefined => undefined)
    .then((user) => ipcBridge.team.list.invoke({ user_id: user?.id ?? '' }))
    .then((teams) => {
      const known = new Set<string>();
      for (const team of teams ?? []) {
        known.add(team.id);
        indexDirectory(team);
      }
      for (const teamId of directories.keys()) if (!known.has(teamId)) directories.delete(teamId);
    })
    .catch(() => {
      // The next listChanged event refreshes the directories.
    });
};

/** One team's current run state as the baseline; only a live run matters. */
const seedBaseline = (teamId: string): void => {
  void ipcBridge.team.getRunState
    .invoke({ team_id: teamId })
    .then((response) => {
      const run = response?.active_run;
      if (!run) return;
      onRunEvent(run);
    })
    .catch(() => {
      // A team that cannot answer has no baseline; live events take over.
    });
};

const initializeWaitWatcher = (): void => {
  if (initialized) return;
  initialized = true;
  refreshDirectories();
  void ipcBridge.auth.currentUser
    .invoke()
    .catch((): undefined => undefined)
    .then((user) => ipcBridge.team.list.invoke({ user_id: user?.id ?? '' }))
    .then((teams) => {
      for (const team of teams ?? []) seedBaseline(team.id);
    })
    .catch(() => {
      // Baselines are best-effort; live events take over.
    });
  ipcBridge.team.runAccepted.on(onRunEvent);
  ipcBridge.team.runStarted.on(onRunEvent);
  ipcBridge.team.runUpdated.on(onRunEvent);
  ipcBridge.team.runCompleted.on(onRunEvent);
  ipcBridge.team.runCancelled.on(onRunEvent);
  ipcBridge.team.runFailed.on(onRunEvent);
  ipcBridge.team.slotWorkChanged.on(onSlotWorkChanged);
  ipcBridge.team.listChanged.on(refreshDirectories);
  ipcBridge.team.created.on(refreshDirectories);
  ipcBridge.team.removed.on((event) => {
    directories.delete(event.team_id);
    waitStates.delete(event.team_id);
  });
  ipcBridge.realtime.reconnected.on(() => {
    // The wire replayed nothing: rebuild the baseline from the authoritative reads.
    refreshDirectories();
    waitStates.clear();
    void (async () => {
      try {
        const user = await ipcBridge.auth.currentUser.invoke().catch((): undefined => undefined);
        const teams = await ipcBridge.team.list.invoke({ user_id: user?.id ?? '' });
        for (const team of teams ?? []) seedBaseline(team.id);
      } catch {
        // Baselines are best-effort; live events take over.
      }
    })();
  });
};

/** Stall transitions for the notification hook. */
export const subscribeTeamWait = (listener: Listener): (() => void) => {
  initializeWaitWatcher();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Test hook: forget everything so the next subscribe re-initializes clean. */
export const resetTeamWaitWatcherForTest = (): void => {
  initialized = false;
  waitStates.clear();
  directories.clear();
  listeners.clear();
};
