/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ITeamRunEvent, ITeamSlotWork, ITeamSlotWorkChangedEvent } from '@/common/types/team/teamTypes';
import {
  emptyTeamWaitState,
  findLeadSlot,
  foldRunEvent,
  foldSlotWorkChanged,
  isWaitingStall,
} from '@/renderer/pages/workbench/attention/teamWaitCore';

const slot = (overrides: Partial<ITeamSlotWork> = {}): ITeamSlotWork => ({
  slot_id: 'slot-a',
  role: 'teammate',
  state: 'idle',
  queued_foreground_count: 0,
  queued_background_count: 0,
  active_turn_id: null,
  active_turn_started_at_ms: null,
  active_turn_elapsed_ms: null,
  active_turn_slow: null,
  active_turn_slow_threshold_ms: null,
  blocked_reason: null,
  team_run_id: 'run-1',
  ...overrides,
});

const runEvent = (overrides: Partial<ITeamRunEvent> = {}): ITeamRunEvent => ({
  team_id: 'team-1',
  team_run_id: 'run-1',
  source: 'user_message',
  has_user_intervention: false,
  target_slot_id: 'slot-lead',
  target_role: 'lead',
  status: 'running',
  queued_intent_count: 0,
  starting_batch_count: 0,
  running_batch_count: 0,
  active_enqueue_lease_count: 0,
  slot_work: [],
  ...overrides,
});

const slotWorkChanged = (work: ITeamSlotWork, teamId = 'team-1'): ITeamSlotWorkChangedEvent => ({
  team_id: teamId,
  slot_work: work,
});

describe('isWaitingStall (the verdict)', () => {
  it('an empty wire is not a verdict', () => {
    expect(isWaitingStall(emptyTeamWaitState())).toBe(false);
    expect(isWaitingStall(foldRunEvent(emptyTeamWaitState(), runEvent()).state)).toBe(false);
  });

  it('a live run with every slot truly idle is a stall', () => {
    const { state } = foldRunEvent(
      emptyTeamWaitState(),
      runEvent({ slot_work: [slot({ slot_id: 'slot-lead', role: 'lead' }), slot({ slot_id: 'slot-a' })] })
    );
    expect(isWaitingStall(state)).toBe(true);
  });

  it('a queued or running slot means somebody will still move', () => {
    for (const work of [
      slot({ state: 'running' }),
      slot({ state: 'queued' }),
      slot({ state: 'starting' }),
      slot({ state: 'paused' }),
      slot({ state: 'blocked' }),
      slot({ queued_foreground_count: 1 }),
      slot({ queued_background_count: 2 }),
    ]) {
      const { state } = foldRunEvent(emptyTeamWaitState(), runEvent({ slot_work: [work] }));
      expect(isWaitingStall(state), work.state).toBe(false);
    }
  });

  it('a terminal run is never a stall', () => {
    for (const status of ['completed', 'cancelled', 'failed'] as const) {
      const { state } = foldRunEvent(
        emptyTeamWaitState(),
        runEvent({ status, slot_work: [slot({ slot_id: 'slot-lead', role: 'lead' })] })
      );
      expect(isWaitingStall(state), status).toBe(false);
    }
  });
});

describe('foldRunEvent / foldSlotWorkChanged (the transitions)', () => {
  const stalledEvent = runEvent({ slot_work: [slot({ slot_id: 'slot-lead', role: 'lead' }), slot()] });

  it('entering the stall reports stalled once, not per tick', () => {
    let folded = foldRunEvent(emptyTeamWaitState(), stalledEvent);
    expect(folded.transition).toBe('stalled');
    // The same all-idle picture again: still stalled, no second transition.
    folded = foldRunEvent(folded.state, stalledEvent);
    expect(folded.transition).toBeNull();
  });

  it('a slot waking clears the stall; going idle again re-stalls', () => {
    let folded = foldRunEvent(emptyTeamWaitState(), stalledEvent);
    folded = foldSlotWorkChanged(folded.state, slotWorkChanged(slot({ state: 'running' })));
    expect(folded.transition).toBe('cleared');
    folded = foldSlotWorkChanged(folded.state, slotWorkChanged(slot()));
    expect(folded.transition).toBe('stalled');
  });

  it('a terminal run clears a standing stall and forgets the run', () => {
    let folded = foldRunEvent(emptyTeamWaitState(), stalledEvent);
    folded = foldRunEvent(folded.state, runEvent({ status: 'completed' }));
    expect(folded.transition).toBe('cleared');
    expect(folded.state.runId).toBeNull();
  });

  it('a new run replaces the old picture wholesale', () => {
    let folded = foldRunEvent(emptyTeamWaitState(), stalledEvent);
    folded = foldRunEvent(folded.state, runEvent({ team_run_id: 'run-2', slot_work: [slot({ state: 'running' })] }));
    expect(folded.transition).toBe('cleared');
    expect(folded.state.runId).toBe('run-2');
  });
});

describe('findLeadSlot', () => {
  it('names the lead slot of the picture', () => {
    const { state } = foldRunEvent(
      emptyTeamWaitState(),
      runEvent({ slot_work: [slot({ slot_id: 'slot-a' }), slot({ slot_id: 'slot-lead', role: 'lead' })] })
    );
    expect(findLeadSlot(state)?.slot_id).toBe('slot-lead');
  });
});
