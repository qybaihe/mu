/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Group-chat member management as the header mounts it: the popover lists
 * the members (the lead badged and never removable), a removal calls the
 * backend's remove-agent API and refreshes the shared index, and adding a
 * position seats it as a teammate with a renamed thread.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TTeam } from '@/common/types/team/teamTypes';

let removeAgent: ReturnType<typeof vi.fn>;
let addAgent: ReturnType<typeof vi.fn>;
let conversationUpdate: ReturnType<typeof vi.fn>;
let registerTeam: ReturnType<typeof vi.fn>;
let refreshTeamsList: ReturnType<typeof vi.fn>;
let positions: { name: string; displayName: string; description: string }[];

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params === undefined) return key;
      return `${key}:${Object.entries(params)
        .map(([name, value]) => `${name}=${value}`)
        .join(',')}`;
    },
  }),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    auth: { currentUser: { invoke: vi.fn(async () => ({ id: 'u1' })) } },
    team: {
      removeAgent: { invoke: (...args: unknown[]) => removeAgent(...args) },
      addAgent: { invoke: (...args: unknown[]) => addAgent(...args) },
    },
    conversation: { update: { invoke: (...args: unknown[]) => conversationUpdate(...args) } },
  },
}));
vi.mock('@/common/chat/team/supervisor/supervisorBridge', () => ({
  supervisorBridge: {
    registerTeam: { invoke: (...args: unknown[]) => registerTeam(...args) },
  },
}));
vi.mock('@/renderer/pages/positions/usePositionRoster', () => ({
  usePositionRoster: () => ({ positions, isLoading: false }),
}));
vi.mock('@/renderer/pages/team/core/teamStore', () => ({
  refreshTeamsList: (...args: unknown[]) => refreshTeamsList(...args),
}));
import TeamMembersManager from '@/renderer/pages/team/components/TeamMembersManager';

const member = (slotId: string, name: string, role: 'leader' | 'teammate') => ({
  slot_id: slotId,
  conversation_id: `c-${slotId}`,
  role,
  assistant_backend: 'acp',
  assistant_id: 'bare:mu',
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

describe('TeamMembersManager', () => {
  beforeEach(() => {
    removeAgent = vi.fn(async () => undefined);
    addAgent = vi.fn(async () => ({ slot_id: 'new-slot', conversation_id: 'c-new' }));
    conversationUpdate = vi.fn(async () => true);
    registerTeam = vi.fn(async () => ({ ok: true, data: { teams: [] } }));
    refreshTeamsList = vi.fn();
    positions = [
      { name: 'forwarder', displayName: '货代', description: '' },
      { name: 'reviewer', displayName: '评审', description: '' },
      { name: 'executor', displayName: '执行', description: '' },
    ];
  });
  afterEach(() => cleanup());

  const open = async (t?: TTeam) => {
    render(
      <TeamMembersManager team={t ?? team([member('lead', '货代', 'leader'), member('m2', '评审', 'teammate')])} />
    );
    fireEvent.click(screen.getByTestId('team-members-manage'));
    return screen.findByTestId('team-members-popover');
  };

  it('lists the members: the lead badged, never removable; teammates removable', async () => {
    await open();
    expect(screen.getByTestId('team-member-row-lead').textContent).toContain('team.members.leadBadge');
    const leadRow = screen.getByTestId('team-member-row-lead');
    expect(leadRow.querySelector('button')).toBeNull();
    expect(screen.getByTestId('team-member-row-m2').querySelector('button')).not.toBeNull();
  });

  it('removes a member through the backend, then refreshes the shared index and the list', async () => {
    await open();
    fireEvent.click(screen.getByTestId('team-member-row-m2').querySelector('button') as HTMLElement);
    await waitFor(() => expect(removeAgent).toHaveBeenCalledWith({ team_id: 't1', slot_id: 'm2' }));
    await waitFor(() =>
      expect(registerTeam).toHaveBeenCalledWith({
        name: '测试群',
        positions: ['forwarder'], // the lead's 货代 stays; the removed 评审 drops out
        teamId: 't1',
        leadConversationId: 'c-lead',
      })
    );
    expect(refreshTeamsList).toHaveBeenCalled();
  });

  it('adds a picked position as a teammate, renames its thread, and refreshes the index', async () => {
    await open();
    // The add select offers only positions not already seated.
    fireEvent.click(screen.getByTestId('team-members-add-select'));
    const option = await screen.findByText('执行');
    fireEvent.click(option);
    fireEvent.click(screen.getByTestId('team-members-add-apply'));
    await waitFor(() =>
      expect(addAgent).toHaveBeenCalledWith({
        team_id: 't1',
        assistant: { role: 'teammate', assistant_name: '执行', model: 'default', assistant_id: 'bare:mu' },
      })
    );
    await waitFor(() =>
      expect(conversationUpdate).toHaveBeenCalledWith({
        id: 'c-new',
        updates: { name: '执行（测试群）', name_source: 'user' },
      })
    );
    await waitFor(() =>
      expect(registerTeam).toHaveBeenCalledWith({
        name: '测试群',
        positions: ['forwarder', 'reviewer', 'executor'],
        teamId: 't1',
        leadConversationId: 'c-lead',
      })
    );
    expect(refreshTeamsList).toHaveBeenCalled();
  });

  it('says the roster is fully seated when every position already has a slot', async () => {
    await open(
      team([member('lead', '货代', 'leader'), member('m2', '评审', 'teammate'), member('m3', '执行', 'teammate')])
    );
    expect(screen.getByText('team.members.addAllOnTeam')).toBeInTheDocument();
    expect(screen.queryByTestId('team-members-add-select')).toBeNull();
  });
});
