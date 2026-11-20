/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The monitor page between its data and the router: the two walls render
 * their cards (states, member dots, progress, TTL), the retired tail folds,
 * and every card's click is the way back to the work — the position's
 * session, the group chat itself.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import type { TTeam } from '@/common/types/team/teamTypes';
import type { TeamRosterEntry } from '@renderer/pages/team/core/teamIdentity';
import type { PositionCard, TeamCard, TeamWall } from '@renderer/pages/monitor/monitorCore';
import type { MonitorOverview } from '@renderer/pages/monitor/useMonitorOverview';
import styles from '@renderer/pages/monitor/MonitorPage.module.css';

let overview: MonitorOverview;
const openPosition = vi.fn();
const openSupervisor = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params === undefined
        ? key
        : `${key}:${Object.entries(params)
            .map(([name, value]) => `${name}=${value}`)
            .join(',')}`,
  }),
}));
vi.mock('@renderer/pages/monitor/useMonitorOverview', () => ({
  useMonitorOverview: () => overview,
}));
vi.mock('@renderer/hooks/context/ConversationHistoryContext', () => ({
  useConversationHistoryContext: () => ({ conversations: [] }),
}));
vi.mock('@renderer/hooks/assistant/useAssistantList', () => ({
  useAssistantList: () => ({ assistants: [], assistantOrder: [] }),
}));
vi.mock('@renderer/utils/model/assistantSelection', () => ({
  selectableAssistants: () => [],
}));
vi.mock('@renderer/pages/positions/openPosition', () => ({
  useOpenPosition: () => openPosition,
}));
vi.mock('@renderer/pages/positions/openSupervisor', () => ({
  useOpenSupervisor: () => openSupervisor,
}));
import MonitorPage from '@renderer/pages/monitor/MonitorPage';

const position = (name: string, displayName: string): PositionInfo => ({
  name,
  displayName,
  description: '',
  body: '',
});

const positionCard = (source: PositionInfo, patch: Partial<PositionCard> = {}): PositionCard => ({
  position: source,
  conversationId: `c-${source.name}`,
  state: 'idle',
  currentTask: undefined,
  inProgressCount: 0,
  lastActiveAt: undefined,
  ...patch,
});

const team = (id: string): TTeam => ({
  id,
  user_id: 'u1',
  name: `队${id}`,
  workspace: 'E:/w',
  workspace_mode: 'isolated',
  leader_assistant_id: 's1',
  assistants: [],
  created_at: 1,
  updated_at: 2,
});

const rosterEntry = (
  source: TTeam,
  leadConversationId: string,
  retired: boolean,
  expiresAt?: number
): TeamRosterEntry => ({
  team: source,
  memberCount: 1,
  leadConversationId,
  conversationIds: [leadConversationId],
  retired,
  expiresAt,
});

const teamCard = (entry: TeamRosterEntry, patch: Partial<TeamCard> = {}): TeamCard => ({
  entry,
  members: [{ name: '货代', kind: 'idle' as const, isLead: true }],
  running: false,
  counts: { todo: 0, inProgress: 0, done: 0 },
  ttlDays: undefined,
  ...patch,
});

const Where: React.FC = () => {
  const location = useLocation();
  return <div data-testid='where'>{location.pathname}</div>;
};

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/monitor']}>
      <Routes>
        <Route
          path='*'
          element={
            <>
              <MonitorPage />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );

