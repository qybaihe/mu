/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The sidebar's team section as it stands in the Sider: a row per team
 * (named by the team, badged with its member count), the fold that persists,
 * retired teams dimmed after the active ones, and a row's click landing in
 * the team's lead conversation. The roster merge itself lives in its own
 * test; this is the section between it and the router.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupervisorTeam } from '@/common/chat/team/supervisor/supervisorCore';
import type { TTeam } from '@/common/types/team/teamTypes';

let teams: TTeam[] = [];
let index: SupervisorTeam[] = [];
let positions: { name: string; displayName: string; description: string }[] = [];
let newGroupChatClicks = 0;

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
vi.mock('@/renderer/pages/team/core/teamStore', () => ({
  useTeamRosterSnapshot: () => ({ teams, loading: false, error: null }),
}));
vi.mock('@/renderer/pages/positions/usePositionRoster', () => ({
  usePositionRoster: () => ({ positions, isLoading: false }),
}));
vi.mock('@/common/chat/team/supervisor/supervisorBridge', () => ({
  supervisorBridge: {
    teams: { invoke: vi.fn(async () => ({ ok: true as const, data: { teams: index } })) },
  },
}));
import SiderTeamsGroup from '@renderer/components/layout/Sider/SiderNav/SiderTeamsGroup';

const team = (id: string, name: string, leadConversationId: string, updatedAt: number): TTeam => ({
  id,
  user_id: 'u1',
  name,
  workspace: 'E:/w',
  workspace_mode: 'isolated',
  leader_assistant_id: 's-lead',
  assistants: [
    {
      slot_id: 's-lead',
      conversation_id: leadConversationId,
      role: 'leader',
      assistant_backend: 'acp',
      assistant_name: '货代',
      status: 'idle',
    },
    {
      slot_id: 's-2',
      conversation_id: `${id}-m`,
      role: 'teammate',
      assistant_backend: 'acp',
      assistant_name: '评审',
      status: 'idle',
    },
  ],
  created_at: 1,
  updated_at: updatedAt,
});

const indexEntry = (teamId: string, expiresAt: number, permanent = false): SupervisorTeam => ({
  name: teamId,
  positions: [],
  createdAt: 1,
  lastUsedAt: 1,
  expiresAt,
  ttlDays: 7,
  permanent,
  teamId,
  leadConversationId: `${teamId}-lead`,
});

const Where: React.FC = () => {
  const location = useLocation();
  return <div data-testid='where'>{location.pathname}</div>;
};

const renderSection = (route = '/guid') =>
  render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route
          path='*'
          element={
            <>
              <SiderTeamsGroup onNewGroupChat={() => (newGroupChatClicks += 1)} />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );

const row = (id: string) => screen.getByTestId(`sider-team-${id}`);

describe('SiderTeamsGroup', () => {
  beforeEach(() => {
    teams = [];
    index = [];
    positions = [{ name: 'forwarder', displayName: '货代', description: '货代岗' }];
    newGroupChatClicks = 0;
    localStorage.removeItem('sider-teams-folded');
  });
  afterEach(() => cleanup());

  it('renders nothing without teams and without positions to build a group from', () => {
    positions = [];
    const { container } = renderSection();
    expect(container.querySelector('[data-testid="sider-teams"]')).toBeNull();
  });

  it('with no teams yet, still shows the header and its new-group-chat entry — the one way in', async () => {
    const user = userEvent.setup();
    renderSection();
    expect(screen.getByTestId('sider-new-group-chat')).toBeInTheDocument();
    expect(screen.queryByTestId('sider-team-t1')).toBeNull();
    await user.click(screen.getByTestId('sider-new-group-chat'));
    expect(newGroupChatClicks).toBe(1);
  });

  it('opens the new-group-chat entry from a populated section too, without folding it', async () => {
    teams = [team('t1', '队', 'c-lead', 1)];
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByTestId('sider-new-group-chat'));
    expect(newGroupChatClicks).toBe(1);
    expect(row('t1')).toBeVisible();
  });

  it('shows one row per team — the team name and member count, not the conversation name', () => {
    teams = [team('t1', '货代周会摘要复核', 'c-lead', 10)];
    renderSection();
    expect(row('t1').textContent).toContain('货代周会摘要复核');
    expect(screen.getByTestId('sider-team-t1-count').textContent).toBe('team.sider.memberCount:count=2');
    expect(row('t1').textContent).not.toContain('群聊）');
    expect(screen.getByTestId('sider-teams-count').textContent).toBe('×1');
  });

  it('dims retired teams, lists them after the active ones, and says so in the label', async () => {
    teams = [team('old', '旧队', 'old-lead', 99), team('live', '现役队', 'live-lead', 1)];
    index = [indexEntry('old', 1), indexEntry('live', 999_999_999_999_999)];
    renderSection();
    // The lifecycle index arrives async; the retired dimming says it landed.
    await waitFor(() => expect(row('old').className).toContain('opacity-50'));
    // DOM order says the section's order: the active team's row comes first.
    const activeRow = row('live');
    const retiredRow = row('old');
    expect(activeRow.compareDocumentPosition(retiredRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(retiredRow.getAttribute('aria-label')).toContain('team.sider.retired');
    expect(activeRow.className).not.toContain('opacity-50');
    expect(screen.getByTestId('sider-teams-count').textContent).toBe('×1');
  });

  it('folds and unfolds, and the fold persists across mounts', async () => {
    teams = [team('t1', '队', 'c-lead', 1)];
    const user = userEvent.setup();
    const { unmount } = renderSection();
    expect(row('t1')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'team.sider.titleA11y:count=1' }));
    expect(screen.queryByTestId('sider-team-t1')).toBeNull();
    expect(localStorage.getItem('sider-teams-folded')).toBe('1');
    unmount();

    const second = renderSection();
    expect(second.queryByTestId('sider-team-t1')).toBeNull();
    fireEvent.click(second.getByRole('button', { name: 'team.sider.titleA11y:count=1' }));
    expect(second.getByTestId('sider-team-t1')).toBeVisible();
    expect(localStorage.getItem('sider-teams-folded')).toBe('0');
  });

  it("opens the team's lead conversation on click, and highlights the team holding the route", async () => {
    teams = [team('t1', '队', 'c-lead', 1)];
    const user = userEvent.setup();
    renderSection('/conversation/c-lead');
    expect(row('t1').className).toContain('bg-fill-3');
    await user.click(row('t1'));
    expect(screen.getByTestId('where').textContent).toBe('/conversation/c-lead');
  });

  it('marks a member conversation of the team as active too', () => {
    teams = [team('t1', '队', 'c-lead', 1)];
    renderSection('/conversation/t1-m');
    expect(row('t1').className).toContain('bg-fill-3');
  });
});
