/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The pure decisions of group-chat member management: which members may be
 * removed (every slot but the lead — the backend refuses to lose a lead, the
 * UI never offers it), which roster positions may still be added (a position
 * already sitting in the group under its display name is not), and what the
 * group's TEAMS.md positions are after a change (member display names mapped
 * back to position ids; a slot that maps to no position simply drops out).
 */
import type { PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import type { TTeam, TeamAssistant } from '@/common/types/team/teamTypes';

/** The lead slot: the one member that can never be removed (the group chat is its thread). */
export const isLeaderSlot = (assistant: TeamAssistant): boolean => assistant.role === 'leader';

/** The members a person may remove from the group: everyone but the lead. */
export const removableMembersOf = (team: TTeam): TeamAssistant[] =>
  team.assistants.filter((assistant) => !isLeaderSlot(assistant));

/** The roster positions not yet in the group: keyed by display name, the slot label a position takes. */
export const addablePositions = (team: TTeam, roster: PositionInfo[]): PositionInfo[] => {
  const taken = new Set(team.assistants.map((assistant) => assistant.assistant_name));
  return roster.filter((position) => !taken.has(position.displayName));
};

/** The position id a member slot's name points at, when it points at one. */
export const positionIdForMemberName = (name: string, roster: PositionInfo[]): string | undefined =>
  roster.find((position) => position.displayName === name)?.name;

/**
 * The group's TEAMS.md positions after a membership change: every kept
 * member's mapped position id plus the added positions', deduped in roster
 * order. An unmapped member (a custom-named slot from an older flow) drops
 * out — the index records positions, not names it cannot resolve.
 */
export const positionsAfterChange = (
  keptMemberNames: readonly string[],
  addedPositions: readonly PositionInfo[],
  roster: PositionInfo[]
): string[] => {
  const ids = new Set<string>();
  for (const name of keptMemberNames) {
    const id = positionIdForMemberName(name, roster);
    if (id) ids.add(id);
  }
  for (const position of addedPositions) ids.add(position.name);
  return roster.filter((position) => ids.has(position.name)).map((position) => position.name);
};
