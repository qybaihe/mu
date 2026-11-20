/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A team conversation's identity chip in the header: the member strip (one
 * initial per slot, overflowing into a count) and the pill that says which
 * kind of thread this is — the group chat itself for the lead, a member
 * thread otherwise. The store's roster is its only input.
 */
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TTeam } from '@/common/types/team/teamTypes';

let teams: TTeam[] = [];

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
// The manager is its own test's subject; here it is a stub the presence checks see.
vi.mock('@/renderer/pages/team/components/TeamMembersManager', () => ({
  default: () => <div data-testid='team-members-manager-stub' />,
}));
// The workbench record is its own test's subject too; the stub keeps MuModal's
// theme context out of this file's render.
vi.mock('@/renderer/pages/team/components/TeamWorkspaceHandoff', () => ({
  default: () => <div data-testid='team-handoff-stub' />,
}));
// The deliverables browser is its own test's subject; a stub here as well.
vi.mock('@/renderer/pages/team/components/TeamDeliverables', () => ({
  default: () => <div data-testid='team-deliverables-stub' />,
}));
import TeamHeaderIdentity from '@/renderer/pages/team/components/TeamHeaderIdentity';

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
  name: '货代周会摘要复核',
  workspace: 'E:/w',
  workspace_mode: 'isolated',
  leader_assistant_id: 'lead',
  assistants,
  created_at: 1,
  updated_at: 1,
});

describe('TeamHeaderIdentity', () => {
  beforeEach(() => {
    teams = [team([member('lead', '货代', 'leader'), member('m2', '评审', 'teammate')])];
  });
  afterEach(() => cleanup());

  it('says the group chat on the lead, with one initial per member', async () => {
    render(<TeamHeaderIdentity teamId='t1' role='lead' />);
    const chip = await screen.findByTestId('team-header-identity');
    expect(chip.textContent).toContain('货');
    expect(chip.textContent).toContain('评');
    expect(screen.getByTestId('team-header-identity-pill').textContent).toBe('team.header.groupChatPill:count=2');
  });

  it('says a member thread on a teammate conversation — without the member manager', async () => {
    render(<TeamHeaderIdentity teamId='t1' role='teammate' />);
    expect(await screen.findByTestId('team-header-identity-pill')).toHaveTextContent('team.header.teamPill:count=2');
    expect(screen.queryByTestId('team-members-manager-stub')).toBeNull();
  });

  it('offers member management on the group chat itself', async () => {
    render(<TeamHeaderIdentity teamId='t1' role='lead' />);
    expect(await screen.findByTestId('team-members-manager-stub')).toBeInTheDocument();
  });

  it('summarizes members beyond three as a count', async () => {
    teams = [
      team([
        member('lead', '甲', 'leader'),
        member('m2', '乙', 'teammate'),
        member('m3', '丙', 'teammate'),
        member('m4', '丁', 'teammate'),
      ]),
    ];
    render(<TeamHeaderIdentity teamId='t1' role='lead' />);
    const chip = await screen.findByTestId('team-header-identity');
    expect(chip.textContent).toContain('甲');
    expect(chip.textContent).not.toContain('丁');
    expect(chip.textContent).toContain('+1');
    expect(screen.getByTestId('team-header-identity-pill').textContent).toBe('team.header.groupChatPill:count=4');
  });

  it('renders nothing for a team the roster does not hold (yet, or anymore)', async () => {
    const { container } = render(<TeamHeaderIdentity teamId='gone' role='lead' />);
    await waitFor(() => expect(container.querySelector('[data-testid="team-header-identity"]')).toBeNull());
  });
});
