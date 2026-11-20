/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The monitor's one data assembly: the position wall and the team wall from
 * the app's own live stores — the conversation list (session running and
 * waiting states), the team store (list, and tasks when a details consumer
 * asks), the shared TEAMS.md index (lifecycle) and the slot-work wire. The
 * sidebar entry mounts it without tasks (`withTasks: false`): the badge
 * counts working states, which never need task pages. The page mounts it
 * with tasks for the progress bars. Everything is IO wiring; the card
 * shapes are `monitorCore`'s.
 */
import { useEffect, useMemo, useState } from 'react';
import { supervisorBridge } from '@/common/chat/team/supervisor/supervisorBridge';
import type { SupervisorTeam } from '@/common/chat/team/supervisor/supervisorCore';
import {
  useConversationActivitySets,
  useConversationListSync,
} from '@renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';
import { useTeamRosterSnapshot, useTeamWorkbenchSnapshot } from '@renderer/pages/team/core/teamStore';
import { teamRosterEntries } from '@renderer/pages/team/core/teamIdentity';
import { usePositionRoster } from '@renderer/pages/positions/usePositionRoster';
import { monitorActiveCount, positionCardsOf, teamCardsOf, type PositionCard, type TeamWall } from './monitorCore';
import { useSlotWorkIndex } from './slotWorkStore';

export type MonitorOverview = {
  positionCards: readonly PositionCard[];
  teamWall: TeamWall;
  /** Positions and teams mid-flight right now — the entry's badge. */
  activeCount: number;
  /** The raw counts behind the header line. */
  positionCount: number;
  activeTeamCount: number;
  /** The conversation list is still loading its first page. */
  loading: boolean;
};

export const useMonitorOverview = (withTasks: boolean): MonitorOverview => {
  const { positions } = usePositionRoster();
  const { conversations } = useConversationListSync();
  const { generatingConversationIds, waitingConfirmationConversationIds } = useConversationActivitySets();
  const roster = useTeamRosterSnapshot();
  const workbench = useTeamWorkbenchSnapshot(withTasks);
  const slotWork = useSlotWorkIndex();
  const [index, setIndex] = useState<readonly SupervisorTeam[]>([]);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    supervisorBridge.teams
      .invoke()
      .then((answer) => {
        if (!cancelled && answer.ok) setIndex(answer.data.teams);
      })
      .catch(() => {
        // No index: every team reads active, no TTL is shown.
      });
    return () => {
      cancelled = true;
    };
    // The list reference changes only on a real refetch, matching the sidebar
    // section's own re-read: a `send` elsewhere refreshes TTLs with the list.
  }, [roster.teams]);

  // The relative times stay honest without touching the data: a slow tick
  // re-renders, the stores do not.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const teams = roster.teams;
  const rosterEntries = useMemo(() => teamRosterEntries(teams, index, now), [teams, index, now]);
  const positionCards = useMemo(
    () =>
      positionCardsOf({
        positions,
        conversations,
        generatingIds: generatingConversationIds,
        waitingConfirmationIds: waitingConfirmationConversationIds,
        roster: rosterEntries,
        tasksByTeam: workbench.tasksByTeam,
        slotWork,
      }),
    [
      positions,
      conversations,
      generatingConversationIds,
      waitingConfirmationConversationIds,
      rosterEntries,
      workbench.tasksByTeam,
      slotWork,
    ]
  );
  const teamWall = useMemo(
    () => teamCardsOf({ roster: rosterEntries, tasksByTeam: workbench.tasksByTeam, slotWork, now }),
    [rosterEntries, workbench.tasksByTeam, slotWork, now]
  );

  return {
    positionCards,
    teamWall,
    activeCount: monitorActiveCount(positionCards, teamWall.active),
    positionCount: positionCards.length,
    activeTeamCount: teamWall.active.length,
    loading: roster.loading,
  };
};
