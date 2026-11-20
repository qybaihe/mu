/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One run's changed-files row: the counter chip, the list one click open, and
 * each file a click into the preview (the team's workspace is the base).
 * i18n is mocked to the key with interpolations inlined.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamChangedFilesNote } from '@renderer/pages/team/core/notes/teamChangedFileNotes';

const opened = vi.hoisted(() => [] as string[]);

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
  useTeamRosterSnapshot: () => ({ teams: [{ id: 't1', workspace: 'C:/w' }], loading: false, error: null }),
}));
vi.mock('@/renderer/pages/conversation/Preview/hooks/useLocalFilePreview', () => ({
  useOptionalLocalFilePreview: () => async (path: string) => {
    opened.push(path);
  },
}));
import TeamChangedFilesRow from '@renderer/pages/team/components/TeamChangedFilesRow';

afterEach(() => {
  cleanup();
  opened.length = 0;
});

const note: TeamChangedFilesNote = {
  id: 'n1',
  conversationId: 'lead-conv',
  teamId: 't1',
  teamRunId: 'r1',
  createdAt: 100,
  files: [
    { path: 'C:/w/out/report.html', name: 'report.html' },
    { path: 'C:/w/HANDOFF.md', name: 'HANDOFF.md' },
  ],
};

describe('TeamChangedFilesRow', () => {
  it('shows the counter, and the files only once expanded', () => {
    render(<TeamChangedFilesRow note={note} />);
    expect(screen.getByTestId('team-changed-files-count').textContent).toBe('team.changedFiles.title:count=2');
    expect(screen.queryByTestId('team-changed-files-list')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('team-changed-files-toggle'));
    expect(screen.getAllByTestId('team-changed-files-file').map((row) => row.dataset.path)).toEqual([
      'C:/w/out/report.html',
      'C:/w/HANDOFF.md',
    ]);
    fireEvent.click(screen.getByTestId('team-changed-files-toggle'));
    expect(screen.queryByTestId('team-changed-files-list')).not.toBeInTheDocument();
  });

  it('opens one file in the preview with a click', async () => {
    render(<TeamChangedFilesRow note={note} />);
    fireEvent.click(screen.getByTestId('team-changed-files-toggle'));
    fireEvent.click(screen.getAllByTestId('team-changed-files-file')[0]);
    await waitFor(() => expect(opened).toEqual(['C:/w/out/report.html']));
  });

  it('carries the folder beside each name for context', () => {
    render(<TeamChangedFilesRow note={note} />);
    fireEvent.click(screen.getByTestId('team-changed-files-toggle'));
    const rows = screen.getAllByTestId('team-changed-files-file');
    expect(rows[0].textContent).toContain('C:/w/out');
    expect(rows[1].textContent).toContain('HANDOFF.md');
  });
});
