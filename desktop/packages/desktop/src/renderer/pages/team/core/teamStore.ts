/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The team store: the backend's team tables are the single source of truth
 * (team list, tasks); the WS events `team.taskChanged` / `team.listChanged`
 * only invalidate what changed, exactly like the sidebar list events. Nothing
 * is derived from chat text. Multi-window and reconnects reconcile through
 * `realtime.reconnected` + full refetches, never through local replay state.
 * Consumers: the group conversation's inline task cards, the header search,
 * and — list only — the sidebar's team section and the conversation header's
 * identity (which ask through `useTeamRosterSnapshot` and load no per-team
 * pages until a workbench consumer mounts).
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { ipcBridge } from '@/common';
import type { ITeamMailboxMessage, ITeamTaskItem, TTeam } from '@/common/types/team/teamTypes';
import { ensureTeamDispatchSeeded } from './teamDispatchSeed';

export type TeamWorkbenchSnapshot = {
  teams: readonly TTeam[];
  tasksByTeam: ReadonlyMap<string, readonly ITeamTaskItem[]>;
  /** The newest mailbox messages per team (the group flow interleaves them with identity). */
  mailboxByTeam: ReadonlyMap<string, readonly ITeamMailboxMessage[]>;
  loading: boolean;
  error: string | null;
};

type Listener = () => void;

const listeners = new Set<Listener>();
let teamsState: TTeam[] = [];
let tasksByTeamState = new Map<string, ITeamTaskItem[]>();
let mailboxByTeamState = new Map<string, ITeamMailboxMessage[]>();
let loadingState = false;
let errorState: string | null = null;
let initialized = false;
let snapshotState: TeamWorkbenchSnapshot = buildSnapshot();

function buildSnapshot(): TeamWorkbenchSnapshot {
  return {
    teams: teamsState,
    tasksByTeam: tasksByTeamState,
    mailboxByTeam: mailboxByTeamState,
    loading: loadingState,
    error: errorState,
  };
}

const emitChange = () => {
  snapshotState = buildSnapshot();
  listeners.forEach((listener) => listener());
};

const subscribeStore = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = (): TeamWorkbenchSnapshot => snapshotState;

// --- per-team fetches ---

/** Whether any workbench consumer has subscribed: only then do tasks and mailboxes load. */
let detailsWanted = false;

/** Fetches the details (tasks, mailbox) of every team that has none yet. */
const fetchMissingDetails = (): void => {
  for (const team of teamsState) {
    if (tasksByTeamState.has(team.id)) continue;
    void fetchTasksOf(team.id);
    void fetchMailboxOf(team.id);
  }
};

const fetchTeams = async (): Promise<void> => {
  try {
    const user = await ipcBridge.auth.currentUser.invoke().catch((): undefined => undefined);
    const teams = await ipcBridge.team.list.invoke({ user_id: user?.id ?? '' });
    if (!Array.isArray(teams)) throw new Error('team list is not an array');
    const nextIds = new Set(teams.map((team) => team.id));
    for (const key of Array.from(tasksByTeamState.keys())) if (!nextIds.has(key)) tasksByTeamState.delete(key);
    const knownIds = new Set(teamsState.map((team) => team.id));
    teamsState = teams;
    errorState = null;
    // Every fetched team gets its dispatch rules seeded (fire-and-forget): new
    // teams at their `team.created`/list fetch, old teams backfilled on open.
    for (const team of teams) void ensureTeamDispatchSeeded(team);
    // Teams that just appeared (created elsewhere, another window) get their
    // first page at once instead of waiting for their first change event — but
    // only while a workbench consumer wants details; the sidebar's roster-only
    // section asks for names and members, not per-team pages.
    if (detailsWanted) {
      for (const team of teams) {
        if (knownIds.has(team.id) || tasksByTeamState.has(team.id)) continue;
        void fetchTasksOf(team.id);
        void fetchMailboxOf(team.id);
      }
    }
  } catch (error) {
    errorState = error instanceof Error ? error.message : String(error);
  }
  emitChange();
};

/** How many of a team's newest mailbox messages the group flow interleaves. */
const MAILBOX_PAGE = 100;

const fetchTasksOf = async (teamId: string): Promise<void> => {
  try {
    const tasks = await ipcBridge.team.listTasks.invoke({ team_id: teamId });
    tasksByTeamState = new Map(tasksByTeamState).set(teamId, Array.isArray(tasks) ? tasks : []);
  } catch {
    // A deleted team 404s: the next list refresh prunes it. Keep the old page until then.
    return;
  }
  emitChange();
};

