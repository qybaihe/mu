/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AttentionPanel from '@/renderer/pages/workbench/attention/AttentionPanel';
import { resetAttentionStoreForTest, useAttentionSnapshot } from '@/renderer/pages/workbench/attention/attentionStore';

/** Captured wire handlers: the store's subscriptions land here. */
const wire = vi.hoisted(() => {
  const handlers: Record<string, (event: unknown) => void> = {};
  const emitter = (name: string) => ({
    on: vi.fn((handler: (event: unknown) => void) => {
      handlers[name] = handler;
      return () => delete handlers[name];
    }),
  });
  return {
    handlers,
    emitter,
    conversations: { invoke: vi.fn() },
    teamGet: { invoke: vi.fn() },
  };
});

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      responseStream: wire.emitter('responseStream'),
      listChanged: wire.emitter('listChanged'),
      turnCompleted: wire.emitter('turnCompleted'),
      confirmation: { remove: wire.emitter('confirmation.remove') },
    },
    team: {
      get: wire.teamGet,
      runFailed: wire.emitter('runFailed'),
    },
    database: { getUserConversations: wire.conversations },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { name?: string }) => (params?.name ? `${key}:${params.name}` : key),
    i18n: { language: 'en-US' },
  }),
}));

const conversations = (items: Array<{ id: string; name?: string }>) => ({
  items: items.map((item) => ({ id: item.id, name: item.name ?? `Chat ${item.id}`, project_id: null })),
  total: items.length,
  has_more: false,
});

const Where: React.FC = () => {
  const { pathname } = useLocation();
  return <div data-testid='where'>{pathname}</div>;
};

const renderPanel = () =>
  render(
    <MemoryRouter initialEntries={['/workbench']}>
      <Routes>
        <Route path='/workbench' element={<AttentionPanel />} />
        <Route path='*' element={<Where />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetAttentionStoreForTest();
  wire.conversations.invoke.mockResolvedValue(conversations([{ id: 'conv-1' }, { id: 'conv-2' }, { id: 'conv-3' }]));
  wire.teamGet.invoke.mockResolvedValue(null);
});

describe('attention store wiring (the three sources → one list)', () => {
  it('aggregates approval, question and failed-run items from their own wires', async () => {
    wire.teamGet.invoke.mockResolvedValue({
      id: 'team-1',
      assistants: [{ slot_id: 'slot-1', conversation_id: 'conv-2' }],
    });
    const { result } = renderHook(() => useAttentionSnapshot());
    await waitFor(() => expect(wire.conversations.invoke).toHaveBeenCalled());

    act(() =>
      wire.handlers.responseStream!({
        type: 'permission',
        data: { call_id: 'call-1' },
        conversation_id: 'conv-1',
        created_at: 10,
      })
    );
    act(() =>
      wire.handlers.responseStream!({
        type: 'ask',
        data: { request_id: 'req-1' },
        conversation_id: 'conv-2',
        created_at: 20,
      })
    );
    act(() => wire.handlers['turnCompleted']!({ session_id: 'conv-3', state: 'error' }));
    act(() => wire.handlers['runFailed']!({ team_id: 'team-1', target_slot_id: 'slot-1', status: 'failed' }));
    await waitFor(() => expect(result.current.items.length).toBe(4));

    const snapshot = result.current;
    expect(snapshot.items.map((item) => item.kind)).toEqual(['approval', 'question', 'failure', 'failure']);
    expect(snapshot.badgeCount).toBe(4);
    expect(snapshot.conversationNames.get('conv-1')).toBe('Chat conv-1');
  });

  it('a permission frame without a usable confirmation id adds nothing', async () => {
    const { result } = renderHook(() => useAttentionSnapshot());
    await waitFor(() => expect(wire.conversations.invoke).toHaveBeenCalled());
    act(() =>
      wire.handlers.responseStream!({ type: 'permission', data: {}, conversation_id: 'conv-1', created_at: 10 })
    );
    expect(result.current.items.length).toBe(0);
  });

  it('answered confirmations leave through confirmation.remove and terminal frames', async () => {
    const { result } = renderHook(() => useAttentionSnapshot());
    await waitFor(() => expect(wire.conversations.invoke).toHaveBeenCalled());
    act(() =>
      wire.handlers.responseStream!({ type: 'permission', data: { call_id: 'call-1' }, conversation_id: 'conv-1' })
    );
    act(() =>
      wire.handlers.responseStream!({ type: 'permission', data: { call_id: 'call-2' }, conversation_id: 'conv-2' })
    );

    // One answered: only its sibling stays.
    act(() => wire.handlers['confirmation.remove']!({ conversation_id: 'conv-1', id: 'call-1' }));
    expect(result.current.items.length).toBe(1);
    expect(result.current.items[0]?.conversationId).toBe('conv-2');

    // A finished turn clears whatever else the conversation asked.
    act(() => wire.handlers.responseStream!({ type: 'finish', conversation_id: 'conv-2' }));
    expect(result.current.items.length).toBe(0);
  });

  it('a turn completing into waiting_confirmation keeps its live items', async () => {
    const { result } = renderHook(() => useAttentionSnapshot());
    await waitFor(() => expect(wire.conversations.invoke).toHaveBeenCalled());
    act(() => wire.handlers.responseStream!({ type: 'ask', data: { request_id: 'req-1' }, conversation_id: 'conv-1' }));
    act(() => wire.handlers['turnCompleted']!({ session_id: 'conv-1', state: 'ai_waiting_confirmation' }));
    expect(result.current.items.length).toBe(1);
  });

  it('failures survive restarts through localStorage and live items do not', async () => {
    const first = renderHook(() => useAttentionSnapshot());
    await waitFor(() => expect(wire.conversations.invoke).toHaveBeenCalled());
    act(() => wire.handlers['turnCompleted']!({ session_id: 'conv-3', state: 'error' }));
    act(() =>
      wire.handlers.responseStream!({ type: 'permission', data: { call_id: 'call-1' }, conversation_id: 'conv-1' })
    );
    expect(first.result.current.items.length).toBe(2);
    first.unmount();

    // A restart: the module store starts over — failures come back from storage, live waits do not.
    resetAttentionStoreForTest();
    const second = renderHook(() => useAttentionSnapshot());
    await waitFor(() => expect(second.result.current.items.length).toBe(1));
    expect(second.result.current.items[0]?.kind).toBe('failure');
    expect(second.result.current.items[0]?.conversationId).toBe('conv-3');
  });

  it('failures of deleted conversations disappear, team ones included', async () => {
    wire.teamGet.invoke.mockResolvedValue({
      id: 'team-1',
      assistants: [{ slot_id: 'slot-1', conversation_id: 'conv-2' }],
    });
    const { result } = renderHook(() => useAttentionSnapshot());
    await waitFor(() => expect(wire.conversations.invoke).toHaveBeenCalled());
    act(() => wire.handlers['runFailed']!({ team_id: 'team-1', target_slot_id: 'slot-1', status: 'failed' }));
    await waitFor(() => expect(result.current.items.length).toBe(1));

    act(() => wire.handlers['listChanged']!({ action: 'deleted', conversation_id: 'conv-2' }));
    await waitFor(() => expect(wire.conversations.invoke).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.items.length).toBe(0));
  });

  it('a delete racing the first conversation fetch must not wipe the persisted failures', async () => {
    // The fetch never resolves: the id set stays empty, as before the first load.
    wire.conversations.invoke.mockReturnValue(new Promise(() => {}));
    localStorage.setItem(
      'mu.workbench.attention.failures',
      JSON.stringify([{ id: 'kept-1', conversationId: 'conv-9', at: 5 }])
    );
    const { result } = renderHook(() => useAttentionSnapshot());
    await waitFor(() => expect(wire.handlers['listChanged']).toBeTruthy());

    act(() => wire.handlers['listChanged']!({ action: 'deleted', conversation_id: 'somewhere-else' }));

    expect(result.current.items.map((item) => item.key)).toEqual(['failure:kept-1']);
    expect(JSON.parse(localStorage.getItem('mu.workbench.attention.failures') ?? '[]')).toEqual([
      { id: 'kept-1', conversationId: 'conv-9', at: 5 },
    ]);
  });
});

