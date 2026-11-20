/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The team identity core: how a team presents itself where it must stand out
 * from ordinary conversations. Pure derivations only — the sidebar's team
 * section (rows, fold, retired dimming) and the conversation header's identity
 * chip both build on these; all IO lives in their stores and services.
 */
import type { SupervisorTeam } from '@/common/chat/team/supervisor/supervisorCore';
import type { PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import { positionIdentityColor, type PositionIdentityColor } from '@/common/chat/team/positions/positionIdentityColor';
import type { TTeam } from '@/common/types/team/teamTypes';

/**
 * The marker `teams.cjs` appends to a lead conversation's name (and its ASCII
 * spelling, so a hand-renamed conversation still reads). Display only — the
 * stored name keeps the marker; stripping it is the caller's presentation.
 */
const GROUP_CHAT_MARKER = /[（(]\s*群聊\s*[)）]\s*$/;

/** A conversation name without its trailing group-chat marker. */
export const stripGroupChatMarker = (name: string): string => {
  const stripped = name.replace(GROUP_CHAT_MARKER, '').trimEnd();
  return stripped === '' ? name : stripped;
};

/** One member's avatar text: the first character of their slot name. */
export const memberInitial = (name: string): string => Array.from(name.trim())[0] ?? '';

/**
 * Whether a team slot's name belongs to a position: exact, or a numbered
 * second slot (`货代 2`). The one matching rule shared by every surface that
 * attributes team slots back to roster positions (the monitor's walls, the
 * member-identity colour).
 */
export const slotMatchesPosition = (slotName: string, displayName: string): boolean =>
  slotName === displayName || slotName.startsWith(`${displayName} `);

/**
 * A member slot's identity colour: its position's when the roster knows the
 * slot (a numbered second slot follows its position), the slot name's own
 * hash otherwise, so an unknown member still reads one stable colour.
 */
export const memberIdentityColor = (slotName: string, positions: readonly PositionInfo[]): PositionIdentityColor => {
  const position = positions.find((candidate) => slotMatchesPosition(slotName, candidate.displayName));
  return positionIdentityColor(position ? position.name : slotName);
};

/** One team of the sidebar's team section, with everything a row displays. */
export type TeamRosterEntry = {
  team: TTeam;
  memberCount: number;
  /** The group chat itself — the lead slot's conversation. */
  leadConversationId: string | undefined;
  /** Every conversation of the team (lead and members), for the active row. */
  conversationIds: readonly string[];
  /** A retired team (past its TTL in the shared index) reads as history. */
  retired: boolean;
  /** Epoch ms when the index retires the team; undefined outside the index. */
  expiresAt: number | undefined;
  /** The team's own lifecycle length from the index, in days. */
  ttlDays: number | undefined;
  /** A permanent team never retires, whatever its recorded expiry. */
  permanent: boolean;
};

/**
 * The teams as the sidebar lists them: every backend team, its lifecycle from
 * the shared index (a team the index does not know — built elsewhere — stays
 * active), active teams first by recency, retired ones after them.
 */
export const teamRosterEntries = (
  teams: readonly TTeam[],
  index: readonly SupervisorTeam[],
  now: number
): TeamRosterEntry[] => {
  const indexed = new Map(index.map((entry) => [entry.teamId, entry]));
  const entries = teams.map((team) => {
    const record = indexed.get(team.id);
    return {
      team,
      memberCount: team.assistants.length,
      leadConversationId: team.assistants.find((assistant) => assistant.role === 'leader')?.conversation_id,
      conversationIds: team.assistants.map((assistant) => assistant.conversation_id),
      retired: record !== undefined && record.expiresAt <= now && !record.permanent,
      expiresAt: record?.expiresAt,
      ttlDays: record?.ttlDays,
      permanent: record?.permanent ?? false,
    };
  });
  const recencyOf = (entry: TeamRosterEntry): number =>
    Math.max(entry.team.updated_at, indexed.get(entry.team.id)?.lastUsedAt ?? 0);
  return entries.toSorted((a, b) => {
    if (a.retired !== b.retired) return a.retired ? 1 : -1;
    return recencyOf(b) - recencyOf(a);
  });
};

/** Whether a conversation (the route's id) belongs to the team. */
export const rosterEntryHolds = (entry: TeamRosterEntry, conversationId: string | undefined): boolean =>
  conversationId !== undefined && entry.conversationIds.includes(conversationId);
