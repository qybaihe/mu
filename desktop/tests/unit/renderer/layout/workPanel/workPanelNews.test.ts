import { describe, expect, it } from 'vitest';
import type { Activity } from '@/common/kyrn/types';
import {
  boardSignature,
  createEditWatcher,
  hiveSignature,
  judgeSignature,
  lessonsSignature,
} from '@/renderer/components/layout/WorkPanel/news';

let next = 0;
const event = (kind: string, payload: Record<string, unknown>, extra: Partial<Activity> = {}): Activity => ({
  id: `e${++next}`,
  at: ++next,
  kind,
  payload,
  ...extra,
});
const board = (payload: Record<string, unknown> = {}) =>
  event('board.update', {
    progress: 'Half the tests pass.',
    now: 'Fixing the login test',
    confirm: [],
    phase: 'fixing',
    needsUser: false,
    done: 1,
    total: 2,
    by: 'model',
    ended: false,
    ...payload,
  });
const snapshot = (bees: Record<string, unknown>[], run = 'run-1') =>
  event('swarm.snapshot', { kind: 'hive', title: 'goal', bees }, { run });
/** An ACP tool call update, as the response stream carries it. */
const acp = (update: Record<string, unknown>) => ({ type: 'acp_tool_call', data: { update } });
/** A Gemini-style tool group with one edit in it. */
const group = (status: string) => ({
  type: 'tool_group',
  data: [{ call_id: 'c1', status, result_display: { file_diff: '--- a\n+++ b' } }],
});

describe('what counts as news in each tab', () => {
  it('the board: new words are news; the board replayed as the session opens is not', () => {
    expect(boardSignature([])).toBe('');
    const first = boardSignature([board()]);
    expect(first).not.toBe('');
    expect(boardSignature([board(), board({ restored: true })])).toBe(first);
    expect(boardSignature([board(), board({ now: 'Running the tests' })])).not.toBe(first);
  });

  it('the judge: a verdict is news, the wait before it is not', () => {
    const turn = { runtimeId: 'runtime-a', turnId: 1 };
    const waiting = [event('preflight.pending', { judge: 'jev' }, { ...turn, sequence: 1 })];
    expect(judgeSignature(waiting)).toBe('');
    const judged = [
      ...waiting,
      event('preflight.verdict', { state: 'applied', turnType: 'chat', hints: [] }, { ...turn, sequence: 2 }),
    ];
    expect(judgeSignature(judged)).not.toBe('');
  });

  it('the hive: a sub-agent starting, finishing or failing is news; moving between thinking and a tool is not', () => {
    const thinking = hiveSignature([snapshot([{ name: 'scout', status: 'thinking' }])]);
    expect(hiveSignature([snapshot([{ name: 'scout', status: 'tool' }])])).toBe(thinking);
    expect(hiveSignature([snapshot([{ name: 'scout', status: 'done' }])])).not.toBe(thinking);
    expect(hiveSignature([snapshot([{ name: 'scout', status: 'failed' }])])).not.toBe(thinking);
    expect(
      hiveSignature([
        snapshot([
          { name: 'scout', status: 'thinking' },
          { name: 'critic', status: 'queued' },
        ]),
      ])
    ).not.toBe(thinking);
  });

  it('the lessons: each lesson stored, brought into a turn, followed, retired or merged is news; nothing else is', () => {
    const stored = event('memory.stored', { id: 'lesson-1' });
    const first = lessonsSignature([stored, board()]);
    expect(lessonsSignature([])).toBe('');
    expect(first).not.toBe('');
    expect(lessonsSignature([stored, board(), board({ now: 'Running the tests' })])).toBe(first);
    const events = [stored];
    for (const kind of ['memory.recalled', 'memory.applied', 'memory.retired', 'memory.merged']) {
      const before = lessonsSignature(events);
      events.push(event(kind, { ids: ['lesson-1'] }));
      expect(lessonsSignature(events)).not.toBe(before);
    }
  });

  it('the files: an edit the agent finished, told once, whatever the stream it came in', () => {
    const edited = createEditWatcher();
    // The kind comes with the call's start only; the status alone comes with its end.
    expect(edited(acp({ tool_call_id: 't1', kind: 'edit', status: 'in_progress' }))).toBe(false);
    expect(edited(acp({ tool_call_id: 't1', status: 'completed' }))).toBe(true);
    expect(edited(acp({ tool_call_id: 't2', kind: 'read', status: 'completed' }))).toBe(false);
    expect(edited(acp({ tool_call_id: 't3', status: 'completed', content: [{ type: 'diff' }] }))).toBe(true);
    expect(edited(acp({ tool_call_id: 't4', kind: 'edit', status: 'failed' }))).toBe(false);

    expect(edited(group('Executing'))).toBe(false);
    expect(edited(group('Success'))).toBe(true);
    // The same finished call streamed again is not a second edit.
    expect(edited(group('Success'))).toBe(false);
    expect(edited({ type: 'content', data: 'hello' })).toBe(false);
  });
});