describe('AttentionPanel', () => {
  it('shows the empty state when nothing needs attention', async () => {
    renderPanel();
    await waitFor(() => expect(wire.conversations.invoke).toHaveBeenCalled());
    expect(screen.getByTestId('attention-empty')).toBeInTheDocument();
  });

  it('renders rows per kind, opens the conversation on click, and marks failures handled', async () => {
    const user = userEvent.setup();
    wire.teamGet.invoke.mockResolvedValue({
      id: 'team-1',
      assistants: [{ slot_id: 'slot-1', conversation_id: 'conv-2' }],
    });
    renderPanel();
    await waitFor(() => expect(wire.conversations.invoke).toHaveBeenCalled());

    act(() =>
      wire.handlers.responseStream!({
        type: 'permission',
        data: { call_id: 'call-1' },
        conversation_id: 'conv-1',
        created_at: 10,
      })
    );
    act(() =>
      wire.handlers.responseStream!({
        type: 'ask',
        data: { request_id: 'req-1' },
        conversation_id: 'conv-2',
        created_at: 20,
      })
    );
    act(() => wire.handlers['turnCompleted']!({ session_id: 'conv-3', state: 'error' }));

    await waitFor(() => expect(screen.getByTestId('attention-row-approval')).toBeInTheDocument());
    expect(screen.getByTestId('attention-row-question')).toBeInTheDocument();
    await screen.findByTestId('attention-row-failure');
    expect(screen.getByText('team.workbench.attention.approval')).toBeInTheDocument();
    expect(screen.getByText('team.workbench.attention.question')).toBeInTheDocument();
    expect(screen.getByText('team.workbench.attention.failure')).toBeInTheDocument();

    // The failure row carries the only way out — dismiss it while the panel is still up.
    await user.click(screen.getByRole('button', { name: 'team.workbench.attention.markHandledA11y:Chat conv-3' }));
    await waitFor(() => expect(screen.queryByTestId('attention-row-failure')).not.toBeInTheDocument());

    // Click a live row: straight to its conversation (the panel unmounts with it).
    await user.click(screen.getByTestId('attention-row-approval'));
    expect(await screen.findByTestId('where')).toHaveTextContent('/conversation/conv-1');
  });
});
