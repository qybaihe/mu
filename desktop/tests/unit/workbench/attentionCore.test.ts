/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  ATTENTION_FAILURES_LIMIT,
  applyWaitingFrame,
  attentionBadgeCount,
  clearFailureById,
  clearWaitingById,
  clearWaitingForConversation,
  deriveAttentionItems,
  emptyAttentionState,
  pruneFailures,
  recordFailure,
  type AttentionFailure,
} from '@/renderer/pages/workbench/attention/attentionCore';

const failure = (overrides: Partial<AttentionFailure> = {}): AttentionFailure => ({
  id: `f-${Math.random().toString(36).slice(2)}`,
  conversationId: 'conv-1',
  at: 1000,
  ...overrides,
});

describe('applyWaitingFrame / clearWaiting', () => {
  it('adds an approval and a question for the same conversation as separate items', () => {
    let state = emptyAttentionState();
    state = applyWaitingFrame(state, 'conv-1', 'approval', 'call-1', 10);
    state = applyWaitingFrame(state, 'conv-1', 'question', 'req-1', 20);
    expect(state.waiting.get('conv-1')?.size).toBe(2);
    expect(deriveAttentionItems(state).map((item) => item.kind)).toEqual(['approval', 'question']);
  });

  it('is idempotent for the same confirmation id', () => {
    let state = applyWaitingFrame(emptyAttentionState(), 'conv-1', 'approval', 'call-1', 10);
    state = applyWaitingFrame(state, 'conv-1', 'approval', 'call-1', 20);
    expect(state.waiting.get('conv-1')?.size).toBe(1);
  });

  it('ignores frames without a conversation or confirmation id', () => {
    expect(applyWaitingFrame(emptyAttentionState(), '', 'approval', 'x', 1)).toEqual(emptyAttentionState());
    expect(applyWaitingFrame(emptyAttentionState(), 'conv-1', 'approval', '', 1)).toEqual(emptyAttentionState());
  });

  it('clears one confirmation by id while siblings stay', () => {
    let state = emptyAttentionState();
    state = applyWaitingFrame(state, 'conv-1', 'approval', 'call-1', 10);
    state = applyWaitingFrame(state, 'conv-1', 'approval', 'call-2', 20);
    state = clearWaitingById(state, 'conv-1', 'call-1');
    expect([...(state.waiting.get('conv-1')?.keys() ?? [])]).toEqual(['call-2']);
  });

  it('clears the whole conversation on a terminal frame, other conversations untouched', () => {
    let state = emptyAttentionState();
    state = applyWaitingFrame(state, 'conv-1', 'approval', 'call-1', 10);
    state = applyWaitingFrame(state, 'conv-2', 'question', 'req-1', 20);
    state = clearWaitingForConversation(state, 'conv-1');
    expect(state.waiting.has('conv-1')).toBe(false);
    expect(state.waiting.has('conv-2')).toBe(true);
  });
});

describe('recordFailure / clearFailureById', () => {
  it('keeps one reminder per conversation: a newer failure replaces the older', () => {
    let state = emptyAttentionState();
    state = recordFailure(state, failure({ id: 'f1', conversationId: 'conv-1', at: 1000 }));
    state = recordFailure(state, failure({ id: 'f2', conversationId: 'conv-1', at: 2000 }));
    expect(state.failures).toEqual([{ id: 'f2', conversationId: 'conv-1', at: 2000 }]);
  });

  it('a stale clear cannot remove a replacement failure', () => {
    let state = emptyAttentionState();
    state = recordFailure(state, failure({ id: 'f1', conversationId: 'conv-1', at: 1000 }));
    state = recordFailure(state, failure({ id: 'f2', conversationId: 'conv-1', at: 2000 }));
    state = clearFailureById(state, 'f1');
    expect(state.failures.map((item) => item.id)).toEqual(['f2']);
  });

  it('clears exactly the failure the person marked handled', () => {
    let state = emptyAttentionState();
    state = recordFailure(state, failure({ id: 'f1', conversationId: 'conv-1' }));
    state = recordFailure(state, failure({ id: 'f2', conversationId: 'conv-2' }));
    state = clearFailureById(state, 'f2');
    expect(state.failures.map((item) => item.id)).toEqual(['f1']);
  });

  it('caps the kept failures at the limit, dropping the oldest', () => {
    let state = emptyAttentionState();
    for (let index = 0; index < ATTENTION_FAILURES_LIMIT + 5; index += 1) {
      state = recordFailure(state, failure({ id: `f${index}`, conversationId: `conv-${index}`, at: index }));
    }
    expect(state.failures.length).toBe(ATTENTION_FAILURES_LIMIT);
    expect(state.failures[0]?.id).toBe('f5');
    expect(state.failures.at(-1)?.id).toBe(`f${ATTENTION_FAILURES_LIMIT + 4}`);
  });

  it('ignores failures without destination or id', () => {
    expect(recordFailure(emptyAttentionState(), failure({ conversationId: '' }))).toEqual(emptyAttentionState());
    expect(recordFailure(emptyAttentionState(), failure({ id: '' }))).toEqual(emptyAttentionState());
  });
});

describe('pruneFailures', () => {
  it('drops failures whose conversation is deleted and keeps the rest', () => {
    let state = emptyAttentionState();
    state = recordFailure(state, failure({ id: 'f1', conversationId: 'conv-1' }));
    state = recordFailure(state, failure({ id: 'f2', conversationId: 'conv-2' }));
    state = pruneFailures(state, new Set(['conv-2']));
    expect(state.failures.map((item) => item.id)).toEqual(['f2']);
  });
});

describe('deriveAttentionItems', () => {
  it('orders approvals oldest first, questions oldest first, failures newest first', () => {
    let state = emptyAttentionState();
    state = applyWaitingFrame(state, 'conv-1', 'approval', 'call-1', 30);
    state = applyWaitingFrame(state, 'conv-2', 'approval', 'call-2', 10);
    state = applyWaitingFrame(state, 'conv-3', 'question', 'req-1', 40);
    state = applyWaitingFrame(state, 'conv-4', 'question', 'req-2', 20);
    state = recordFailure(state, failure({ id: 'f1', conversationId: 'conv-5', at: 1000 }));
    state = recordFailure(state, failure({ id: 'f2', conversationId: 'conv-6', at: 2000 }));
    expect(deriveAttentionItems(state).map((item) => item.key)).toEqual([
      'approval:conv-2:call-2',
      'approval:conv-1:call-1',
      'question:conv-4:req-2',
      'question:conv-3:req-1',
      'failure:f2',
      'failure:f1',
    ]);
  });

  it('skips failures without a destination', () => {
    let state = recordFailure(emptyAttentionState(), failure({ conversationId: '' }));
    expect(deriveAttentionItems(state)).toEqual([]);
  });
});

describe('attentionBadgeCount', () => {
  it('counts every derived item', () => {
    let state = emptyAttentionState();
    state = applyWaitingFrame(state, 'conv-1', 'approval', 'call-1', 10);
    state = applyWaitingFrame(state, 'conv-2', 'question', 'req-1', 20);
    state = recordFailure(state, failure({ id: 'f1', conversationId: 'conv-3', at: 30 }));
    expect(attentionBadgeCount(state)).toBe(3);
    state = clearFailureById(state, 'f1');
    expect(attentionBadgeCount(state)).toBe(2);
    state = clearWaitingForConversation(state, 'conv-1');
    expect(attentionBadgeCount(state)).toBe(1);
  });
});
