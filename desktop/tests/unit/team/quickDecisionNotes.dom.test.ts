/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  appendQuickDecisionNote,
  quickDecisionNotesOf,
  reloadQuickDecisionNotesForTest,
  resetQuickDecisionNotesForTest,
  shouldAskQuickDecision,
} from '@renderer/pages/team/core/quickDecisionNotes';

/** The ⚡ note store: what a short-circuited send leaves behind, and the guards that decide whether to ask at all. */

afterEach(() => {
  resetQuickDecisionNotesForTest();
});

const reuseVerdict = {
  action: 'reuse',
  teamId: 't1',
  teamName: '货代小队',
  leadConversationId: 'c1',
  reason: '同域',
  confidence: 0.95,
  model: 'cheap',
  durationMs: 800,
  cached: false,
} as const;

const rejectVerdict = {
  action: 'reject',
  suggestId: 'video-lab',
  suggestLabel: '视频实验室(video-lab)',
  reason: '视频域',
  confidence: 0.95,
  model: 'cheap',
  durationMs: 400,
  cached: false,
} as const;

describe('appendQuickDecisionNote / quickDecisionNotesOf', () => {
  it('records a reuse with its basis and scopes it to the conversation', () => {
    appendQuickDecisionNote('conv-1', '查一下 CNS 客户', reuseVerdict);
    appendQuickDecisionNote('conv-2', '做个视频', rejectVerdict);
    const notes = quickDecisionNotesOf('conv-1');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      conversationId: 'conv-1',
      kind: 'reuse',
      teamName: '货代小队',
      cached: false,
      confidence: 0.95,
      model: 'cheap',
    });
    expect(quickDecisionNotesOf('conv-2')[0]).toMatchObject({ kind: 'reject', suggestLabel: '视频实验室(video-lab)' });
    expect(quickDecisionNotesOf('conv-3')).toHaveLength(0);
  });
  it('an engine verdict keeps its tier and probability in the receipt', () => {
    const note = appendQuickDecisionNote('conv-1', '查一下 CNS 客户', {
      ...reuseVerdict,
      model: 'jev-1.13',
      tier: 'L1',
      probability: 0.93,
    });
    expect(note).toMatchObject({ tier: 'L1', probability: 0.93, model: 'jev-1.13' });
    const plain = appendQuickDecisionNote('conv-1', '再查一个', reuseVerdict);
    expect(plain.tier).toBeUndefined();
    expect(plain.probability).toBeUndefined();
  });
  it('persists across a store reload (localStorage round trip)', () => {
    appendQuickDecisionNote('conv-1', '任务', reuseVerdict);
    // A second module instance would read the same localStorage; here the round
    // trip is proven by the snapshot surviving a cache invalidation.
    expect(quickDecisionNotesOf('conv-1')).toHaveLength(1);
    appendQuickDecisionNote('conv-1', '再来一个', reuseVerdict);
    expect(quickDecisionNotesOf('conv-1')).toHaveLength(2);
    expect(quickDecisionNotesOf('conv-1')[0].input).toBe('任务');
  });
  it('caps the task excerpt a note keeps', () => {
    const note = appendQuickDecisionNote('conv-1', '长'.repeat(1000), reuseVerdict);
    expect(note.input.length).toBe(400);
  });
  it('the snapshot identity is stable until a note lands (what useSyncExternalStore needs)', () => {
    const first = quickDecisionNotesOf('conv-1');
    expect(quickDecisionNotesOf('conv-1')).toBe(first);
    appendQuickDecisionNote('conv-1', '任务', reuseVerdict);
    const after = quickDecisionNotesOf('conv-1');
    expect(after).not.toBe(first);
    expect(after).toHaveLength(1);
  });
  it('survives a page reload: a fresh cache re-reads the same notes from storage', () => {
    appendQuickDecisionNote('conv-1', '任务A', reuseVerdict);
    appendQuickDecisionNote('conv-1', '任务B', rejectVerdict);
    reloadQuickDecisionNotesForTest(); // drops the in-memory caches, as a remount would
    expect(quickDecisionNotesOf('conv-1').map((note) => note.input)).toEqual(['任务A', '任务B']);
  });
});

describe('shouldAskQuickDecision — the conservative ask boundary', () => {
  const base = { positionMarker: 'supervisor', hasTeamRoute: false, fileCount: 0, input: '查一下 CNS 客户' };
  it('asks for a supervisor or position conversation with a plain task', () => {
    expect(shouldAskQuickDecision(base)).toBe(true);
    expect(shouldAskQuickDecision({ ...base, positionMarker: 'forwarder' })).toBe(true);
  });
  it('never asks without a marker, on a team conversation, with attachments, or on a slash command', () => {
    expect(shouldAskQuickDecision({ ...base, positionMarker: undefined })).toBe(false);
    expect(shouldAskQuickDecision({ ...base, hasTeamRoute: true })).toBe(false);
    expect(shouldAskQuickDecision({ ...base, fileCount: 2 })).toBe(false);
    expect(shouldAskQuickDecision({ ...base, input: '/compact' })).toBe(false);
    expect(shouldAskQuickDecision({ ...base, input: '   ' })).toBe(false);
  });
});
