/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  resetTeamWorkbenchStoreForTest,
  useTeamRosterSnapshot,
  useTeamWorkbenchSnapshot,
} from '@/renderer/pages/workbench/team/teamStore';
import type { ITeamTaskItem, TTeam } from '@/common/types/team/teamTypes';

const seed = vi.hoisted(() => ({ ensureTeamDispatchSeeded: vi.fn(async (): Promise<void> => {}) }));
vi.mock('@renderer/pages/workbench/team/teamDispatchSeed', () => seed);

/** Captured wire handlers and API answers: the store's subscriptions land here. */
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
    currentUser: { invoke: vi.fn(async () => ({ id: 'u1', username: 'u' })) },
    teamList: { invoke: vi.fn() },
    listTasks: { invoke: vi.fn() },
    listActivity: { invoke: vi.fn() },
  };
});

vi.mock('@/common', () => ({
  ipcBridge: {
    auth: { currentUser: wire.currentUser },
    team: {
      list: wire.teamList,
      listTasks: wire.listTasks,
      listActivity: wire.listActivity,
      listChanged: wire.emitter('listChanged'),
      created: wire.emitter('created'),
      removed: wire.emitter('removed'),
      taskChanged: wire.emitter('taskChanged'),
      mailboxChanged: wire.emitter('mailboxChanged'),
    },
    realtime: { reconnected: wire.emitter('reconnected') },
  },
}));

const team = (id: string, name: string): TTeam => ({
  id,
  user_id: 'u1',
  name,
  workspace: 'E:/w',
  workspace_mode: 'isolated',
  leader_assistant_id: 's1',
  assistants: [],
  created_at: 1,
  updated_at: 1,
});

const task = (id: string, status: string): ITeamTaskItem => ({
  id,
  team_id: 't1',
  subject: id,
  status,
  owner: 's1',
  blocked_by: [],
  blocks: [],
  created_at: 1,
  updated_at: 2,
});

const flushAsync = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('teamStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTeamWorkbenchStoreForTest();
    wire.teamList.invoke.mockImplementation(async () => [team('t1', 'Alpha')]);
    wire.listTasks.invoke.mockImplementation(async () => [task('tk1', 'in_progress')]);
    wire.listActivity.invoke.mockImplementation(async () => ({ items: [], has_more: false }));
  });

  it('a roster-only subscribe loads the list but no per-team pages', async () => {
    const { result } = renderHook(() => useTeamRosterSnapshot());
    await waitFor(() => expect(result.current.teams.map((item) => item.id)).toEqual(['t1']));
    expect(wire.listTasks.invoke).not.toHaveBeenCalled();
    expect(wire.listActivity.invoke).not.toHaveBeenCalled();
  });

  it('a workbench subscribe after the roster loads the missing pages', async () => {
    const roster = renderHook(() => useTeamRosterSnapshot());
    await waitFor(() => expect(roster.result.current.teams).toHaveLength(1));
    renderHook(() => useTeamWorkbenchSnapshot());
    await waitFor(() => expect(wire.listTasks.invoke).toHaveBeenCalledWith({ team_id: 't1' }));
    await waitFor(() =>
      expect(wire.listActivity.invoke).toHaveBeenCalledWith(expect.objectContaining({ team_id: 't1' }))
    );
    roster.unmount();
  });

  it('loads teams and tasks on first subscribe', async () => {
    const { result } = renderHook(() => useTeamWorkbenchSnapshot());
    await flushAsync();
    expect(result.current.teams.map((item) => item.id)).toEqual(['t1']);
    expect(wire.teamList.invoke).toHaveBeenCalledWith({ user_id: 'u1' });
    expect(wire.listTasks.invoke).toHaveBeenCalledWith({ team_id: 't1' });
    expect(result.current.tasksByTeam.get('t1')?.map((item) => item.id)).toEqual(['tk1']);
  });

  it('loads the team’s mailbox messages oldest-first on first subscribe', async () => {
    const message = (id: string, from: string, type: string) => ({
      id,
      team_id: 't1',
      from_agent_id: from,
      to_agent_id: 's2',
      msg_type: type,
      content: `text-${id}`,
      files: [],
      read: false,
      created_at: Number(id.slice(1)),
    });
    wire.listActivity.invoke.mockImplementation(async () => ({
      // Newest first, as the backend answers: the store reverses to oldest first.
      items: [
        { kind: 'message', id: 'm3', created_at: 3, message: message('m3', 's2', 'message') },
        { kind: 'task', id: 'tk', created_at: 2, task },
        { kind: 'message', id: 'm1', created_at: 1, message: message('m1', 's2', 'message') },
      ],
      has_more: false,
    }));
    const { result } = renderHook(() => useTeamWorkbenchSnapshot());
    await flushAsync();
    expect(wire.listActivity.invoke).toHaveBeenCalledWith(expect.objectContaining({ team_id: 't1', kind: 'message' }));
    expect(result.current.mailboxByTeam.get('t1')?.map((item) => item.id)).toEqual(['m1', 'm3']);
  });

  it('mailboxChanged (created) invalidates the team, read events do not', async () => {
    renderHook(() => useTeamWorkbenchSnapshot());
    await flushAsync();
    wire.listActivity.invoke.mockClear();
    wire.handlers['mailboxChanged']?.({ team_id: 't1', change: 'read' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(wire.listActivity.invoke).not.toHaveBeenCalled();
    wire.handlers['mailboxChanged']?.({ team_id: 't1', change: 'created' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(wire.listActivity.invoke).toHaveBeenCalledTimes(1);
  });

  it('taskChanged invalidates the named team only, coalesced', async () => {
    renderHook(() => useTeamWorkbenchSnapshot());
    await flushAsync();
    wire.listTasks.invoke.mockClear();
    wire.handlers['taskChanged']?.({ team_id: 't1' });
    wire.handlers['taskChanged']?.({ team_id: 't1' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(wire.listTasks.invoke).toHaveBeenCalledTimes(1);
  });

  it('ignores invalidation for teams it does not know', async () => {
    renderHook(() => useTeamWorkbenchSnapshot());
    await flushAsync();
    wire.listTasks.invoke.mockClear();
    wire.handlers['taskChanged']?.({ team_id: 'ghost' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(wire.listTasks.invoke).not.toHaveBeenCalled();
  });

  it('removed drops the team and its data at once', async () => {
    const { result } = renderHook(() => useTeamWorkbenchSnapshot());
    await flushAsync();
    wire.handlers['removed']?.({ team_id: 't1' });
    await flushAsync();
    expect(result.current.teams).toHaveLength(0);
    expect(result.current.tasksByTeam.get('t1')).toBeUndefined();
  });

  it('reconnected triggers a full refresh', async () => {
    renderHook(() => useTeamWorkbenchSnapshot());
    await flushAsync();
    wire.teamList.invoke.mockClear();
    wire.handlers['reconnected']?.({});
    await flushAsync();
    expect(wire.teamList.invoke).toHaveBeenCalled();
  });

  it('asks to seed every fetched team, on every fetch (the seed module dedupes)', async () => {
    renderHook(() => useTeamWorkbenchSnapshot());
    await flushAsync();
    expect(seed.ensureTeamDispatchSeeded).toHaveBeenCalledTimes(1);
    expect(seed.ensureTeamDispatchSeeded).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', workspace: 'E:/w' })
    );
    // A refetch of the same teams (created, listChanged, reconnect) asks again.
    wire.handlers['created']?.({ team_id: 't1', team_name: 'Alpha' });
    await flushAsync();
    expect(seed.ensureTeamDispatchSeeded).toHaveBeenCalledTimes(2);
  });
});
