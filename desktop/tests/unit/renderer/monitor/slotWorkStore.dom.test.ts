/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The slot-work wire: baselines seed only teams the wire has not heard, live
 * events update single slots in place, and a removed team is forgotten.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ITeamRunEvent, ITeamSlotWork, ITeamSlotWorkChangedEvent, TTeam } from '@/common/types/team/teamTypes';
import { resetSlotWorkStoreForTest, useSlotWorkIndex } from '@renderer/pages/monitor/slotWorkStore';

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
    getRunState: { invoke: vi.fn() },
  };
});

vi.mock('@/common', () => ({
  ipcBridge: {
    auth: { currentUser: wire.currentUser },
    team: {
      list: wire.teamList,
      getRunState: wire.getRunState,
      runAccepted: wire.emitter('runAccepted'),
      runStarted: wire.emitter('runStarted'),
      runUpdated: wire.emitter('runUpdated'),
      runCompleted: wire.emitter('runCompleted'),
      runCancelled: wire.emitter('runCancelled'),
      runFailed: wire.emitter('runFailed'),
      slotWorkChanged: wire.emitter('slotWorkChanged'),
      created: wire.emitter('created'),
      listChanged: wire.emitter('listChanged'),
      removed: wire.emitter('removed'),
    },
    realtime: { reconnected: wire.emitter('reconnected') },
  },
}));

const team = (id: string): TTeam => ({
  id,
  user_id: 'u1',
  name: id,
  workspace: 'E:/w',
  workspace_mode: 'isolated',
  leader_assistant_id: 's1',
  assistants: [],
  created_at: 1,
  updated_at: 1,
});

const slotWork = (slotId: string, state: ITeamSlotWork['state']): ITeamSlotWork => ({
  slot_id: slotId,
  role: 'teammate',
  state,
  queued_foreground_count: 0,
  queued_background_count: 0,
  active_turn_id: null,
  active_turn_started_at_ms: null,
  active_turn_elapsed_ms: null,
  active_turn_slow: null,
  active_turn_slow_threshold_ms: null,
  blocked_reason: null,
  team_run_id: null,
});

const flushAsync = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('slotWorkStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSlotWorkStoreForTest();
    wire.teamList.invoke.mockImplementation(async () => [team('t1')]);
    wire.getRunState.invoke.mockImplementation(async () => ({ active_run: null, slot_work: [slotWork('s1', 'idle')] }));
  });

  it('startup baselines every team from its run state', async () => {
    const { result } = renderHook(() => useSlotWorkIndex());
    await waitFor(() => expect(result.current.get('t1')?.get('s1')?.state).toBe('idle'));
    expect(wire.getRunState.invoke).toHaveBeenCalledWith({ team_id: 't1' });
  });

  it('slotWorkChanged updates the one slot verbatim, in place', async () => {
    const { result } = renderHook(() => useSlotWorkIndex());
    await waitFor(() => expect(result.current.get('t1')?.get('s1')?.state).toBe('idle'));
    const event: ITeamSlotWorkChangedEvent = { team_id: 't1', slot_work: slotWork('s1', 'running') };
    act(() => wire.handlers.slotWorkChanged(event));
    expect(result.current.get('t1')?.get('s1')?.state).toBe('running');
  });

  it('run events merge their slot_work batch', async () => {
    const { result } = renderHook(() => useSlotWorkIndex());
    await waitFor(() => expect(result.current.get('t1')?.get('s1')?.state).toBe('idle'));
    const event = {
      team_id: 't1',
      team_run_id: 'r1',
      source: 'user_message',
      has_user_intervention: false,
      target_slot_id: 's1',
      target_role: 'teammate',
      status: 'running',
      queued_intent_count: 0,
      starting_batch_count: 0,
      running_batch_count: 1,
      active_enqueue_lease_count: 0,
      slot_work: [slotWork('s2', 'running')],
    } satisfies ITeamRunEvent;
    act(() => wire.handlers.runUpdated(event));
    await flushAsync();
    expect(result.current.get('t1')?.get('s2')?.state).toBe('running');
    expect(result.current.get('t1')?.get('s1')?.state).toBe('idle');
  });

  it('a baseline skips a team the wire already carries', async () => {
    const { result } = renderHook(() => useSlotWorkIndex());
    await waitFor(() => expect(result.current.get('t1')?.size).toBe(1));
    wire.getRunState.invoke.mockClear();
    wire.handlers.created(undefined as never);
    await flushAsync();
    await flushAsync();
    expect(wire.getRunState.invoke).not.toHaveBeenCalled();
  });

  it('a removed team is forgotten', async () => {
    const { result } = renderHook(() => useSlotWorkIndex());
    await waitFor(() => expect(result.current.get('t1')?.size).toBe(1));
    act(() => wire.handlers.removed({ team_id: 't1' }));
    expect(result.current.get('t1')).toBeUndefined();
  });
});
