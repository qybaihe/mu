/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ITeamRunEvent } from '@/common/types/team/teamTypes';
import { createTeamRunNotificationController } from '@/renderer/hooks/system/notification/teamRunNotificationCore';

const runEvent = (overrides: Partial<ITeamRunEvent> = {}): ITeamRunEvent => ({
  team_id: 'team-1',
  team_run_id: 'run-1',
  source: 'user_message',
  has_user_intervention: false,
  target_slot_id: 'slot-lead',
  target_role: 'lead',
  status: 'completed',
  queued_intent_count: 0,
  starting_batch_count: 0,
  running_batch_count: 0,
  active_enqueue_lease_count: 0,
  slot_work: [],
  ...overrides,
});

describe('createTeamRunNotificationController', () => {
  it('the lead run completing notifies; a teammate-target run completing does not', () => {
    const notify = vi.fn();
    const controller = createTeamRunNotificationController({ notify });
    controller.onRunCompleted(runEvent({ target_role: 'lead', target_slot_id: 'slot-lead' }));
    controller.onRunCompleted(runEvent({ target_role: 'teammate', target_slot_id: 'slot-a', team_run_id: 'run-2' }));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      kind: 'runCompleted',
      teamId: 'team-1',
      runId: 'run-1',
      slotId: 'slot-lead',
    });
  });

  it('a failed run notifies whatever slot it names', () => {
    const notify = vi.fn();
    const controller = createTeamRunNotificationController({ notify });
    controller.onRunFailed(runEvent({ target_role: 'teammate', target_slot_id: 'slot-a', status: 'failed' }));
    expect(notify).toHaveBeenCalledWith({ kind: 'runFailed', teamId: 'team-1', runId: 'run-1', slotId: 'slot-a' });
  });

  it('one notification per run per kind: a reconnect replay does not re-nag', () => {
    const notify = vi.fn();
    const controller = createTeamRunNotificationController({ notify });
    controller.onRunCompleted(runEvent());
    controller.onRunCompleted(runEvent()); // the replay
    expect(notify).toHaveBeenCalledTimes(1);
    // The same run failing later is a different kind and still notifies.
    controller.onRunFailed(runEvent({ status: 'failed' }));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('events without ids are dropped, never notified', () => {
    const notify = vi.fn();
    const controller = createTeamRunNotificationController({ notify });
    controller.onRunCompleted(runEvent({ team_id: '', team_run_id: '' }));
    expect(notify).not.toHaveBeenCalled();
  });
});
