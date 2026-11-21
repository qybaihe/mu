/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  appendContextStewardNote,
  contextStewardChainLinks,
  contextStewardNotesOf,
  reloadContextStewardNotesForTest,
  resetContextStewardNotesForTest,
} from '@renderer/pages/team/core/notes/contextStewardNotes';

/** The ⚡ steward note store: one row per action, a switch seeding the new part's continuation row. */

afterEach(() => {
  resetContextStewardNotesForTest();
});

const compactOutcome = {
  action: 'compact',
  reason: '已收尾',
  tokens: 160_000,
  contextWindow: 200_000,
  percent: 0.8,
} as const;

const switchOutcome = {
  action: 'switch',
  reason: '任务进行中',
  oldConversationId: 'c1',
  newConversationId: 'c2',
  oldTitle: '货代 (part 1)',
  newTitle: '货代',
  part: 1,
  tokens: 160_000,
  contextWindow: 200_000,
  percent: 0.8,
} as const;

describe('appendContextStewardNote', () => {
  it('records one compact note in the acting conversation', () => {
    const written = appendContextStewardNote('c1', compactOutcome);
    expect(written).toHaveLength(1);
    const notes = contextStewardNotesOf('c1');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'compact', reason: '已收尾', tokens: 160_000 });
  });

  it('records the switch note in the old conversation and seeds the new part with a continuation', () => {
    const written = appendContextStewardNote('c1', switchOutcome);
    expect(written).toHaveLength(2);
    const oldNotes = contextStewardNotesOf('c1');
    const newNotes = contextStewardNotesOf('c2');
    expect(oldNotes[0]).toMatchObject({
      kind: 'switch',
      part: 1,
      newTitle: '货代',
      counterpartId: 'c2',
    });
    expect(newNotes[0]).toMatchObject({
      kind: 'continuation',
      part: 1,
      oldTitle: '货代 (part 1)',
      counterpartId: 'c1',
    });
  });

  it('keeps only the last 200 notes — history is the archive, notes are receipts', () => {
    for (let i = 0; i < 205; i++) appendContextStewardNote(`c${i % 3}`, compactOutcome);
    const all = [...contextStewardNotesOf('c0'), ...contextStewardNotesOf('c1'), ...contextStewardNotesOf('c2')];
    expect(all.length).toBeLessThanOrEqual(200);
  });

  it('re-reads from storage when the in-memory cache is dropped (a page reload)', () => {
    appendContextStewardNote('c1', compactOutcome);
    reloadContextStewardNotesForTest();
    expect(contextStewardNotesOf('c1')).toHaveLength(1);
  });
});

describe('contextStewardChainLinks', () => {
  it('turns every switch and its continuation twin into the same exact edge', () => {
    appendContextStewardNote('c1', switchOutcome);
    appendContextStewardNote('c3', { ...switchOutcome, oldConversationId: 'c3', newConversationId: 'c4', part: 2 });
    const links = contextStewardChainLinks();
    // The switch note in c1 and the continuation note in c2 collapse to one edge.
    expect(links).toEqual([
      { fromConversationId: 'c1', toConversationId: 'c2', part: 1 },
      { fromConversationId: 'c1', toConversationId: 'c2', part: 1 },
      { fromConversationId: 'c3', toConversationId: 'c4', part: 2 },
      { fromConversationId: 'c3', toConversationId: 'c4', part: 2 },
    ]);
  });

  it('yields nothing for compact notes or notes without a counterpart', () => {
    appendContextStewardNote('c1', compactOutcome);
    expect(contextStewardChainLinks()).toEqual([]);
  });
});
