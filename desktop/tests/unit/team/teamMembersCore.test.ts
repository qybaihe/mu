/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The pure decisions of group-chat member management: who may be removed
 * (never the lead), which roster positions may still be added, and what the
 * group's TEAMS.md positions become after a change.
 */
import { describe, expect, it } from 'vitest';
import type { PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import type { TTeam } from '@/common/types/team/teamTypes';
import {
  addablePositions,
  isLeaderSlot,
  positionsAfterChange,
  removableMembersOf,
} from '@/renderer/pages/team/core/teamMembersCore';

const position = (name: string, displayName: string): PositionInfo => ({
  name,
  displayName,
  description: '',
});

const roster = [position('forwarder', '货代'), position('reviewer', '评审'), position('executor', '执行')];

const member = (slotId: string, name: string, role: 'leader' | 'teammate') => ({
  slot_id: slotId,
  conversation_id: `c-${slotId}`,
  role,
  assistant_backend: 'acp',
  assistant_name: name,
  status: 'idle' as const,
});

const team = (assistants: TTeam['assistants']): TTeam => ({
  id: 't1',
  user_id: 'u1',
  name: '测试群',
  workspace: 'E:/w',
  workspace_mode: 'shared',
  leader_assistant_id: 'lead',
  assistants,
  created_at: 1,
  updated_at: 1,
});

describe('teamMembersCore', () => {
  it('never offers the lead for removal; every teammate is removable', () => {
    const t = team([member('lead', '货代', 'leader'), member('m2', '评审', 'teammate')]);
    expect(isLeaderSlot(t.assistants[0])).toBe(true);
    expect(removableMembersOf(t).map((a) => a.slot_id)).toEqual(['m2']);
  });

  it('offers only the roster positions not already seated under their display name', () => {
    const t = team([member('lead', '货代', 'leader'), member('m2', '评审', 'teammate')]);
    expect(addablePositions(t, roster).map((p) => p.name)).toEqual(['executor']);
  });

  it('maps kept member names and added positions back to position ids, roster-ordered and deduped', () => {
    // 货代 kept, 评审 removed, 执行 added; a custom-named slot maps to nothing and drops out.
    const ids = positionsAfterChange(['货代', '自定义'], [roster[2]], roster);
    expect(ids).toEqual(['forwarder', 'executor']);
  });

  it('an empty change keeps only what still maps', () => {
    expect(positionsAfterChange(['货代', '评审'], [], roster)).toEqual(['forwarder', 'reviewer']);
    expect(positionsAfterChange(['不在名册的名字'], [], roster)).toEqual([]);
  });
});
