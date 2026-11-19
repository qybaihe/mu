/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Framework-free core for team-run notifications: turns `team.runCompleted` /
 * `team.runFailed` wire events into notification payloads. Kept free of React /
 * DOM globals so it is unit-testable in the node project. The waiting-stall
 * notification is NOT decided here — it comes from the shared wait watcher
 * (`teamWaitStore.ts`), so the attention row and the notification can never
 * disagree (one verdict, two presentations).
 */

import type { ITeamRunEvent } from '@/common/types/team/teamTypes';

export type TeamRunNotificationKind = 'runCompleted' | 'runFailed';

export type TeamRunNotification = {
  kind: TeamRunNotificationKind;
  teamId: string;
  runId: string;
  /** The slot the run names; the wire layer resolves it to a conversation. */
  slotId?: string;
};

export type TeamRunNotificationDeps = {
  /** Show (or drop) one notification; the main process still gates on focus and settings. */
  notify: (notification: TeamRunNotification) => void;
};

export const createTeamRunNotificationController = (deps: TeamRunNotificationDeps) => {
  // One notification per run per kind, best-effort per controller lifetime:
  // a reconnect replay of the same terminal event must not re-nag.
  const notifiedRunKeys = new Set<string>();

  const onRunEvent = (event: ITeamRunEvent, channel: 'completed' | 'failed'): void => {
    if (!event?.team_id || !event.team_run_id) return;
    // Only the lead's run completing means "the team answered you": a teammate
    // target is an intermediate step inside the run, not a finish line.
    if (channel === 'completed' && event.target_role !== 'lead') return;
    const key = `${channel}:${event.team_run_id}`;
    if (notifiedRunKeys.has(key)) return;
    notifiedRunKeys.add(key);
    deps.notify({
      kind: channel === 'completed' ? 'runCompleted' : 'runFailed',
      teamId: event.team_id,
      runId: event.team_run_id,
      slotId: event.target_slot_id,
    });
  };

  return {
    onRunCompleted: (event: ITeamRunEvent) => onRunEvent(event, 'completed'),
    onRunFailed: (event: ITeamRunEvent) => onRunEvent(event, 'failed'),
  };
};
