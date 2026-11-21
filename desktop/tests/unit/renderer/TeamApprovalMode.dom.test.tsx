/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The group header's approval-tier select (batch L ③): it reads the per-team
 * map (risk-only when absent), shows the three tiers, and a pick persists
 * the setting and seeds the workspace block; a seeding failure rolls the
 * select back to what it showed.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TTeam } from '@/common/types/team/teamTypes';

const state = vi.hoisted(() => ({
  modes: undefined as Record<string, 'risk-only' | 'all' | 'none'> | undefined,
  setCalls: [] as Array<Record<string, 'risk-only' | 'all' | 'none'>>,
  seedApproval: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/services/clientBusinessSettings', () => ({
  getClientBusinessSetting: vi.fn(async () => state.modes),
  setClientBusinessSetting: vi.fn(async (_key: string, value: Record<string, 'risk-only' | 'all' | 'none'>) => {
    state.setCalls.push(value);
    state.modes = value;
  }),
}));
vi.mock('@/common/chat/team/teamDispatch/dispatchSeedBridge', () => ({
  dispatchSeedBridge: { seedApproval: { invoke: (...args: unknown[]) => state.seedApproval(...args) } },
}));
import TeamApprovalMode from '@renderer/pages/team/components/TeamApprovalMode';

const team: TTeam = {
  id: 't1',
  user_id: 'u1',
  name: '测试群',
  workspace: 'E:/data/teams/测试群',
  workspace_mode: 'shared',
  leader_assistant_id: 's1',
  assistants: [],
  created_at: 1,
  updated_at: 1,
};

describe('TeamApprovalMode', () => {
  beforeEach(() => {
    state.modes = undefined;
    state.setCalls = [];
    state.seedApproval.mockReset();
    state.seedApproval.mockResolvedValue({ ok: true, data: { changed: true } });
  });
  afterEach(() => cleanup());

  it('shows risk-only when the map has no entry for the team', async () => {
    render(<TeamApprovalMode team={team} />);
    const select = await screen.findByTestId('team-approval-mode-select');
    expect(select.textContent).toContain('team.approval.riskOnly');
  });

  it('a pick persists the setting and seeds the workspace block at that tier', async () => {
    render(<TeamApprovalMode team={team} />);
    await screen.findByTestId('team-approval-mode-select');
    fireEvent.click(screen.getByTestId('team-approval-mode-select'));
    fireEvent.click(await screen.findByText('team.approval.none'));
    await waitFor(() => expect(state.setCalls).toHaveLength(1));
    expect(state.setCalls[0]).toEqual({ t1: 'none' });
    await waitFor(() => expect(state.seedApproval).toHaveBeenCalledWith({ workspace: team.workspace, mode: 'none' }));
  });

  it('a seeding failure rolls the select back to what it showed', async () => {
    state.seedApproval.mockResolvedValue({ ok: false, error: 'unwritable', code: 'invalid' });
    render(<TeamApprovalMode team={team} />);
    const select = await screen.findByTestId('team-approval-mode-select');
    expect(select.textContent).toContain('team.approval.riskOnly');
    fireEvent.click(screen.getByTestId('team-approval-mode-select'));
    fireEvent.click(await screen.findByText('team.approval.all'));
    await waitFor(() => expect(state.seedApproval).toHaveBeenCalled());
    // The optimistic pick showed all; the failure returns it to risk-only.
    await waitFor(() =>
      expect(screen.getByTestId('team-approval-mode-select').textContent).toContain('team.approval.riskOnly')
    );
  });
});
