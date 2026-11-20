/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The group conversation's task events: only the team's lead conversation is
 * the group chat — a teammate's own conversation is their private thread, and
 * task cards there would be noise, not the group's timeline. Resolves the
 * conversation's team asynchronously (the conversation detail is cached by
 * `teamInfoOf`), then reads the backend's own task list through the shared
 * team store, so a `team.taskChanged` refetch updates the open cards in place.
 */
import { useEffect, useState } from 'react';
import type { ITeamMailboxMessage, ITeamTaskItem, TeamAssistant } from '@/common/types/team/teamTypes';
import { teamInfoOf } from '@renderer/pages/team/core/claimsEnv';
import { useTeamWorkbenchSnapshot } from '@renderer/pages/team/core/teamStore';

export type TeamTaskEventsScope = {
  teamId: string;
  tasks: readonly ITeamTaskItem[];
  members: readonly TeamAssistant[];
  /** The team's newest mailbox messages — the member half of the group chat. */
  mailbox: readonly ITeamMailboxMessage[];
};

const EMPTY_TASKS: readonly ITeamTaskItem[] = [];
const EMPTY_MEMBERS: readonly TeamAssistant[] = [];
const EMPTY_MAILBOX: readonly ITeamMailboxMessage[] = [];

export const useTeamTaskEvents = (conversationId: string | undefined): TeamTaskEventsScope | undefined => {
  const [teamId, setTeamId] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    if (!conversationId) return undefined;
    setTeamId(undefined);
    void teamInfoOf(conversationId).then((info) => {
      if (cancelled) return;
      // Only the lead conversation is the group chat (see the module comment).
      if (info?.teamId && info.role === 'lead') setTeamId(info.teamId);
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const snapshot = useTeamWorkbenchSnapshot(teamId !== undefined);
  if (!teamId) return undefined;
  const team = snapshot.teams.find((candidate) => candidate.id === teamId);
  return {
    teamId,
    tasks: snapshot.tasksByTeam.get(teamId) ?? EMPTY_TASKS,
    members: team?.assistants ?? EMPTY_MEMBERS,
    mailbox: snapshot.mailboxByTeam.get(teamId) ?? EMPTY_MAILBOX,
  };
};
