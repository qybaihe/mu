/**
 * The journal: the person's own record of what was learned, across every project. Two files hold it, neither written
 * by the journal: mu's lessons (`<agentDir>/mu/lessons.jsonl`, common/kyrn/lessons.ts) and the positions' shared ledger
 * (`positions/_shared/LESSONS.md`, one `date | position | text` line per wrap-up, appended by `teams.cjs lesson`).
 * This module flattens both into one newest-first view; the journal itself stores nothing — it is a view, and the files
 * stay the only truth.
 */

import type { LessonKind, StoredLesson } from './lessons';

/** Where an entry came from: mu's lessons file, or the positions' shared ledger. */
export const JOURNAL_SOURCES = ['lessons', 'positions'] as const;
export type JournalSource = (typeof JOURNAL_SOURCES)[number];

/** What an entry is: one of a lesson's kinds, or a position's wrap-up line. */
export type JournalKind = LessonKind | 'position';

/** One line of the journal: either source flattened to the same shape. */
export type JournalEntry = {
  /** Lessons: the lesson's id. Ledger: `ledger:<line>`, the line's place in the file. */
  id: string;
  source: JournalSource;
  kind: JournalKind;
  /** The one line the journal shows: a lesson's `lesson`, or the ledger line's text. */
  text: string;
  /** When it was learned: a lesson's `updated` (ISO, exact) or the ledger line's `date` (a day). */
  at: string;
  /**
   * Where it holds: a lesson's project (`scope.cwd`; without one it holds everywhere) or the ledger line's position.
   */
  scope?: string;
};

/** The most entries the journal shows. Older ones stay in the files; one line says how many are left out. */
export const JOURNAL_CAP = 50;

/** The journal as the tab shows it: the newest {@link JOURNAL_CAP} entries, and how many there are in all. */
export type JournalView = { entries: JournalEntry[]; total: number };

/** One well-formed line of the positions' ledger. */
export type LedgerLine = { date: string; position: string; text: string };

/** One ledger line: `date | position | text`. The text may itself hold ` | `; the position may not hold a `|`. */
const LEDGER_LINE = /^(\d{4}-\d{2}-\d{2}) \| ([^|]+?) \| (.+)$/;

/**
 * The ledger's lines, in file order. The marker, the heading, blank lines and any line that does not hold a whole
 * `date | position | text` are skipped: a bad line must not cost the rest of the file.
 */
export function parseLessonsLedger(text: string): LedgerLine[] {
  const lines: LedgerLine[] = [];
  for (const raw of text.split('\n')) {
    const line = LEDGER_LINE.exec(raw.trim());
    if (!line) continue;
    lines.push({ date: line[1], position: line[2].trim(), text: line[3].trim() });
  }
  return lines;
}

/**
 * Both sources as one list, newest first. A lesson's `updated` is an exact time and a ledger line's only a day, so
 * entries order by day; within one day the lessons come first (a decided tie-break, not a claim about the clock), the
 * newest lesson first, and the ledger's lines backwards — the file appends, so its last line is its newest.
 */
export function journalOf(lessons: readonly StoredLesson[], ledger: readonly LedgerLine[]): JournalEntry[] {
  const entries: JournalEntry[] = lessons.map((lesson) => ({
    id: lesson.id,
    source: 'lessons',
    kind: lesson.kind,
    text: lesson.lesson,
    at: lesson.updated,
    ...(lesson.scope.cwd === undefined ? {} : { scope: lesson.scope.cwd }),
  }));
  for (let index = ledger.length - 1; index >= 0; index--) {
    const line = ledger[index];
    entries.push({
      id: `ledger:${index}`,
      source: 'positions',
      kind: 'position',
      text: line.text,
      at: line.date,
      scope: line.position,
    });
  }
  entries.sort((a, b) => {
    const byDay = b.at.slice(0, 10).localeCompare(a.at.slice(0, 10));
    if (byDay !== 0) return byDay;
    if (a.source !== b.source) return a.source === 'lessons' ? -1 : 1;
    if (a.source === 'lessons') return b.at.localeCompare(a.at);
    return 0; // The ledger's entries were pushed backwards: a stable sort keeps them newest first.
  });
  return entries;
}

/** The journal of both sources, capped at {@link JOURNAL_CAP}: what the tab shows, and how much more there is. */
export function journalView(lessons: readonly StoredLesson[], ledger: readonly LedgerLine[]): JournalView {
  const all = journalOf(lessons, ledger);
  return { entries: all.slice(0, JOURNAL_CAP), total: all.length };
}
