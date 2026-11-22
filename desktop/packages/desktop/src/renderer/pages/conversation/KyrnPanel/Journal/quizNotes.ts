/**
 * The quiz's own progress store (side-tutor case 3): which journal entries the
 * person has answered right, kept in localStorage exactly the way the task
 * verification badge keeps its verdicts (`task-verification-v1`'s sibling).
 * The kernel's lessons file is never touched — active/retired/superseded is
 * its lifecycle, not this tab's. One pass per entry, keyed by the journal's
 * entry id; the entry's own `at` rides along, and a pass for an `at` that has
 * moved (the lesson was edited — the file appends, `updated` changes) reads
 * as no pass at all: an edited lesson is re-learned, re-tested.
 */

/** One recorded pass. */
export type QuizPassEntry = {
  /** The journal entry's id: a lesson's, or `ledger:<index>`. */
  entryId: string;
  /** The entry's `at` when the pass happened; a different `at` now voids it. */
  entryAt: string;
  /** The quiz's content hash (common/chat/journal/quizCore.ts): forensics, and the tie to the question asked. */
  hash: string;
  /** When the pass happened, epoch ms. */
  at: number;
};

const STORAGE_KEY = 'quiz-progress-v1';
/** How many passes the store keeps; the oldest go first. */
const ENTRY_CAP = 400;

const listeners = new Set<() => void>();
let cache: ReadonlyMap<string, QuizPassEntry> | undefined;

const loadAll = (): ReadonlyMap<string, QuizPassEntry> => {
  if (cache !== undefined) return cache;
  const entries = new Map<string, QuizPassEntry>();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const entry = item as Partial<QuizPassEntry>;
        if (
          typeof entry.entryId !== 'string' ||
          typeof entry.entryAt !== 'string' ||
          typeof entry.hash !== 'string' ||
          typeof entry.at !== 'number'
        )
          continue;
        entries.set(entry.entryId, { entryId: entry.entryId, entryAt: entry.entryAt, hash: entry.hash, at: entry.at });
      }
    }
  } catch {
    // A full or blocked localStorage keeps this session's passes in memory only.
  }
  cache = entries;
  return cache;
};

const persist = (entries: ReadonlyMap<string, QuizPassEntry>): void => {
  cache = entries;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...entries.values()]));
  } catch {
    // Same tolerance as the load: the badge lives without persistence.
  }
  for (const notify of listeners) notify();
};

/** The whole snapshot, for `useSyncExternalStore`; a stable reference between writes. */
export const quizProgressSnapshot = (): ReadonlyMap<string, QuizPassEntry> => loadAll();

/** The store's change signal. */
export const subscribeQuizProgress = (notify: () => void): (() => void) => {
  listeners.add(notify);
  return () => listeners.delete(notify);
};

/**
 * Whether an entry's pass still counts: a recorded pass whose entry has not moved since. A wrong answer records
 * nothing — the badge's honest state for it is simply still untested.
 */
export const quizPassed = (entryId: string, entryAt: string): boolean => {
  const pass = loadAll().get(entryId);
  return pass !== undefined && pass.entryAt === entryAt;
};

/** Records one pass; a newer pass for the same entry replaces the older. */
export const recordQuizPass = (entry: QuizPassEntry): void => {
  const next = new Map(loadAll());
  next.set(entry.entryId, entry);
  if (next.size > ENTRY_CAP) {
    const overflow = next.size - ENTRY_CAP;
    for (const [id] of [...next.entries()].toSorted((a, b) => a[1].at - b[1].at).slice(0, overflow)) {
      next.delete(id);
    }
  }
  persist(next);
};

/** Clears the store (tests and E2E reset between scenarios). */
export const clearQuizProgress = (): void => persist(new Map());

/** For tests: drop the in-memory cache so a cleared store reads back empty (localStorage alone never notifies). */
export const resetQuizProgressCache = (): void => {
  cache = undefined;
};
