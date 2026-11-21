/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ⚡ steward notes one action leaves in its conversation: the light
 * marker plus the one-line receipt, persisted in localStorage because the
 * backend conversation is untouched by design — compact is a hidden command
 * and a switch is a new conversation, so no backend row exists for either.
 * The MessageList merges these rows into the history (the same seam as the
 * quick-decision notes).
 */
import { useSyncExternalStore } from 'react';
import type { ContextStewardRunResult } from '@/common/chat/team/contextSteward/contextStewardBridge';

/** One steward action as the conversation shows it. `continuation` is the row the NEW part opens with. */
export type ContextStewardNote = {
  id: string;
  conversationId: string;
  createdAt: number;
  kind: 'compact' | 'switch' | 'continuation';
  reason: string;
  tokens?: number;
  contextWindow?: number;
  percent?: number | null;
  part?: number;
  oldTitle?: string;
  newTitle?: string;
  /** For a switch note: the part the work moved to. For a continuation: where it came from. */
  counterpartId?: string;
};

const STORAGE_KEY = 'context-steward-notes-v1';
/** How many notes survive; a conversation's history is the archive, notes are receipts. */
const NOTES_CAP = 200;

const listeners = new Set<() => void>();
let cache: ContextStewardNote[] | undefined;
const snapshots = new Map<string, ContextStewardNote[]>();

const loadAll = (): ContextStewardNote[] => {
  if (cache !== undefined) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed)
      ? (parsed.filter((item) => typeof item === 'object' && item !== null) as ContextStewardNote[])
      : [];
  } catch {
    cache = [];
  }
  return cache;
};

const persist = (notes: ContextStewardNote[]): void => {
  cache = notes;
  snapshots.clear();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  } catch {
    // A full or blocked localStorage keeps the notes for this session only.
  }
  for (const listener of listeners) listener();
};

const subscribe = (onChange: () => void): (() => void) => {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
};

/** The notes of one conversation, oldest first — the shape the message list merges. */
export const contextStewardNotesOf = (conversationId: string): ContextStewardNote[] => {
  const memoized = snapshots.get(conversationId);
  if (memoized !== undefined) return memoized;
  const notes = loadAll().filter((note) => note.conversationId === conversationId);
  snapshots.set(conversationId, notes);
  return notes;
};

const NO_NOTES: ContextStewardNote[] = [];

/** React binding: the notes of one conversation, re-rendered on append. */
export const useContextStewardNotes = (conversationId: string | undefined): ContextStewardNote[] => {
  const getSnapshot = () => (conversationId === undefined ? NO_NOTES : contextStewardNotesOf(conversationId));
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

let nextNoteId = 0;
const baseNote = (conversationId: string, kind: ContextStewardNote['kind'], reason: string) => ({
  id: `csn-${Date.now()}-${nextNoteId++}`,
  conversationId,
  createdAt: Date.now(),
  kind,
  reason,
});

/**
 * Records one steward action: the acting conversation gets its row, and a
 * switch additionally seeds the NEW part with a continuation row (where the
 * work came from). Returns the notes written.
 */
export const appendContextStewardNote = (
  conversationId: string,
  outcome: Extract<ContextStewardRunResult, { action: 'compact' | 'switch' }>
): ContextStewardNote[] => {
  if (outcome.action === 'compact') {
    const note: ContextStewardNote = {
      ...baseNote(conversationId, 'compact', outcome.reason),
      tokens: outcome.tokens,
      contextWindow: outcome.contextWindow,
      percent: outcome.percent,
    };
    persist([...loadAll(), note].slice(-NOTES_CAP));
    return [note];
  }
  const switched: ContextStewardNote = {
    ...baseNote(conversationId, 'switch', outcome.reason),
    tokens: outcome.tokens,
    contextWindow: outcome.contextWindow,
    percent: outcome.percent,
    part: outcome.part,
    oldTitle: outcome.oldTitle,
    newTitle: outcome.newTitle,
    counterpartId: outcome.newConversationId,
  };
  const continuation: ContextStewardNote = {
    ...baseNote(outcome.newConversationId, 'continuation', outcome.reason),
    part: outcome.part,
    oldTitle: outcome.oldTitle,
    newTitle: outcome.newTitle,
    counterpartId: conversationId,
  };
  persist([...loadAll(), switched, continuation].slice(-NOTES_CAP));
  return [switched, continuation];
};

/** Test-only: clears the persisted notes and resets the id counter. */
export const resetContextStewardNotesForTest = (): void => {
  nextNoteId = 0;
  persist([]);
};

/** Test-only: drops the in-memory caches only — what a page reload would re-read from storage. */
export const reloadContextStewardNotesForTest = (): void => {
  cache = undefined;
  snapshots.clear();
};
