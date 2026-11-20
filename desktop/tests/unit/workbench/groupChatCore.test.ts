/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The pure decisions of the new-group-chat dialog: the auto name, the slots
 * the picked positions become (lead first, a lone position doubled), the
 * validation, and the create payload.
 */
import { describe, expect, it } from 'vitest';
import type { PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import {
  MAX_GROUP_POSITIONS,
  autoGroupName,
  buildGroupChatAgents,
  buildGroupChatCreateInput,
  leadThreadName,
  positionsByIds,
  teammateThreadName,
  validateGroupChatForm,
} from '@/renderer/pages/team/createGroupChat/groupChatCore';

const position = (name: string, displayName: string): PositionInfo => ({
  name,
  displayName,
  description: '',
});

const roster = [position('forwarder', '货代'), position('reviewer', '评审'), position('executor', '执行')];

describe('groupChatCore', () => {
  it('names an unnamed group after its positions, in the picked order', () => {
    expect(autoGroupName([roster[0], roster[1]])).toBe('货代、评审');
    expect(autoGroupName([roster[1], roster[0]])).toBe('评审、货代');
    expect(autoGroupName([])).toBe('');
  });

  it('resolves form ids to positions in the roster, dropping unknown ids', () => {
    expect(positionsByIds(['reviewer', 'forwarder', 'gone'], roster).map((p) => p.name)).toEqual([
      'reviewer',
      'forwarder',
    ]);
  });

  it('wants at least one position and no more than the cap; a name is never required', () => {
    expect(validateGroupChatForm({ name: '', positionIds: [] })).toBe('noPositions');
    expect(
      validateGroupChatForm({
        name: '',
        positionIds: Array.from({ length: MAX_GROUP_POSITIONS + 1 }, (_, i) => `p${i}`),
      })
    ).toBe('tooManyPositions');
    expect(validateGroupChatForm({ name: '', positionIds: ['forwarder'] })).toBeNull();
  });

  it('builds one slot per position — the first the lead — and doubles a lone position', () => {
    const two = buildGroupChatAgents([roster[0], roster[1]], 'bare:mu');
    expect(two).toEqual([
      { role: 'leader', assistant_id: 'bare:mu', assistant_name: '货代', model: 'default' },
      { role: 'teammate', assistant_id: 'bare:mu', assistant_name: '评审', model: 'default' },
    ]);
    const one = buildGroupChatAgents([roster[0]], 'bare:mu');
    expect(one).toHaveLength(2);
    expect(one[1]).toEqual({ role: 'teammate', assistant_id: 'bare:mu', assistant_name: '货代 2', model: 'default' });
  });

  it('sends the trimmed name (auto when empty) and the positions in the create payload', () => {
    const named = buildGroupChatCreateInput(
      { name: '  测试群  ', positionIds: ['forwarder'] },
      roster,
      'bare:mu',
      'u1'
    );
    expect(named.name).toBe('测试群');
    expect(named.agents[0]).toMatchObject({ role: 'leader', assistant_name: '货代' });
    const auto = buildGroupChatCreateInput(
      { name: '', positionIds: ['forwarder', 'reviewer'] },
      roster,
      'bare:mu',
      'u1'
    );
    expect(auto.name).toBe('货代、评审');
    expect(auto.workspace).toBe('');
    expect(auto.workspace_mode).toBe('shared');
    expect(auto.user_id).toBe('u1');
  });

  it('labels the threads: the lead is the group chat itself, a teammate thread says whose it is', () => {
    expect(leadThreadName('测试群')).toBe('测试群（群聊）');
    expect(teammateThreadName('评审', '测试群')).toBe('评审（测试群）');
  });
});
