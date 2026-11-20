/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The changed-files machinery under the group chat's row: which stored rows
 * count as a touched file (writes only, finished only, inside the run's
 * window, one entry per path), the note store it lands in, and the controller
 * that turns run events into notes — including the honest degradations: a run
 * whose start was never seen falls back to the last note's time, and with
 * neither, no note at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendTeamChangedFilesNote,
  changedFileRowsFrom,
  createTeamChangedFilesController,
  fileNameOf,
  lastChangedFilesNoteAtOf,
  resetTeamChangedFileNotesForTest,
  teamChangedFileNotesOf,
  AGGREGATE_DELAY_MS,
  type ChangedFilesControllerDeps,
  type ChangedFilesRunEvent,
  type TeamChangedFilesNote,
} from '@renderer/pages/team/core/notes/teamChangedFileNotes';

afterEach(() => {
  resetTeamChangedFileNotesForTest();
  vi.restoreAllMocks();
});

/** A stored tool-call row, as the conversation pages hand it over. */
const row = (over: Record<string, unknown>): unknown => ({
  id: `call-${Math.random().toString(36).slice(2, 8)}`,
  type: 'acp_tool_call',
  created_at: 1000,
  content: {
    session_id: 'c',
    update: { session_update: 'tool_call', tool_call_id: 't', status: 'completed', ...over },
  },
});

const write = (path: string, at: number): unknown => ({
  ...row({ title: 'write', raw_input: { path }, locations: [{ path }] }),
  created_at: at,
});

const editViaLocation = (path: string, at: number): unknown => ({
  ...row({ title: 'edit', raw_input: {}, locations: [{ path }] }),
  created_at: at,
});

describe('changedFileRowsFrom', () => {
  it('collects finished write and edit calls inside the window, one entry per path', () => {
    const rows = [
      write('C:/w/a.md', 1100),
      write('C:/w/a.md', 1300),
      editViaLocation('C:\\w\\b.ts', 1200),
      row({ title: 'write', status: 'failed', raw_input: { path: 'C:/w/c.md' } }),
      row({ title: 'read', raw_input: { path: 'C:/w/d.md' } }),
      row({ title: 'bash', raw_input: { command: 'echo hi' } }),
      { type: 'text', created_at: 1150, content: 'hello' },
    ];
    const entries = changedFileRowsFrom(rows, 1000);
    expect(entries).toHaveLength(2);
    const a = entries.find((entry) => entry.path === 'C:/w/a.md');
    expect(a).toEqual({ path: 'C:/w/a.md', firstAt: 1100, lastAt: 1300 });
    const b = entries.find((entry) => entry.path.startsWith('C:\\w\\b'));
    expect(b?.firstAt).toBe(1200);
  });

  it('keeps separator variants of one path as one entry, and drops rows outside the window', () => {
    const rows = [write('C:/w/out/x.html', 900), write('C:\\w\\out\\x.html', 1500), write('C:/w/y.md', 1600)];
    const entries = changedFileRowsFrom(rows, 1000, 2000);
    expect(entries).toHaveLength(2);
    const x = entries.find((entry) => fileNameOf(entry.path) === 'x.html');
    expect(x?.firstAt).toBe(1500);
    expect(x?.lastAt).toBe(1500);
  });

  it('ignores write calls whose path cannot be read', () => {
    const entries = changedFileRowsFrom([row({ title: 'write', raw_input: {} }), row({ title: 'edit' })], 0);
    expect(entries).toEqual([]);
  });
});

describe('the note store', () => {
  const note = (id: string, teamId: string, at: number): TeamChangedFilesNote => ({
    id,
    conversationId: 'lead-conv',
    teamId,
    teamRunId: `run-${id}`,
    createdAt: at,
    files: [{ path: 'C:/w/a.md', name: 'a.md' }],
  });

  it('keeps one conversation’s notes oldest first, and answers a team’s latest note time', () => {
    appendTeamChangedFilesNote(note('n1', 't1', 100));
    appendTeamChangedFilesNote(note('other', 't2', 200));
    appendTeamChangedFilesNote(note('n2', 't1', 300));
    expect(teamChangedFileNotesOf('lead-conv').map((entry) => entry.id)).toEqual(['n1', 'other', 'n2']);
    expect(teamChangedFileNotesOf('somewhere-else')).toEqual([]);
    expect(lastChangedFilesNoteAtOf('t1')).toBe(300);
    expect(lastChangedFilesNoteAtOf('t9')).toBeUndefined();
  });

  it('survives a reset like a reload would', () => {
    appendTeamChangedFilesNote(note('n1', 't1', 100));
    resetTeamChangedFileNotesForTest();
    expect(teamChangedFileNotesOf('lead-conv')).toEqual([]);
    expect(lastChangedFilesNoteAtOf('t1')).toBeUndefined();
  });
});

