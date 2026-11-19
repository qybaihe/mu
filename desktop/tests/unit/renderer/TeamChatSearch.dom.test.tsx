/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TeamChatSearch from '@/renderer/pages/conversation/components/TeamChatSearch';

const wire = vi.hoisted(() => ({
  search: { invoke: vi.fn() },
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    database: { searchConversationMessages: wire.search },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US' },
  }),
}));

const hit = (overrides: Record<string, unknown> = {}) => ({
  message_id: 'msg-1',
  message_type: 'text',
  message_created_at: 50,
  preview_text: 'pricing research done',
  conversation: { id: 'conv-1', name: 'T2', extra: { teamId: 'team-1' } },
  ...overrides,
});

const Where: React.FC = () => {
  const location = useLocation();
  return (
    <div data-testid='where'>
      {location.pathname}|{(location.state as { targetMessageId?: string } | null)?.targetMessageId ?? ''}
    </div>
  );
};

const renderSearch = () =>
  render(
    <MemoryRouter initialEntries={['/conversation/conv-1']}>
      <Routes>
        <Route
          path='/conversation/:id'
          element={
            <>
              <TeamChatSearch teamId='team-1' />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );

describe('TeamChatSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wire.search.invoke.mockResolvedValue({ items: [] });
  });

  it('renders the header trigger and opens the popover', async () => {
    renderSearch();
    await userEvent.click(screen.getByTestId('team-chat-search-trigger'));
    expect(screen.getByTestId('team-chat-search')).toBeTruthy();
    expect(screen.getByTestId('team-chat-search-input')).toBeTruthy();
  });

  it('scopes hits to the team and jumps with the hit as the target message', async () => {
    wire.search.invoke.mockResolvedValue({
      items: [
        hit(),
        hit({ message_id: 'msg-2', conversation: { id: 'other', name: 'Other', extra: { teamId: 'team-2' } } }),
      ],
    });
    renderSearch();
    await userEvent.click(screen.getByTestId('team-chat-search-trigger'));
    fireEvent.change(screen.getByTestId('team-chat-search-input'), { target: { value: 'pricing' } });
    await waitFor(() => expect(screen.getByTestId('team-chat-search-hit')).toBeTruthy());
    // The other team's hit was filtered out client-side.
    expect(screen.getAllByTestId('team-chat-search-hit')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('team-chat-search-hit'));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/conversation/conv-1|msg-1'));
  });

  it('says no hits honestly when the team has no match', async () => {
    wire.search.invoke.mockResolvedValue({ items: [hit({ preview_text: 'nothing here' })] });
    renderSearch();
    await userEvent.click(screen.getByTestId('team-chat-search-trigger'));
    fireEvent.change(screen.getByTestId('team-chat-search-input'), { target: { value: 'pricing' } });
    await waitFor(() => expect(screen.getByText('team.search.noHits')).toBeTruthy());
  });
});
