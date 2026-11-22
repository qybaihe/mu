import { describe, expect, it } from 'vitest';
import { JOURNAL_CAP, journalOf, journalView, parseLessonsLedger } from '@/common/kyrn/journal';
import { parseLessons } from '@/common/kyrn/lessons';

const LEDGER = [
  '<!-- mu-desktop lessons v1 -->',
  '# 岗位教训总账（各岗收尾经 teams.cjs lesson 追加，勿手改）',
  '',
  '2026-11-21 | forwarder | 读 HANDOFF 先读当前目标节再动工',
  '2026-11-22 | mu-dev | E2E 给忙碌会话 POST 消息会被静默拒收 | 分号也不分行',
  'not a lesson line',
  '2026-11-22 | e2e-think-worker | 权限体系评审时先拆两个轴',
].join('\n');

describe('the positions’ ledger', () => {
  it('holds one entry per `date | position | text` line, in file order', () => {
    expect(parseLessonsLedger(LEDGER)).toEqual([
      { date: '2026-11-21', position: 'forwarder', text: '读 HANDOFF 先读当前目标节再动工' },
      { date: '2026-11-22', position: 'mu-dev', text: 'E2E 给忙碌会话 POST 消息会被静默拒收 | 分号也不分行' },
      { date: '2026-11-22', position: 'e2e-think-worker', text: '权限体系评审时先拆两个轴' },
    ]);
  });

  it('skips the marker, the heading, blanks and bad lines without losing the rest', () => {
    expect(parseLessonsLedger('')).toEqual([]);
    expect(parseLessonsLedger('20261122 | x | a date that is not shaped like one')).toEqual([]);
    expect(parseLessonsLedger('2026-11-22 | only two parts')).toEqual([]);
    // A Windows line ending is one line ending.
    expect(parseLessonsLedger('2026-11-22 | p | one\r\n2026-11-22 | p | two')).toEqual([
      { date: '2026-11-22', position: 'p', text: 'one' },
      { date: '2026-11-22', position: 'p', text: 'two' },
    ]);
  });
});

describe('the journal of two sources', () => {
  const lessons = parseLessons(
    [
      JSON.stringify({
        id: 'a',
        kind: 'pitfall',
        trigger: 'when a',
        lesson: 'Lesson a.',
        cwd: 'E:/Projects/mu',
        updated: '2026-11-22T06:00:00.000Z',
      }),
      JSON.stringify({
        id: 'b',
        kind: 'preference',
        trigger: 'when b',
        lesson: 'Lesson b, everywhere.',
        updated: '2026-11-21T18:00:00.000Z',
      }),
      JSON.stringify({
        id: 'c',
        kind: 'correction',
        trigger: 'when c',
        lesson: 'Lesson c.',
        cwd: 'E:/work/other',
        updated: '2026-11-23T09:00:00.000Z',
      }),
    ].join('\n')
  );

  it('flattens both sources to one entry each, newest day first', () => {
    const entries = journalOf(lessons, parseLessonsLedger(LEDGER));
    expect(entries.map((entry) => entry.id)).toEqual([
      'c', // 2026-11-23, the newest day
      'a', // 2026-11-22, a lesson: lessons come before the ledger within a day (a decided tie-break)
      'ledger:2', // 2026-11-22, the ledger's last line is its newest
      'ledger:1',
      'b', // 2026-11-21, older than every line above
      'ledger:0',
    ]);
    expect(entries[1]).toEqual({
      id: 'a',
      source: 'lessons',
      kind: 'pitfall',
      text: 'Lesson a.',
      at: '2026-11-22T06:00:00.000Z',
      scope: 'E:/Projects/mu',
    });
    expect(entries[2]).toEqual({
      id: 'ledger:2',
      source: 'positions',
      kind: 'position',
      text: '权限体系评审时先拆两个轴',
      at: '2026-11-22',
      scope: 'e2e-think-worker',
    });
    // A lesson without a project holds everywhere: no scope, the entry says so by not having one.
    expect(entries[4].scope).toBeUndefined();
  });

  it('orders the lessons of one day by their exact time, newest first', () => {
    const day = parseLessons(
      [
        JSON.stringify({ id: 'early', trigger: 't', lesson: 'l', updated: '2026-11-22T01:00:00.000Z' }),
        JSON.stringify({ id: 'late', trigger: 't', lesson: 'l', updated: '2026-11-22T23:00:00.000Z' }),
      ].join('\n')
    );
    expect(journalOf(day, []).map((entry) => entry.id)).toEqual(['late', 'early']);
  });

  it('holds nothing when both sources are empty', () => {
    expect(journalOf(parseLessons(''), parseLessonsLedger(''))).toEqual([]);
  });
});

describe('the journal’s cap', () => {
  const many = Array.from({ length: JOURNAL_CAP + 10 }, (_, index) =>
    JSON.stringify({
      id: `l${index}`,
      trigger: 't',
      lesson: `Lesson ${index}.`,
      updated: `2026-11-${String(1 + (index % 20)).padStart(2, '0')}T12:00:00.000Z`,
    })
  ).join('\n');

  it('shows the newest JOURNAL_CAP entries and says how many there are in all', () => {
    const view = journalView(parseLessons(many), parseLessonsLedger('2026-11-22 | p | one line'));
    expect(view.total).toBe(JOURNAL_CAP + 11);
    expect(view.entries).toHaveLength(JOURNAL_CAP);
    expect(view.entries[0].text).toBe('one line'); // 2026-11-22 beats every lesson day at most 2026-11-20
  });
});