describe('the run controller', () => {
  const run = (teamId: string, runId: string): ChangedFilesRunEvent => ({ team_id: teamId, team_run_id: runId });

  const deps = (
    over: Partial<ChangedFilesControllerDeps> = {}
  ): ChangedFilesControllerDeps & {
    notes: TeamChangedFilesNote[];
    rowsByConversation: Map<string, readonly unknown[]>;
    teams: Map<string, { leadConversationId: string; conversationIds: string[] }>;
  } => {
    let clock = 5000;
    const notes: TeamChangedFilesNote[] = [];
    const rowsByConversation = new Map<string, readonly unknown[]>([
      ['lead-conv', [write('C:/w/lead.md', 5000)]],
      ['mate-conv', [write('C:/w/mate.md', 5001), write('C:/w/old.md', 300)]],
    ]);
    const teams = new Map<string, { leadConversationId: string; conversationIds: string[] }>([
      ['t1', { leadConversationId: 'lead-conv', conversationIds: ['lead-conv', 'mate-conv'] }],
    ]);
    const base: ChangedFilesControllerDeps = {
      now: () => clock,
      sleep: async () => {
        clock += 1;
      },
      loadRows: async (id) => rowsByConversation.get(id) ?? [],
      teamConversationsOf: async (id) => teams.get(id),
      appendNote: (entry) => notes.push(entry),
      lastNoteAtOf: () => undefined,
      ...over,
    };
    return { ...base, notes, rowsByConversation, teams };
  };

  it('notes a finished run’s files, both conversations merged, deduped per run', async () => {
    const d = deps();
    const controller = createTeamChangedFilesController(d);
    controller.onRunAccepted(run('t1', 'r1'));
    controller.onRunStarted(run('t1', 'r1'));
    controller.onRunCompleted(run('t1', 'r1'));
    controller.onRunCompleted(run('t1', 'r1')); // a replayed terminal event
    await vi.waitFor(() => expect(d.notes).toHaveLength(1));
    const note = d.notes[0];
    expect(note.conversationId).toBe('lead-conv');
    expect(note.teamRunId).toBe('r1');
    expect(note.files.map((file) => file.name).sort()).toEqual(['lead.md', 'mate.md']);
    expect(note.files.every((file) => file.name === fileNameOf(file.path))).toBe(true);
  });

  it('never notes a run that touched nothing', async () => {
    const d = deps({ loadRows: async () => [row({ title: 'read', raw_input: { path: 'C:/w/x' } })] });
    const controller = createTeamChangedFilesController(d);
    controller.onRunStarted(run('t1', 'r2'));
    controller.onRunCompleted(run('t1', 'r2'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(d.notes).toEqual([]);
  });

  it('falls back to the last note’s time when the run’s start was never seen, and skips without one', async () => {
    const d = deps({ lastNoteAtOf: () => 5100 });
    const controller = createTeamChangedFilesController(d);
    controller.onRunCompleted(run('t1', 'r3')); // reloaded mid-run
    await vi.waitFor(() => expect(d.notes).toHaveLength(1));
    expect(d.notes[0].files.map((file) => file.name)).toEqual(['lead.md', 'mate.md']); // old.md at 300 is outside

    const d2 = deps();
    const controller2 = createTeamChangedFilesController(d2);
    controller2.onRunCompleted(run('t1', 'r4'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(d2.notes).toEqual([]);
  });

  it('skips events without ids, and forgets nothing when a team cannot be resolved', async () => {
    const d = deps({ teamConversationsOf: async () => undefined });
    const controller = createTeamChangedFilesController(d);
    controller.onRunStarted({ team_id: '', team_run_id: '' });
    controller.onRunCompleted({ team_id: 't1', team_run_id: 'r5' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(d.notes).toEqual([]);
  });
});
