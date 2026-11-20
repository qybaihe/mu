/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The new-group-chat dialog: the name is optional (empty means the auto
 * name), at least one position is required before the create unlocks, and
 * submitting creates the team, renames its threads (the lead is the group
 * chat itself) and registers it in the shared index — then hands the team to
 * the sidebar, which lands in the lead's conversation.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TTeam } from '@/common/types/team/teamTypes';

let positions: { name: string; displayName: string; description: string }[];
let assistants: { id: string; name: string; team_selectable: boolean }[];
let create: ReturnType<typeof vi.fn>;
let conversationUpdate: ReturnType<typeof vi.fn>;
let registerTeam: ReturnType<typeof vi.fn>;
let created: TTeam[];

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
vi.mock('@/renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({ theme: 'light', fontScale: 1 }),
}));
vi.mock('@/renderer/pages/positions/usePositionRoster', () => ({
  usePositionRoster: () => ({ positions, isLoading: false }),
}));
vi.mock('@/renderer/pages/conversation/hooks/useConversationAssistants', () => ({
  useConversationAssistants: () => ({ presetAssistants: assistants, isLoading: false }),
}));
vi.mock('@/renderer/pages/team/core/teamDispatchSeed', () => ({
  ensureTeamDispatchSeeded: vi.fn(async () => undefined),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    auth: { currentUser: { invoke: vi.fn(async () => ({ id: 'u1' })) } },
    team: { create: { invoke: (...args: unknown[]) => create(...args) } },
    conversation: { update: { invoke: (...args: unknown[]) => conversationUpdate(...args) } },
  },
}));
vi.mock('@/common/chat/team/supervisor/supervisorBridge', () => ({
  supervisorBridge: { registerTeam: { invoke: (...args: unknown[]) => registerTeam(...args) } },
}));
import NewGroupChatModal from '@renderer/pages/team/createGroupChat/NewGroupChatModal';

const teamOf = (name: string): TTeam => ({
  id: 't-new',
  user_id: 'u1',
  name,
  workspace: 'E:/w',
  workspace_mode: 'shared',
  leader_assistant_id: 's-lead',
  assistants: [
    {
      slot_id: 's-lead',
      conversation_id: 'c-lead',
      role: 'leader',
      assistant_backend: 'acp',
      assistant_name: '货代',
      status: 'idle',
    },
    {
      slot_id: 's-2',
      conversation_id: 'c-m2',
      role: 'teammate',
      assistant_backend: 'acp',
      assistant_name: '评审',
      status: 'idle',
    },
  ],
  created_at: 1,
  updated_at: 1,
});

describe('NewGroupChatModal', () => {
  beforeEach(() => {
    positions = [
      { name: 'forwarder', displayName: '货代', description: '' },
      { name: 'reviewer', displayName: '评审', description: '' },
    ];
    assistants = [{ id: 'bare:mu', name: 'mu', team_selectable: true }];
    create = vi.fn(async () => teamOf('货代、评审'));
    conversationUpdate = vi.fn(async () => true);
    registerTeam = vi.fn(async () => ({ ok: true, data: { teams: [] } }));
    created = [];
  });
  afterEach(() => cleanup());

  it('keeps the create locked until a position is picked; a name is never required', async () => {
    render(<NewGroupChatModal open onClose={() => {}} onCreated={(team) => created.push(team)} />);
    await screen.findByTestId('new-group-chat-form');
    expect(screen.getByTestId('new-group-chat-submit')).toBeDisabled();
    expect(screen.getByText('team.groupChat.errors.noPositions')).toBeInTheDocument();
    expect(screen.queryByTestId('new-group-chat-name')).toBeInTheDocument(); // the name stays optional
  });

  it('creates the group from the picked positions, renames the threads, registers it, and hands it over', async () => {
    render(<NewGroupChatModal open onClose={() => {}} onCreated={(team) => created.push(team)} />);
    fireEvent.click(screen.getByTestId('new-group-chat-positions'));
    fireEvent.click(await screen.findByText('货代'));
    fireEvent.click(await screen.findByText('评审'));
    expect(screen.getByTestId('new-group-chat-submit')).toBeEnabled();
    // The empty name preview says the positions will name the group.
    expect(screen.getByText('team.groupChat.namePreview:name=货代、评审')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('new-group-chat-submit'));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({
      user_id: 'u1',
      name: '货代、评审',
      workspace_mode: 'shared',
      agents: [
        { role: 'leader', assistant_id: 'bare:mu', assistant_name: '货代', model: 'default' },
        { role: 'teammate', assistant_id: 'bare:mu', assistant_name: '评审', model: 'default' },
      ],
    });
    await waitFor(() =>
      expect(conversationUpdate).toHaveBeenCalledWith({
        id: 'c-lead',
        updates: { name: '货代、评审（群聊）', name_source: 'user' },
      })
    );
    expect(conversationUpdate).toHaveBeenCalledWith({
      id: 'c-m2',
      updates: { name: '评审（货代、评审）', name_source: 'user' },
    });
    await waitFor(() =>
      expect(registerTeam).toHaveBeenCalledWith({
        name: '货代、评审',
        positions: ['forwarder', 'reviewer'],
        teamId: 't-new',
        leadConversationId: 'c-lead',
        ttlDays: 7,
        permanent: false,
      })
    );
    await waitFor(() => expect(created).toHaveLength(1));
  });

  it('registers with the picked lifecycle: permanent disables the day count and passes through', async () => {
    render(<NewGroupChatModal open onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByTestId('new-group-chat-positions'));
    fireEvent.click(await screen.findByText('货代'));
    // The default lifecycle reads 7 days and not permanent; permanent turns the day count off.
    expect((screen.getByTestId('new-group-chat-ttl') as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('new-group-chat-permanent'));
    expect((screen.getByTestId('new-group-chat-ttl') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('new-group-chat-submit'));
    await waitFor(() =>
      expect(registerTeam).toHaveBeenCalledWith(
        expect.objectContaining({ positions: ['forwarder'], ttlDays: 7, permanent: true })
      )
    );
  });

  it('sends the typed name when there is one, and forgets the form after closing', async () => {
    const { rerender } = render(<NewGroupChatModal open onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByTestId('new-group-chat-name'), { target: { value: '测试群' } });
    expect(screen.getByText('team.groupChat.namePreview:name=测试群')).toBeInTheDocument();
    rerender(<NewGroupChatModal open={false} onClose={() => {}} onCreated={() => {}} />);
    rerender(<NewGroupChatModal open onClose={() => {}} onCreated={() => {}} />);
    expect(screen.getByTestId('new-group-chat-name')).toHaveValue('');
  });
});