describe('MonitorPage', () => {
  beforeEach(() => {
    openPosition.mockClear();
    openSupervisor.mockClear();
  });
  afterEach(cleanup);

  it('renders the position wall with state, current task and in-progress count', () => {
    const forwarder = position('forwarder', '货代');
    overview = {
      positionCards: [
        positionCard(forwarder, {
          state: 'working',
          currentTask: '查 CNS 客户名单',
          inProgressCount: 2,
          lastActiveAt: 1,
        }),
        positionCard(position('reviewer', '评审')),
        positionCard(position('checker', '复核'), { state: 'waiting' }),
      ],
      teamWall: { active: [], retired: [] } satisfies TeamWall,
      activeCount: 1,
      positionCount: 3,
      activeTeamCount: 0,
      loading: false,
    };
    renderPage();
    expect(screen.getByTestId('monitor-position-forwarder')).toBeTruthy();
    expect(screen.getByTestId('monitor-position-forwarder-state').textContent).toContain(
      'monitor.positions.state.working'
    );
    expect(screen.getByTestId('monitor-position-forwarder')).toHaveClass(styles.cardWorking);
    expect(screen.getByTestId('monitor-position-reviewer')).not.toHaveClass(styles.cardWorking);
    expect(screen.getByTestId('monitor-position-reviewer')).not.toHaveClass(styles.cardWaiting);
    expect(screen.getByTestId('monitor-position-forwarder').textContent).toContain('查 CNS 客户名单');
    expect(screen.getByTestId('monitor-position-forwarder-tasks').textContent).toContain('count=2');
    expect(screen.getByTestId('monitor-position-reviewer-state').textContent).toContain('monitor.positions.state.idle');
    expect(screen.getByTestId('monitor-position-checker')).toHaveClass(styles.cardWaiting);
  });

  it('renders the team wall with members, progress, TTL; the retired tail folds open', () => {
    const active = teamCard(rosterEntry(team('t1'), 'lead-1', false, Date.now() + 86_400_000), {
      members: [
        { name: '货代', kind: 'running', isLead: true },
        { name: '评审', kind: 'queued', isLead: false },
      ],
      running: true,
      counts: { todo: 1, inProgress: 2, done: 3 },
      ttlDays: 1,
    });
    const retired = teamCard(rosterEntry(team('t2'), 'lead-2', true, Date.now() - 86_400_000));
    const nearTtlIdle = teamCard(rosterEntry(team('t3'), 'lead-3', false, Date.now() + 86_400_000), {
      ttlDays: 1,
    });
    overview = {
      positionCards: [],
      teamWall: { active: [active, nearTtlIdle], retired: [retired] },
      activeCount: 1,
      positionCount: 0,
      activeTeamCount: 1,
      loading: false,
    };
    const { container } = renderPage();
    expect(screen.getByTestId('monitor-team-t1').textContent).toContain('货代');
    expect(screen.getByTestId('monitor-team-t1')).toHaveClass(styles.cardWorking);
    expect(screen.getByTestId('monitor-team-t3')).not.toHaveClass(styles.cardWorking);
    expect(screen.getByTestId('monitor-team-t3')).toHaveClass(styles.cardWaiting);
    expect(screen.getByTestId('monitor-team-t1-ttl').textContent).toContain('days=1');
    expect(screen.getByTestId('monitor-team-t1')).not.toHaveClass(styles.cardWaiting);
    expect(screen.getByTestId('monitor-team-t1').textContent).toContain('monitor.teams.todo:count=1');
    expect(screen.queryByTestId('monitor-team-t2')).toBeNull();
    fireEvent.click(screen.getByTestId('monitor-retired-toggle'));
    expect(screen.getByTestId('monitor-team-t2')).toBeTruthy();
    expect(screen.getByTestId('monitor-team-t2')).not.toHaveClass(styles.cardWorking);
    expect(screen.getByTestId('monitor-team-t2')).not.toHaveClass(styles.cardWaiting);
    expect(container.textContent).toContain('monitor.teams.retiredFold:count=1');
  });

  it('clicking a position card opens that position, a team card lands in its group chat', () => {
    const forwarder = position('forwarder', '货代');
    const active = teamCard(rosterEntry(team('t1'), 'lead-9', false));
    overview = {
      positionCards: [positionCard(forwarder)],
      teamWall: { active: [active], retired: [] },
      activeCount: 0,
      positionCount: 1,
      activeTeamCount: 1,
      loading: false,
    };
    renderPage();
    fireEvent.click(screen.getByTestId('monitor-position-forwarder'));
    expect(openPosition).toHaveBeenCalledWith(forwarder);
    fireEvent.click(screen.getByTestId('monitor-team-t1'));
    expect(screen.getByTestId('where').textContent).toBe('/conversation/lead-9');
  });

  it('a fresh install reads the supervisor guidance, its button opens the supervisor', () => {
    overview = {
      positionCards: [],
      teamWall: { active: [], retired: [] },
      activeCount: 0,
      positionCount: 0,
      activeTeamCount: 0,
      loading: false,
    };
    renderPage();
    expect(screen.getByTestId('monitor-page').textContent).toContain('monitor.empty.hint');
    fireEvent.click(screen.getByText('monitor.empty.action'));
    expect(openSupervisor).toHaveBeenCalled();
  });
});
