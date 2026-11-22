/**
 * The journal's read side: the main process's view over the two files the journal shows (common/kyrn/journal.ts) —
 * mu's lessons file and the positions' shared ledger. Read-only: the journal writes nothing anywhere, and both files
 * keep being written by their own writers (the harness, the lessons tab, `teams.cjs lesson`). One cache holds the last
 * view until either file's mtime moves; an unchanged file is never read again (batch L seam 3: a cache keyed on less
 * than the mtime goes stale the moment a writer changes a file it had already read).
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { SHARED_TEAMS_FOLDER } from '../../../common/chat/team/supervisor/supervisorCore';
import { journalView, parseLessonsLedger, type JournalView } from '../../../common/kyrn/journal';
import { KyrnError } from '../../../common/kyrn/errors';
import { readOptional } from './config/files';
import { readLessonsFile } from './lessons';

/** The positions' shared ledger — `positions/_shared/LESSONS.md` — in one profile's data folder. */
export function lessonsLedgerFile(dataDir: string): string {
  return join(dataDir, 'positions', SHARED_TEAMS_FOLDER, 'LESSONS.md');
}

/** One file's mtime, or undefined when there is no file yet. Any other failure names the file (`unreadable`). */
function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new KyrnError('unreadable', error instanceof Error ? error.message : String(error), { file: path });
  }
}

/** The journal of one lessons file and one ledger file, read anew only when either file has moved on. */
export class JournalStore {
  private lessonsFile: string;
  private ledgerFile: string;
  private cached?: { lessonsAt: number | undefined; ledgerAt: number | undefined; view: JournalView };

  constructor(lessonsFile: string, ledgerFile: string) {
    this.lessonsFile = lessonsFile;
    this.ledgerFile = ledgerFile;
  }

  /**
   * The journal as both files stand. Both mtimes unchanged since the last read answers the cached view: a stat, not a
   * read. A file that was not there and now is (or was there and is gone) is a change, so a ledger the first wrap-up
   * writes is seen without the store being told.
   */
  view(): JournalView {
    const lessonsAt = mtimeOf(this.lessonsFile);
    const ledgerAt = mtimeOf(this.ledgerFile);
    const cached = this.cached;
    if (cached && cached.lessonsAt === lessonsAt && cached.ledgerAt === ledgerAt) return cached.view;
    const view = journalView(readLessonsFile(this.lessonsFile), parseLessonsLedger(readOptional(this.ledgerFile)));
    this.cached = { lessonsAt, ledgerAt, view };
    return view;
  }
}
