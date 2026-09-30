import { describe, expect, it } from 'vitest';
import { reduceAll, type NativeView } from '@/common/utils/nativeHost';
import { forkableIds, forkPoint } from '@/renderer/pages/native/utils/forkPoint';
import { delta, ended, reply, text, user } from './records';

/**
 * Where a message's fork button goes (utils/forkPoint.ts): the person's message forks before it and brings its text
 * back; mu's reply forks at the person's next message, or clones the branch when it is the last.
 */

const twoTurns = (): NativeView =>
  reduceAll([
    ended(user('first question'), 'u1'),
    ended(reply([text('first answer')]), 'a1'),
    ended(user('second question'), 'u2'),
    ended(reply([text('second answer')]), 'a2'),
  ]);

const idOf = (view: NativeView, role: 'user' | 'assistant', nth: number): string =>
  view.messages.filter((message) => message.role === role)[nth].id;

describe('forkPoint', () => {
  it('forks before the person’s message and asks for its text back', () => {
    const view = twoTurns();
    expect(forkPoint(view, idOf(view, 'user', 1))).toEqual({ command: { type: 'fork', entryId: 'u2' }, fill: true });
    expect(forkPoint(view, idOf(view, 'user', 0))).toEqual({ command: { type: 'fork', entryId: 'u1' }, fill: true });
  });

  it('forks a reply at the person’s next message, and wants no text of it', () => {
    const view = twoTurns();
    expect(forkPoint(view, idOf(view, 'assistant', 0))).toEqual({
      command: { type: 'fork', entryId: 'u2' },
      fill: false,
    });
  });

  it('clones the branch for the last reply', () => {
    const view = twoTurns();
    expect(forkPoint(view, idOf(view, 'assistant', 1))).toEqual({ command: { type: 'clone' }, fill: false });
  });

  it('has no point for a message that is not there, or has no entry', () => {
    const view = twoTurns();
    expect(forkPoint(view, 'nope')).toBeUndefined();
    // A record from a harness that does not say which entry a message is saved as.
    const old = reduceAll([ended(user('first question')), ended(reply([text('first answer')]))]);
    expect(forkPoint(old, idOf(old, 'user', 0))).toBeUndefined();
    expect(forkPoint(old, idOf(old, 'assistant', 0))).toBeUndefined();
  });

  it('has no point for the person’s next message when it has no entry, nor for a reply that is still written', () => {
    const view = reduceAll([
      ended(user('first question'), 'u1'),
      ended(reply([text('first answer')]), 'a1'),
      ended(user('second question')),
    ]);
    expect(forkPoint(view, idOf(view, 'assistant', 0))).toBeUndefined();
    const writing = reduceAll([
      ended(user('first question'), 'u1'),
      { type: 'message_start', message: reply([text('')]) },
      delta({ type: 'text_delta', contentIndex: 0, delta: 'partial' }),
    ]);
    const last = writing.messages.at(-1);
    expect(last?.role === 'assistant' && last.streaming).toBe(true);
    expect(forkPoint(writing, last?.id ?? '')).toBeUndefined();
  });
});

describe('forkableIds', () => {
  it('names the messages forkPoint has a point for, in one pass', () => {
    const views: NativeView[] = [
      twoTurns(),
      reduceAll([ended(user('first question')), ended(reply([text('first answer')]))]),
      reduceAll([
        ended(user('first question'), 'u1'),
        ended(reply([text('first answer')]), 'a1'),
        ended(user('second question')),
      ]),
      reduceAll([ended(user('first question'), 'u1'), { type: 'message_start', message: reply([text('')]) }]),
    ];
    for (const view of views) {
      const found = forkableIds(view);
      for (const message of view.messages)
        expect(found.has(message.id)).toBe(forkPoint(view, message.id) !== undefined);
    }
    // The first view has all four.
    expect(forkableIds(views[0]).size).toBe(4);
  });
});
