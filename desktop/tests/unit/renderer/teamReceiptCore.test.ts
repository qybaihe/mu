/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ITeamRunEvent } from '@/common/types/team/teamTypes';
import {
  buildReceiptContent,
  createSupervisorReceiptBuffer,
  parseTeamReceiptNotice,
  receiptEventFromRunEvent,
  RECEIPT_MERGE_WINDOW_MS,
} from '@/renderer/hooks/system/notification/teamReceiptCore';

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

describe('receiptEventFromRunEvent (channel selection)', () => {
  it('the lead run completing yields a receipt; a teammate-target run does not', () => {
    expect(receiptEventFromRunEvent(runEvent({ target_role: 'lead' }), 'completed')).toEqual({
      kind: 'completed',
      teamId: 'team-1',
      runId: 'run-1',
    });
    expect(receiptEventFromRunEvent(runEvent({ target_role: 'teammate' }), 'completed')).toBeNull();
  });

  it('a failed run yields a receipt whatever slot it names', () => {
    expect(receiptEventFromRunEvent(runEvent({ target_role: 'teammate', status: 'failed' }), 'failed')).toEqual({
      kind: 'failed',
      teamId: 'team-1',
      runId: 'run-1',
    });
  });

  it('events without ids are dropped', () => {
    expect(receiptEventFromRunEvent(runEvent({ team_id: '' }), 'completed')).toBeNull();
    expect(receiptEventFromRunEvent(runEvent({ team_run_id: '' }), 'failed')).toBeNull();
  });
});

describe('createSupervisorReceiptBuffer (merge window)', () => {
  it('defaults to the 60s window', () => {
    expect(createSupervisorReceiptBuffer().windowMs).toBe(RECEIPT_MERGE_WINDOW_MS);
  });

  it('the first event opens the window; later events inside it merge without re-arming', () => {
    const buffer = createSupervisorReceiptBuffer({ windowMs: 60_000 });
    expect(buffer.push({ kind: 'completed', teamId: 'team-1', runId: 'run-1' }, 1_000)).toBe(true);
    expect(buffer.push({ kind: 'completed', teamId: 'team-1', runId: 'run-2' }, 30_000)).toBe(false);
  });

  it('flush merges one team’s completions and failures, then empties', () => {
    const buffer = createSupervisorReceiptBuffer({ windowMs: 60_000 });
    buffer.push({ kind: 'completed', teamId: 'team-1', runId: 'a' }, 1_000);
    buffer.push({ kind: 'completed', teamId: 'team-1', runId: 'b' }, 2_000);
    buffer.push({ kind: 'failed', teamId: 'team-1', runId: 'c' }, 3_000);
    buffer.push({ kind: 'completed', teamId: 'team-2', runId: 'd' }, 4_000);
    expect(buffer.flush(61_000)).toEqual({
      teams: [
        { teamId: 'team-1', completed: 2, failed: 1 },
        { teamId: 'team-2', completed: 1, failed: 0 },
      ],
      at: 61_000,
    });
    expect(buffer.flush(62_000)).toBeNull();
  });

  it('the same run per kind counts once: a reconnect replay does not double-count', () => {
    const buffer = createSupervisorReceiptBuffer({ windowMs: 60_000 });
    buffer.push({ kind: 'completed', teamId: 'team-1', runId: 'run-1' }, 1_000);
    buffer.push({ kind: 'completed', teamId: 'team-1', runId: 'run-1' }, 1_500);
    expect(buffer.flush(61_000)).toEqual({ teams: [{ teamId: 'team-1', completed: 1, failed: 0 }], at: 61_000 });
  });

  it('events after a flush open a fresh window', () => {
    const buffer = createSupervisorReceiptBuffer({ windowMs: 60_000 });
    buffer.push({ kind: 'completed', teamId: 'team-1', runId: 'a' }, 1_000);
    buffer.flush(61_000);
    expect(buffer.push({ kind: 'completed', teamId: 'team-1', runId: 'b' }, 70_000)).toBe(true);
    expect(buffer.flush(130_000)).toEqual({ teams: [{ teamId: 'team-1', completed: 1, failed: 0 }], at: 130_000 });
  });
});

describe('receipt wire format', () => {
  it('builds marker + JSON and parses it back', () => {
    const payload = {
      v: 1 as const,
      teams: [{ teamId: 'team-1', name: '查重队', completed: 2, failed: 0 }],
      at: 1_730_000_000_000,
    };
    const content = buildReceiptContent(payload);
    expect(content.startsWith('[[MU_TEAM_RECEIPT]]')).toBe(true);
    expect(parseTeamReceiptNotice(content)).toEqual(payload);
  });

  it('ordinary text and malformed bodies parse to null', () => {
    expect(parseTeamReceiptNotice('just a user message')).toBeNull();
    expect(parseTeamReceiptNotice('[[MU_TEAM_RECEIPT]]not json')).toBeNull();
    expect(parseTeamReceiptNotice('[[MU_TEAM_RECEIPT]]{"v":2,"teams":[],"at":1}')).toBeNull();
    expect(parseTeamReceiptNotice('[[MU_TEAM_RECEIPT]]{"v":1,"teams":[{"teamId":"t"}],"at":1}')).toBeNull();
  });
});
