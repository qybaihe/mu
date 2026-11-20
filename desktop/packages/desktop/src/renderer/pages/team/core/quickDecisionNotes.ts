/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ⚡ notes a short-circuited send leaves in its conversation: the light
 * marker plus the receipt, persisted in localStorage because the backend
 * conversation is untouched by design — the whole point is that no full
 * model round runs, and with it no backend message exists. The MessageList
 * merges these rows into the history (the same seam as synthetic teammate
 * rows); the send box appends one right after the main process answers.
 */
import { useSyncExternalStore } from 'react';
import type { QuickDecisionRouteResult } from '@/common/chat/team/quickDecision/quickDecisionBridge';

/** One short-circuit as the conversation shows it: what was decided, on what basis, about which task. */
export type QuickDecisionNote = {
  id: string;
  conversationId: string;
  createdAt: number;
  kind: 'reuse' | 'reject';
  /** The task's text as typed, capped — the receipt quotes it. */
  input: string;
  teamName?: string;
  teamId?: string;
  leadConversationId?: string;
  suggestLabel?: string;
  reason?: string;
  confidence?: number;
  model?: string;
  durationMs?: number;
  cached?: boolean;
};

const STORAGE_KEY = 'quick-decision-notes-v1';
/** How much of the task text a note keeps. */
const NOTE_INPUT_LIMIT = 400;
/** How many notes survive; a conversation's history is the archive, notes are receipts. */
const NOTES_CAP = 200;

const listeners = new Set<() => void>();
let cache: QuickDecisionNote[] | undefined;
/** Per-conversation snapshots, memoized so `useSyncExternalStore` sees one stable array until a note lands. */
const snapshots = new Map<string, QuickDecisionNote[]>();

const loadAll = (): QuickDecisionNote[] => {
  if (cache !== undefined) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed)
      ? (parsed.filter((item) => typeof item === 'object' && item !== null) as QuickDecisionNote[])
      : [];
  } catch {
    cache = [];
  }
  return cache;
};

const persist = (notes: QuickDecisionNote[]): void => {
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
export const quickDecisionNotesOf = (conversationId: string): QuickDecisionNote[] => {
  const memoized = snapshots.get(conversationId);
  if (memoized !== undefined) return memoized;
  const notes = loadAll().filter((note) => note.conversationId === conversationId);
  snapshots.set(conversationId, notes);
  return notes;
};

/** The empty snapshot as one shared object: `useSyncExternalStore` re-renders forever on a fresh `[]` per call. */
const NO_NOTES: QuickDecisionNote[] = [];

/** React binding: the notes of one conversation, re-rendered on append. */
export const useQuickDecisionNotes = (conversationId: string | undefined): QuickDecisionNote[] => {
  const getSnapshot = () => (conversationId === undefined ? NO_NOTES : quickDecisionNotesOf(conversationId));
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

let nextNoteId = 0;

/** Records one short-circuit: the send box calls it right after the main process answered decisively. */
export const appendQuickDecisionNote = (
  conversationId: string,
  input: string,
  verdict: Extract<QuickDecisionRouteResult, { action: 'reuse' | 'reject' }>
): QuickDecisionNote => {
  const note: QuickDecisionNote =
    verdict.action === 'reuse'
      ? {
          id: `qdn-${Date.now()}-${nextNoteId++}`,
          conversationId,
          createdAt: Date.now(),
          kind: 'reuse',
          input: input.slice(0, NOTE_INPUT_LIMIT),
          teamName: verdict.teamName,
          teamId: verdict.teamId,
          leadConversationId: verdict.leadConversationId,
          reason: verdict.reason,
          confidence: verdict.confidence,
          model: verdict.model,
          durationMs: verdict.durationMs,
          cached: verdict.cached,
        }
      : {
          id: `qdn-${Date.now()}-${nextNoteId++}`,
          conversationId,
          createdAt: Date.now(),
          kind: 'reject',
          input: input.slice(0, NOTE_INPUT_LIMIT),
          suggestLabel: verdict.suggestLabel,
          reason: verdict.reason,
          confidence: verdict.confidence,
          model: verdict.model,
          durationMs: verdict.durationMs,
          cached: verdict.cached,
        };
  persist([...loadAll(), note].slice(-NOTES_CAP));
  return note;
};

/**
 * Whether one send may even ask the decision layer. The guards are the
 * conservative boundary: only a supervisor or position conversation (the
 * marker), never a team conversation (its own send path), never with
 * attachments (a delivery carries text only), never a slash command (those
 * are app commands, not tasks).
 */
export const shouldAskQuickDecision = (options: {
  positionMarker: string | undefined;
  hasTeamRoute: boolean;
  fileCount: number;
  input: string;
}): boolean =>
  options.positionMarker !== undefined &&
  options.positionMarker !== '' &&
  !options.hasTeamRoute &&
  options.fileCount === 0 &&
  options.input.trim().length > 0 &&
  !options.input.trimStart().startsWith('/');

/** Test-only: clears the persisted notes and resets the id counter. */
export const resetQuickDecisionNotesForTest = (): void => {
  nextNoteId = 0;
  persist([]);
};

/** Test-only: drops the in-memory caches only — what a page reload would re-read from storage. */
export const reloadQuickDecisionNotesForTest = (): void => {
  cache = undefined;
  snapshots.clear();
};