/** The team's newest mailbox messages, oldest first — the member half of the group chat. */
const fetchMailboxOf = async (teamId: string): Promise<void> => {
  try {
    const page = await ipcBridge.team.listActivity.invoke({ team_id: teamId, kind: 'message', limit: MAILBOX_PAGE });
    const messages = (page.items ?? [])
      .filter((item) => item.kind === 'message')
      .map((item) => item.message)
      .reverse();
    mailboxByTeamState = new Map(mailboxByTeamState).set(teamId, messages);
  } catch {
    // Same deal as tasks: a deleted team 404s and the next list refresh prunes it.
    return;
  }
  emitChange();
};

const refreshAllData = async (): Promise<void> => {
  loadingState = true;
  emitChange();
  await fetchTeams();
  if (detailsWanted) await Promise.allSettled(teamsState.map((team) => fetchTasksOf(team.id)));
  loadingState = false;
  emitChange();
};

// --- invalidation: WS events say what changed, never carry the new truth ---

const pendingTeams = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

const invalidateTeam = (teamId: string): void => {
  pendingTeams.add(teamId);
  if (flushTimer !== undefined) return;
  // One burst of task events refetches once: the events are hints, not rows.
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    const teamIds = [...pendingTeams];
    pendingTeams.clear();
    for (const id of teamIds) {
      if (!teamsState.some((team) => team.id === id)) continue;
      void fetchTasksOf(id);
      void fetchMailboxOf(id);
    }
  }, 300);
};

/** A workbench consumer mounted: from now on the list carries its per-team pages. */
const wantDetails = (): void => {
  if (detailsWanted) return;
  detailsWanted = true;
  fetchMissingDetails();
};

const initializeStore = (): void => {
  if (initialized) return;
  initialized = true;
  void fetchTeams();
  ipcBridge.team.listChanged.on((event) => {
    // Structure changes (created/removed/agent churn) go through the team list first.
    void fetchTeams().then(() => {
      if (event.action === 'removed') return;
      const team = teamsState.find((candidate) => candidate.id === event.team_id);
      if (team) invalidateTeam(team.id);
    });
  });
  ipcBridge.team.created.on(() => void fetchTeams());
  ipcBridge.team.removed.on((event) => {
    teamsState = teamsState.filter((team) => team.id !== event.team_id);
    tasksByTeamState.delete(event.team_id);
    mailboxByTeamState.delete(event.team_id);
    emitChange();
  });
  ipcBridge.team.taskChanged.on((event) => invalidateTeam(event.team_id));
  ipcBridge.team.mailboxChanged.on((event) => {
    if (event.change === 'created') invalidateTeam(event.team_id);
  });
  ipcBridge.realtime.reconnected.on(() => void refreshAllData());
};

/**
 * The team snapshot for the group conversation's inline task cards and search.
 * `enabled: false` (a conversation that is not a team's lead chat) subscribes
 * to nothing and fetches nothing — the store wakes only when first needed.
 */
export const useTeamWorkbenchSnapshot = (enabled = true): TeamWorkbenchSnapshot => {
  useEffect(() => {
    if (enabled) {
      initializeStore();
      wantDetails();
    }
  }, [enabled]);
  const subscribe = useCallback((listener: Listener) => (enabled ? subscribeStore(listener) : () => {}), [enabled]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

/**
 * The team list alone, for the sidebar's team section and the conversation
 * header's identity: wakes the store and keeps the list current, but loads
 * no per-team pages (tasks, mailbox) until a workbench consumer mounts.
 */
export const useTeamRosterSnapshot = (): TeamWorkbenchSnapshot => {
  useEffect(() => {
    initializeStore();
  }, []);
  const subscribe = useCallback((listener: Listener) => subscribeStore(listener), []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

/** Manual refresh for retry affordances. */
export const useRefreshTeamWorkbench = (): (() => void) => {
  useEffect(() => {
    initializeStore();
  }, []);
  return useCallback(() => {
    void refreshAllData();
  }, []);
};

/** Refetches the team list alone: what a membership change calls, so the roster
 *  (the header's member strip, the sidebar's rows) moves without waiting for a WS event. */
export const refreshTeamsList = (): void => {
  void fetchTeams();
};

/** Test hook: reset to empty and forget initialization so the next mount re-subscribes. */
export const resetTeamWorkbenchStoreForTest = (): void => {
  initialized = false;
  detailsWanted = false;
  teamsState = [];
  tasksByTeamState = new Map();
  mailboxByTeamState = new Map();
  loadingState = false;
  errorState = null;
  pendingTeams.clear();
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  snapshotState = buildSnapshot();
  listeners.forEach((listener) => listener());
};
