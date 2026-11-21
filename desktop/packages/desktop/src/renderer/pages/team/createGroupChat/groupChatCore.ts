/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The pure decisions of the new-group-chat dialog: what a group is named when
 * the person leaves the name empty, how picked positions become team slots
 * (each position one mu slot, the first the lead — the same shape the
 * supervisor's teams.cjs `add` builds), what the create call sends, and the
 * lifecycle the dialog offers (a day count, or permanent). A manually
 * created group registers in the shared TEAMS.md index, so the supervisor
 * can match and reuse it.
 */
import type { ICreateTeamParams, TeamAssistantInput } from '@/common/adapter/teamMapper';
import type { PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import { TEAM_TTL_DEFAULT_DAYS, clampTeamTtlDays } from '@/common/chat/team/supervisor/supervisorCore';
import type { TTeam } from '@/common/types/team/teamTypes';

/** How many positions one group chat may hold (the lead plus these at most, like the old team form's cap). */
export const MAX_GROUP_POSITIONS = 6;
export const GROUP_NAME_MAX_LENGTH = 60;

export type GroupChatFormState = {
  name: string;
  positionIds: string[];
  /** The lifecycle the dialog carries: whole days (1-365), or permanent. */
  ttlDays: number;
  permanent: boolean;
  /** Per-seat model picks parallel to `positionIds` ('' = the default model). */
  modelsBySeat: string[];
};

/** The form's fresh state: the default 7-day, non-permanent lifecycle. */
export const initialGroupChatFormState = (): GroupChatFormState => ({
  name: '',
  positionIds: [],
  ttlDays: TEAM_TTL_DEFAULT_DAYS,
  permanent: false,
  modelsBySeat: [],
});

/** The lifecycle a form submits: the day count clamped into range, plus the
 *  permanent switch — exactly what the shared index row stores. */
export const groupChatLifecycle = (state: GroupChatFormState): { ttlDays: number; permanent: boolean } => ({
  ttlDays: clampTeamTtlDays(state.ttlDays),
  permanent: state.permanent,
});

export type GroupChatFormError = 'noPositions' | 'tooManyPositions';

/** `货代、评审`: the picked positions' display names joined, the fallback name. */
export const autoGroupName = (positions: PositionInfo[]): string =>
  positions.map((position) => position.displayName).join('、');

/** The positions a form's ids point at, in the roster's order. */
export const positionsByIds = (ids: readonly string[], roster: PositionInfo[]): PositionInfo[] => {
  const byId = new Map(roster.map((position) => [position.name, position]));
  return ids.flatMap((id) => {
    const position = byId.get(id);
    return position ? [position] : [];
  });
};

/** The first failing rule, or `null` when the form may be sent. A name is never required: empty means auto. */
export const validateGroupChatForm = (state: GroupChatFormState): GroupChatFormError | null => {
  if (state.positionIds.length === 0) return 'noPositions';
  if (state.positionIds.length > MAX_GROUP_POSITIONS) return 'tooManyPositions';
  return null;
};

/**
 * The slots the picked positions become: one mu slot per position under its
 * display name (the user-facing surface), the first the lead. A single
 * position gets a second slot of its own — a team needs a lead and a teammate.
 */
export const buildGroupChatAgents = (positions: PositionInfo[], assistantId: string): TeamAssistantInput[] => {
  const slots: TeamAssistantInput[] = positions.map((position, index) => ({
    role: index === 0 ? 'leader' : 'teammate',
    assistant_id: assistantId,
    assistant_name: position.displayName,
    model: 'default',
  }));
  if (slots.length === 1) slots.push({ ...slots[0], role: 'teammate', assistant_name: `${slots[0].assistant_name} 2` });
  return slots;
};

/** The create payload: the trimmed name (auto when empty) and the positions' slots. */
export const buildGroupChatCreateInput = (
  state: GroupChatFormState,
  roster: PositionInfo[],
  assistantId: string,
  user_id: string
): ICreateTeamParams => {
  const positions = positionsByIds(state.positionIds, roster);
  return {
    user_id,
    name: state.name.trim() || autoGroupName(positions),
    workspace: '',
    workspace_mode: 'shared',
    agents: buildGroupChatAgents(positions, assistantId),
  };
};

/** The lead slot's conversation, where the app lands after creating a group. */
export const leadConversationIdOf = (team: TTeam): string | undefined =>
  team.assistants.find((a) => a.role === 'leader')?.conversation_id;

/** The teammate label a member thread carries: `评审（测试群）` — whose thread inside which group. */
export const teammateThreadName = (memberName: string, groupName: string): string => `${memberName}（${groupName}）`;

/** The lead thread's label: `测试群（群聊）` — the group chat itself. */
export const leadThreadName = (groupName: string): string => `${groupName}（群聊）`;
