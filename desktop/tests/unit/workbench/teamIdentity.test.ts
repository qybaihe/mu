/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { SupervisorTeam } from '@/common/chat/team/supervisor/supervisorCore';
import { positionIdentityColor } from '@/common/chat/team/positions/positionIdentityColor';
import type { TTeam } from '@/common/types/team/teamTypes';
import {
  memberIdentityColor,
  memberInitial,
  rosterEntryHolds,
  stripGroupChatMarker,
  teamRosterEntries,
} from '@/renderer/pages/workbench/team/teamIdentity';

const team = (id: string, overrides: Partial<TTeam> = {}): TTeam => ({
  id,
  user_id: 'u1',
  name: `team-${id}`,
  workspace: 'E:/w',
  workspace_mode: 'isolated',
  leader_assistant_id: 'lead-slot',
  assistants: [
    {
      slot_id: 'lead-slot',
      conversation_id: `${id}-lead`,
      role: 'leader',
      assistant_backend: 'acp',
      assistant_name: 'lead',
      status: 'idle',
    },
    {
      slot_id: 'm1',
      conversation_id: `${id}-m1`,
      role: 'teammate',
      assistant_backend: 'acp',
      assistant_name: 'm1',
      status: 'idle',
    },
  ],
  created_at: 1,
  updated_at: 1,
  ...overrides,
});

const indexEntry = (teamId: string, expiresAt: number, lastUsedAt = 5): SupervisorTeam => ({
  name: `index-${teamId}`,
  positions: [],
  createdAt: 1,
  lastUsedAt,
  expiresAt,
  teamId,
  leadConversationId: `${teamId}-lead`,
});

const NOW = 1000;

describe('stripGroupChatMarker', () => {
  it('strips the marker teams.cjs appends, in both spellings', () => {
    expect(stripGroupChatMarker('货代周会摘要复核（群聊）')).toBe('货代周会摘要复核');
    expect(stripGroupChatMarker('weekly review (群聊)')).toBe('weekly review');
    expect(stripGroupChatMarker('weekly review（群聊） ')).toBe('weekly review');
  });

  it('keeps a name without the marker, and never returns nothing', () => {
    expect(stripGroupChatMarker('体验队')).toBe('体验队');
    expect(stripGroupChatMarker('（群聊）')).toBe('（群聊）');
    expect(stripGroupChatMarker('')).toBe('');
  });
});

describe('memberInitial', () => {
  it('takes the first character, whole emoji included', () => {
    expect(memberInitial('货代')).toBe('货');
    expect(memberInitial('mu 2')).toBe('m');
    expect(memberInitial('🚀 launch')).toBe('🚀');
    expect(memberInitial('  spaced')).toBe('s');
  });

  it('reads an empty name as nothing', () => {
    expect(memberInitial('')).toBe('');
    expect(memberInitial('   ')).toBe('');
  });
});

describe('teamRosterEntries', () => {
  it('maps every team with its members, lead conversation and count', () => {
    const [entry] = teamRosterEntries([team('t1')], [], NOW);
    expect(entry).toMatchObject({
      memberCount: 2,
      leadConversationId: 't1-lead',
      retired: false,
      expiresAt: undefined,
    });
    expect(entry.conversationIds).toEqual(['t1-lead', 't1-m1']);
  });

  it('reads a team the index does not know as active', () => {
    const entries = teamRosterEntries([team('ui-built')], [indexEntry('other', NOW + 1)], NOW);
    expect(entries[0].retired).toBe(false);
  });

  it('marks a team past its TTL as retired and lists it after the active ones', () => {
    const entries = teamRosterEntries(
      [team('old'), team('live')],
      [indexEntry('old', NOW - 1), indexEntry('live', NOW + 1)],
      NOW
    );
    expect(entries.map((entry) => entry.team.id)).toEqual(['live', 'old']);
    expect(entries[0].retired).toBe(false);
    expect(entries[1].retired).toBe(true);
    expect(entries[1].expiresAt).toBe(NOW - 1);
  });

  it('orders active teams by recency, the index reuse time outranking the record', () => {
    const stale = team('stale', { updated_at: 10 });
    const fresh = team('fresh', { updated_at: 5 });
    const entries = teamRosterEntries([stale, fresh], [indexEntry('fresh', NOW + 1, 99)], NOW);
    expect(entries.map((entry) => entry.team.id)).toEqual(['fresh', 'stale']);
  });
});

describe('rosterEntryHolds', () => {
  const [entry] = teamRosterEntries([team('t1')], [], NOW);

  it('holds the lead and every member conversation', () => {
    expect(rosterEntryHolds(entry, 't1-lead')).toBe(true);
    expect(rosterEntryHolds(entry, 't1-m1')).toBe(true);
    expect(rosterEntryHolds(entry, 'other')).toBe(false);
    expect(rosterEntryHolds(entry, undefined)).toBe(false);
  });
});

describe('memberIdentityColor', () => {
  const positions = [
    { name: 'forwarder', displayName: '货代', description: '', body: '' },
    { name: 'reviewer', displayName: '评审', description: '', body: '' },
  ];

  it('follows the member position, a numbered second slot its position', () => {
    expect(memberIdentityColor('货代', positions)).toEqual(positionIdentityColor('forwarder'));
    expect(memberIdentityColor('货代 2', positions)).toEqual(positionIdentityColor('forwarder'));
  });

  it('hashes an unknown slot name on its own, still one stable colour', () => {
    expect(memberIdentityColor('已删岗', positions)).toEqual(positionIdentityColor('已删岗'));
    expect(memberIdentityColor('已删岗', [])).toEqual(memberIdentityColor('已删岗', positions));
  });
});
