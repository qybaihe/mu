/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The workbench-record entry on the team header identity: one click opens the
 * read-only modal of the workspace HANDOFF.md — the content rendered as
 * markdown, the no-record-yet empty state, and the failed-read error state.
 * The bridge is mocked; i18n keys render as themselves.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamHandoffResult } from '@/common/chat/team/teamWorkspace/handoffBridge';

let answer: { ok: true; data: TeamHandoffResult } | { ok: false; error: string };

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
// The real Markdown renders into shadow DOM with live contexts; the modal's
// contract here is that the record's text reaches it, not how markdown draws.
vi.mock('@renderer/components/Markdown', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <div data-testid='markdown-mock'>{children}</div>,
}));
vi.mock('@/common/chat/team/teamWorkspace/handoffBridge', () => ({
  teamWorkspaceBridge: { readHandoff: { invoke: vi.fn(async () => answer) } },
}));
import TeamWorkspaceHandoff from '@renderer/pages/team/components/TeamWorkspaceHandoff';
import type { TTeam } from '@/common/types/team/teamTypes';

afterEach(cleanup);

const team: TTeam = {
  id: 't1',
  user_id: 'u1',
  name: '货代小队',
  workspace: 'C:/data/teams/货代小队',
  workspace_mode: 'shared',
  leader_assistant_id: 'lead',
  assistants: [],
  created_at: 1,
  updated_at: 1,
};

const open = async (): Promise<void> => {
  fireEvent.click(screen.getByTestId('team-handoff-entry'));
  await waitFor(() => {
    if (screen.queryByTestId('team-handoff-loading')) throw new Error('still loading');
  });
};

describe('TeamWorkspaceHandoff', () => {
  it('renders the record as markdown when the file has content', async () => {
    answer = { ok: true, data: { status: 'ok', content: '# 交接\n\n## 当前目标\n查重客户', truncated: false } };
    render(<TeamWorkspaceHandoff team={team} />);
    await open();
    const body = screen.getByTestId('team-handoff-content');
    expect(body.textContent).toContain('交接');
    expect(body.textContent).toContain('查重客户');
  });

  it('shows the empty state when the team has no record yet', async () => {
    answer = { ok: true, data: { status: 'missing' } };
    render(<TeamWorkspaceHandoff team={team} />);
    await open();
    expect(screen.getByTestId('team-handoff-empty').textContent).toContain('team.handoff.missing');
  });

  it('shows the error state when the read fails', async () => {
    answer = { ok: false, error: 'boom' };
    render(<TeamWorkspaceHandoff team={team} />);
    await open();
    expect(screen.getByTestId('team-handoff-error').textContent).toContain('team.handoff.error');
  });

  it('flags a truncated record', async () => {
    answer = { ok: true, data: { status: 'ok', content: '# 交接', truncated: true } };
    render(<TeamWorkspaceHandoff team={team} />);
    await open();
    expect(screen.getByText('team.handoff.truncated')).toBeTruthy();
  });
});
