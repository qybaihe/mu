/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The slot-work wire for the monitor: every team's per-slot work state, kept
 * as one index the monitor page and the sidebar entry read together. Live WS
 * events (`team.run*` carrying `slot_work`, `team.slotWorkChanged` carrying
 * one slot verbatim) update single slots in place; startup and reconnects
 * rebuild the baseline from `team.getRunState` reads, so a run that predates
 * this window still shows. Pure derivation of what a slot's state means for
 * a card lives in `monitorCore`; this file is IO only.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { ipcBridge } from '@/common';
import type { ITeamRunEvent, ITeamSlotWork, ITeamSlotWorkChangedEvent } from '@/common/types/team/teamTypes';
import type { SlotWorkIndex } from './monitorCore';

type Listener = () => void;

const listeners = new Set<Listener>();
let workByTeam = new Map<string, Map<string, ITeamSlotWork>>();
let initialized = false;
let snapshot: SlotWorkIndex = workByTeam;

const emitChange = (): void => {
  snapshot = workByTeam;
  listeners.forEach((listener) => listener());
};

const mergeSlotWork = (teamId: string, incoming: readonly ITeamSlotWork[]): void => {
  const next = new Map(workByTeam.get(teamId) ?? []);
  for (const work of incoming) next.set(work.slot_id, work);
  workByTeam = new Map(workByTeam).set(teamId, next);
  emitChange();
};

const onRunEvent = (event: ITeamRunEvent): void => {
  if (!event.slot_work?.length) return;
  mergeSlotWork(event.team_id, event.slot_work);
};

const onSlotWorkChanged = (event: ITeamSlotWorkChangedEvent): void => {
  mergeSlotWork(event.team_id, [event.slot_work]);
};

const teamIdsKnown = (): Set<string> => new Set(workByTeam.keys());

const seedBaselineOf = (teamId: string): void => {
  void ipcBridge.team.getRunState
    .invoke({ team_id: teamId })
    .then((state) => {
      const slotWork = state?.slot_work ?? state?.active_run?.slot_work;
      if (slotWork?.length) mergeSlotWork(teamId, slotWork);
    })
    .catch(() => {
      // A team that cannot answer has no baseline; live events take over.
    });
};

const seedBaselines = (): void => {
  void (async () => {
    try {
      const user = await ipcBridge.auth.currentUser.invoke().catch((): undefined => undefined);
      const teams = await ipcBridge.team.list.invoke({ user_id: user?.id ?? '' });
      for (const team of teams ?? []) {
        // A team already heard on the wire needs no baseline; a fresh id does.
        if (teamIdsKnown().has(team.id)) continue;
        seedBaselineOf(team.id);
      }
    } catch {
      // Baselines are best-effort; live events take over.
    }
  })();
};

const forgetTeam = (teamId: string): void => {
  if (!teamIdsKnown().has(teamId)) return;
  const next = new Map(workByTeam);
  next.delete(teamId);
  workByTeam = next;
  emitChange();
};

const initializeSlotWorkStore = (): void => {
  if (initialized) return;
  initialized = true;
  seedBaselines();
  ipcBridge.team.runAccepted.on(onRunEvent);
  ipcBridge.team.runStarted.on(onRunEvent);
  ipcBridge.team.runUpdated.on(onRunEvent);
  ipcBridge.team.runCompleted.on(onRunEvent);
  ipcBridge.team.runCancelled.on(onRunEvent);
  ipcBridge.team.runFailed.on(onRunEvent);
  ipcBridge.team.slotWorkChanged.on(onSlotWorkChanged);
  ipcBridge.team.created.on(() => void seedBaselines());
  ipcBridge.team.listChanged.on(() => void seedBaselines());
  ipcBridge.team.removed.on((event) => forgetTeam(event.team_id));
  ipcBridge.realtime.reconnected.on(() => {
    // The wire replayed nothing: rebuild the baseline from the authoritative reads.
    workByTeam = new Map();
    emitChange();
    seedBaselines();
  });
};

/**
 * The live slot-work index. Mounts wake the wire; every consumer then sees
 * the same per-slot truth (a team's card and the sidebar's badge agree).
 */
export const useSlotWorkIndex = (): SlotWorkIndex => {
  useEffect(() => {
    initializeSlotWorkStore();
  }, []);
  return useSyncExternalStore(
    (listener: Listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => snapshot,
    () => snapshot
  );
};

/** Test hook: forget everything so the next mount re-initializes clean. */
export const resetSlotWorkStoreForTest = (): void => {
  initialized = false;
  workByTeam = new Map();
  snapshot = workByTeam;
  listeners.clear();
};
