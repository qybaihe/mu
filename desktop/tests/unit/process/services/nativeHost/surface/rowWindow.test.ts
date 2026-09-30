import { describe, expect, it } from 'vitest';
import type { TMessage } from '@/common/chat/chatLib';
import { windowStart } from '@/renderer/pages/native/utils/rowWindow';

const row = (id: string, position: 'left' | 'right'): TMessage =>
  ({
    id,
    conversation_id: 'c1',
    type: 'text',
    position,
    created_at: 1,
    content: { content: id },
  }) as TMessage;

/** A step of mu's work: the list folds consecutive ones into one row. */
const step = (
  id: string,
  type: 'tool_group' | 'acp_tool_call' | 'tool_call' | 'thinking' = 'acp_tool_call'
): TMessage =>
  ({ id, conversation_id: 'c1', type, position: 'left', created_at: 1, content: {} }) as unknown as TMessage;

/** `turns` turns of a person's message and `replies` replies to it (as text rows). */
const turns = (count: number, replies = 1): TMessage[] => {
  const rows: TMessage[] = [];
  for (let turn = 0; turn < count; turn++) {
    rows.push(row(`u${turn}`, 'right'));
    for (let reply = 0; reply < replies; reply++) rows.push(row(`a${turn}.${reply}`, 'left'));
  }
  return rows;
};

describe('windowStart', () => {
  it('shows everything when there are no more rows than the window', () => {
    expect(windowStart([], 10)).toBe(0);
    expect(windowStart(turns(5), 10)).toBe(0);
    expect(windowStart(turns(5), 5 * 2)).toBe(0);
  });

  it('starts at the cut when a person message is there', () => {
    // 20 rows, u0 a0 u1 a1 ...: the cut for the latest 10 is row 10, a person message.
    expect(windowStart(turns(10), 10)).toBe(10);
  });

  it('starts at the message that opens the turn the cut falls in, so no turn shows without its start', () => {
    // 4 rows a turn (u a a a): the cut for 10 of 40 is row 30, the second reply of turn 7; turn 7 starts at row 28.
    const rows = turns(10, 3);
    expect(windowStart(rows, 10)).toBe(28);
    expect(rows[28].id).toBe('u7');
  });

  it('cuts where the cut falls when the turn is longer than another window', () => {
    // One person message, then 100 rows of replies: the turn begins farther back than the window is long.
    const rows = [row('u0', 'right'), ...Array.from({ length: 100 }, (_, index) => row(`a${index}`, 'left'))];
    expect(windowStart(rows, 10)).toBe(91);
  });

  it('pages back from a row, and reaches the first row in steps that always move up', () => {
    const rows = turns(50, 2);
    let start = windowStart(rows, 20);
    const seen = [start];
    while (start > 0) {
      const next = windowStart(rows, 20, start);
      expect(next).toBeLessThan(start);
      seen.push(next);
      start = next;
    }
    expect(seen.at(-1)).toBe(0);
    // Every step shows a turn from its start, except the last that reaches the first row.
    for (const at of seen) expect(rows[at].id).toMatch(/^u/);
  });

  it('does not cut a run of steps in two: the row a reader is on would take another name when the rows before it come', () => {
    // A person message, a reply, 30 steps, a reply, 30 more steps, a reply. The cut for the latest 20 falls inside the
    // second run; the window starts where that run does.
    const rows = [
      row('u0', 'right'),
      row('a0', 'left'),
      ...Array.from({ length: 30 }, (_, index) => step(`s${index}`)),
      row('a1', 'left'),
      ...Array.from({ length: 30 }, (_, index) => step(`t${index}`)),
      row('a2', 'left'),
    ];
    const at = windowStart(rows, 20);
    expect(rows[at].id).toBe('t0');
    expect(rows[at - 1].id).toBe('a1');
    // Any kind of step is one, and a thought is one: the cut for the latest 4 falls on the thought, in the middle.
    const mixed = [
      row('a-1', 'left'),
      row('a-2', 'left'),
      row('a-3', 'left'),
      row('a-4', 'left'),
      step('x0', 'tool_group'),
      step('x1', 'thinking'),
      step('x2', 'tool_call'),
      step('x3'),
      row('a1', 'left'),
    ];
    expect(mixed[windowStart(mixed, 4)].id).toBe('x0');
  });

  it('cuts inside a run that is longer than another window, and a step up still moves up', () => {
    const rows = [row('u0', 'right'), ...Array.from({ length: 100 }, (_, index) => step(`s${index}`))];
    expect(windowStart(rows, 10)).toBe(91);
    // A run within another window of the cut is shown whole: the window goes back to where the run began.
    const around = [
      row('a-1', 'left'),
      row('a0', 'left'),
      ...Array.from({ length: 8 }, (_, index) => step(`s${index}`)),
      row('a1', 'left'),
    ];
    expect(around[windowStart(around, 6, around.length)].id).toBe('s0');
    let start = windowStart(rows, 20);
    while (start > 0) {
      const next = windowStart(rows, 20, start);
      expect(next).toBeLessThan(start);
      start = next;
    }
    expect(start).toBe(0);
  });
});
