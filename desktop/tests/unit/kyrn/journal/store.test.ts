import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SHARED_TEAMS_FOLDER } from '@/common/chat/team/supervisor/supervisorCore';
import { JOURNAL_CAP, type JournalView } from '@/common/kyrn/journal';
import { JournalStore, lessonsLedgerFile } from '@/process/agent/kyrn/journal';

const dirs: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mu-journal-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Writes a file and moves its mtime to a chosen moment, so the next write is always a change the cache can see. */
function writeAt(path: string, text: string, at: Date): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  utimesSync(path, at, at);
}

const LESSONS = `${JSON.stringify({ id: 'one', trigger: 't', lesson: 'Lesson one.', updated: '2026-11-22T06:00:00.000Z' })}\n`;
const LEDGER = `${['<!-- mu-desktop lessons v1 -->', '# 岗位教训总账', '2026-11-22 | mu-dev | Wrap-up line one.'].join(
  '\n'
)}\n`;

/** A store over two temp files that exist, written a second apart so mtimes never collide. */
function storeOf(): { store: JournalStore; lessons: string; ledger: string } {
  const dir = temp();
  const lessons = join(dir, 'lessons.jsonl');
  const ledger = join(dir, 'positions', SHARED_TEAMS_FOLDER, 'LESSONS.md');
  writeAt(lessons, LESSONS, new Date('2026-11-22T10:00:00.000Z'));
  writeAt(ledger, LEDGER, new Date('2026-11-22T10:00:01.000Z'));
  return { store: new JournalStore(lessons, ledger), lessons, ledger };
}

describe('the ledger’s place', () => {
  it('is the shared folder of one profile’s data dir', () => {
    expect(lessonsLedgerFile('C:/Users/a/AppData/Roaming/mu-fork')).toBe(
      join('C:/Users/a/AppData/Roaming/mu-fork', 'positions', SHARED_TEAMS_FOLDER, 'LESSONS.md')
    );
  });
});

describe('the journal store', () => {
  it('holds no entries while neither file is there', () => {
    const dir = temp();
    expect(new JournalStore(join(dir, 'lessons.jsonl'), lessonsLedgerFile(dir)).view()).toEqual({
      entries: [],
      total: 0,
    });
  });

  it('answers both files as one view, newest first', () => {
    const { store } = storeOf();
    expect(store.view()).toEqual({
      total: 2,
      entries: [
        {
          id: 'one',
          source: 'lessons',
          kind: 'correction',
          text: 'Lesson one.',
          at: '2026-11-22T06:00:00.000Z',
        },
        {
          id: 'ledger:0',
          source: 'positions',
          kind: 'position',
          text: 'Wrap-up line one.',
          at: '2026-11-22',
          scope: 'mu-dev',
        },
      ],
    });
  });

  it('answers the same view, the very object, while neither file has moved', () => {
    const { store } = storeOf();
    const first = store.view();
    expect(store.view()).toBe(first);
  });

  it('reads again once the ledger is appended to, and keeps what the lessons file said', () => {
    const { store, ledger } = storeOf();
    const first: JournalView = store.view();
    writeAt(ledger, `${LEDGER}2026-11-23 | forwarder | Wrap-up line two.\n`, new Date('2026-11-23T09:00:00.000Z'));
    const second = store.view();
    expect(second).not.toBe(first);
    expect(second.entries.map((entry) => entry.id)).toEqual(['ledger:1', 'one', 'ledger:0']);
  });

  it('reads again once the lessons file is written to', () => {
    const { store, lessons } = storeOf();
    const first = store.view();
    writeAt(
      lessons,
      `${LESSONS}${JSON.stringify({ id: 'two', trigger: 't', lesson: 'Lesson two.', updated: '2026-11-24T00:00:00.000Z' })}\n`,
      new Date('2026-11-24T00:00:01.000Z')
    );
    const second = store.view();
    expect(second).not.toBe(first);
    expect(second.entries[0].id).toBe('two');
  });

  it('sees a ledger that was not there when the store first read', () => {
    const dir = temp();
    const lessons = join(dir, 'lessons.jsonl');
    writeAt(lessons, LESSONS, new Date('2026-11-22T10:00:00.000Z'));
    const ledger = lessonsLedgerFile(dir);
    const store = new JournalStore(lessons, ledger);
    expect(store.view().total).toBe(1);
    writeAt(ledger, LEDGER, new Date('2026-11-22T11:00:00.000Z'));
    expect(store.view().total).toBe(2);
  });

  it('caps the entries it answers at the journal’s cap', () => {
    const dir = temp();
    const lessons = join(dir, 'lessons.jsonl');
    writeAt(
      lessons,
      `${Array.from({ length: JOURNAL_CAP + 5 }, (_, index) =>
        JSON.stringify({
          id: `l${index}`,
          trigger: 't',
          lesson: `Lesson ${index}.`,
          updated: `2026-11-22T0${index % 10}:00:00.000Z`,
        })
      ).join('\n')}\n`,
      new Date('2026-11-22T10:00:00.000Z')
    );
    const store = new JournalStore(lessons, lessonsLedgerFile(dir));
    const view = store.view();
    expect(view.entries).toHaveLength(JOURNAL_CAP);
    expect(view.total).toBe(JOURNAL_CAP + 5);
  });
});
