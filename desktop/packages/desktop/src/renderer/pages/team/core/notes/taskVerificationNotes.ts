/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Task verification, the badge's own store (batch L ②): when a task card
 * claims `done`, the system — not the model's word — decides whether the
 * claim holds. The pure half derives the verdict: the paths a task's window
 * claims as output (the finished write/edit calls plus the `present`
 * deliveries of the owner's conversation) go to one batch existence check
 * (the main process's fileRefs, cwd = the team workspace); every path a
 * regular file = ✅ verified, anything missing, ambiguous or nothing checkable
 * at all = ⚠ pending. The store half keeps one entry per task id in
 * localStorage (the ⚡ notes' sibling): the card, the monitor counts and the
 * E2E all read the same snapshot. The dispatch rules' own self-check duty
 * (回报 lead 时附核验结果) is the behavioural supplement; this store is the
 * reliable half that needs no model cooperation.
 */
import type { FileRefAnswer } from '@/common/chat/fileRefs/fileRefBridge';
import { changedFileRowsFrom } from '@renderer/pages/team/core/notes/teamChangedFileNotes';
import { deliverablesFromRows } from '@renderer/pages/team/components/TeamDeliverables';

/** What the badge says: the claim held, or it did not (yet). */
export type TaskVerificationState = 'verified' | 'pending';

/** One task's verdict, as the store keeps it. */
export type TaskVerificationEntry = {
  /** The backend task id — unique on its own, the store's key. */
  taskId: string;
  teamId: string;
  state: TaskVerificationState;
  /** Epoch ms of the check; a re-done task re-verifies past this stamp. */
  checkedAt: number;
  /** How many paths the check saw, and how many were regular files. */
  pathCount: number;
  verifiedCount: number;
};

/** Writes may persist a beat after the completion event; the read waits this long. */
export const VERIFY_DELAY_MS = 1500;
/** The task window's own skew allowance on both ends (agent vs wall clock). */
export const TASK_WINDOW_SLACK_MS = 2000;
/** How many paths one task's check resolves at most (the batch cap is 200; tasks are smaller). */
const PATH_CAP = 50;
/** How many entries the store keeps; the oldest pending first, then oldest overall. */
const ENTRY_CAP = 400;

const STORAGE_KEY = 'task-verification-v1';

/** One path as the check dedupes it: separators fold, so `a/b` and `a\b` are one file. */
const dedupeKeyOf = (path: string): string => path.replace(/\\/g, '/');

/**
 * The paths a task's window claims as output, from the owner conversation's
 * stored rows: the finished write/edit calls plus the `present` deliveries
 * that landed inside `[sinceMs, untilMs]`. Pure; empty when the window claims
 * nothing (which is itself a verdict: nothing checkable).
 */
export const claimedPathsFrom = (
  rows: readonly unknown[],
  conversationId: string,
  sinceMs: number,
  untilMs: number
): string[] => {
  const byKey = new Map<string, string>();
  for (const entry of changedFileRowsFrom(rows, sinceMs, untilMs)) {
    byKey.set(dedupeKeyOf(entry.path), entry.path);
  }
  for (const deliverable of deliverablesFromRows(rows, conversationId)) {
    if (deliverable.createdAt < sinceMs || deliverable.createdAt > untilMs) continue;
    byKey.set(dedupeKeyOf(deliverable.path), deliverable.path);
  }
  return [...byKey.values()].slice(0, PATH_CAP);
};

/**
 * The verdict one batch of answers settles: every path a regular file (and at
 * least one path asked) = verified; a missing or ambiguous path — or nothing
 * to check at all, the「未回查」shape — = pending.
 */
export const verificationStateOf = (answers: readonly FileRefAnswer[]): TaskVerificationState =>
  answers.length > 0 && answers.every((answer) => answer.state === 'found') ? 'verified' : 'pending';

// --- the store (localStorage, the ⚡ notes' sibling) ---

const listeners = new Set<() => void>();
let cache: ReadonlyMap<string, TaskVerificationEntry> | undefined;

const loadAll = (): ReadonlyMap<string, TaskVerificationEntry> => {
  if (cache !== undefined) return cache;
  const entries = new Map<string, TaskVerificationEntry>();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const entry = item as Partial<TaskVerificationEntry>;
        if (typeof entry.taskId !== 'string' || (entry.state !== 'verified' && entry.state !== 'pending')) continue;
        if (typeof entry.teamId !== 'string' || typeof entry.checkedAt !== 'number') continue;
        entries.set(entry.taskId, {
          taskId: entry.taskId,
          teamId: entry.teamId,
          state: entry.state,
          checkedAt: entry.checkedAt,
          pathCount: typeof entry.pathCount === 'number' ? entry.pathCount : 0,
          verifiedCount: typeof entry.verifiedCount === 'number' ? entry.verifiedCount : 0,
        });
      }
    }
  } catch {
    // A full or blocked localStorage keeps this session's verdicts in memory only.
  }
  cache = entries;
  return cache;
};

const persist = (entries: ReadonlyMap<string, TaskVerificationEntry>): void => {
  cache = entries;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...entries.values()]));
  } catch {
    // Same tolerance as the load: the badge lives without persistence.
  }
  for (const notify of listeners) notify();
};

/** The whole snapshot, for `useSyncExternalStore`; a stable reference between writes. */
export const taskVerificationSnapshot = (): ReadonlyMap<string, TaskVerificationEntry> => loadAll();

/** The store's change signal. */
export const subscribeTaskVerifications = (notify: () => void): (() => void) => {
  listeners.add(notify);
  return () => listeners.delete(notify);
};

/**
 * Records one task's verdict. A fresh verdict for a known task replaces its
 * entry (a task re-done re-verifies); the cap drops the oldest pending
 * entries first — a verdict nobody looks at is the cheapest history to lose.
 */
export const recordTaskVerification = (entry: TaskVerificationEntry): void => {
  const next = new Map(loadAll());
  next.set(entry.taskId, entry);
  if (next.size > ENTRY_CAP) {
    const overflow = next.size - ENTRY_CAP;
    const dropIds = [...next.values()]
      .filter((candidate) => candidate.state === 'pending')
      .sort((a, b) => a.checkedAt - b.checkedAt)
      .slice(0, overflow)
      .map((candidate) => candidate.taskId);
    for (const id of dropIds) next.delete(id);
    let still = next.size - ENTRY_CAP;
    for (const [id, candidate] of [...next.entries()].sort((a, b) => a[1].checkedAt - b[1].checkedAt)) {
      if (still <= 0) break;
      next.delete(id);
      still -= 1;
    }
  }
  persist(next);
};

/** Clears the store (tests and E2E reset between scenarios). */
export const clearTaskVerifications = (): void => persist(new Map());

/** For tests: drop the in-memory cache so a cleared store reads back empty (localStorage alone never notifies). */
export const resetTaskVerificationCache = (): void => {
  cache = undefined;
};
