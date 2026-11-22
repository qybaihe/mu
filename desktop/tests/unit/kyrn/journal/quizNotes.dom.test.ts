/**
 * The quiz's progress store (side-tutor case 3): the passes the journal's badges read, kept in localStorage beside the
 * task-verification verdicts — one pass per entry, void the moment the entry's own `at` moves (an edited lesson is a
 * new lesson to test), capped, and nothing ever written to the lessons file.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearQuizProgress,
  quizPassed,
  quizProgressSnapshot,
  recordQuizPass,
  resetQuizProgressCache,
  subscribeQuizProgress,
} from '@renderer/pages/conversation/KyrnPanel/Journal/quizNotes';

beforeEach(() => {
  localStorage.clear();
  resetQuizProgressCache();
});

describe('the quiz progress store', () => {
  it('records a pass and reads it back, from the store and from localStorage', () => {
    recordQuizPass({ entryId: 'a', entryAt: '2026-11-22T06:00:00.000Z', hash: 'ab12cd34', at: 1000 });
    expect(quizPassed('a', '2026-11-22T06:00:00.000Z')).toBe(true);
    expect(quizProgressSnapshot().get('a')).toEqual({
      entryId: 'a',
      entryAt: '2026-11-22T06:00:00.000Z',
      hash: 'ab12cd34',
      at: 1000,
    });
    // And it is really in localStorage: a fresh cache reads the same pass.
    resetQuizProgressCache();
    expect(quizPassed('a', '2026-11-22T06:00:00.000Z')).toBe(true);
  });

  it('voids a pass whose entry has moved — an edited lesson is re-tested', () => {
    recordQuizPass({ entryId: 'a', entryAt: '2026-11-22T06:00:00.000Z', hash: 'ab12cd34', at: 1000 });
    expect(quizPassed('a', '2026-11-22T09:00:00.000Z')).toBe(false);
    expect(quizPassed('b', '2026-11-22T06:00:00.000Z')).toBe(false);
  });

  it('keeps one pass per entry — the newest replaces the older', () => {
    recordQuizPass({ entryId: 'a', entryAt: '2026-11-22T06:00:00.000Z', hash: 'one', at: 1000 });
    recordQuizPass({ entryId: 'a', entryAt: '2026-11-23T06:00:00.000Z', hash: 'two', at: 2000 });
    expect(quizProgressSnapshot().size).toBe(1);
    expect(quizPassed('a', '2026-11-23T06:00:00.000Z')).toBe(true);
    expect(quizPassed('a', '2026-11-22T06:00:00.000Z')).toBe(false);
  });

  it('drops the oldest when the cap is full', () => {
    for (let index = 0; index < 410; index++) {
      recordQuizPass({ entryId: `e${index}`, entryAt: '2026-11-22T06:00:00.000Z', hash: 'h', at: index });
    }
    const snapshot = quizProgressSnapshot();
    expect(snapshot.size).toBe(400);
    expect(snapshot.has('e0')).toBe(false);
    expect(snapshot.has('e409')).toBe(true);
  });

  it('survives broken storage gracefully', () => {
    localStorage.setItem('quiz-progress-v1', '{not json');
    resetQuizProgressCache();
    expect(quizPassed('a', '2026-11-22T06:00:00.000Z')).toBe(false);
    localStorage.setItem('quiz-progress-v1', JSON.stringify([{ entryId: 1 }, { entryId: 'a' }]));
    resetQuizProgressCache();
    expect(quizPassed('a', '2026-11-22T06:00:00.000Z')).toBe(false);
    expect(quizProgressSnapshot().size).toBe(0);
  });

  it('tells its listeners when a pass lands, and stops telling after unsubscribe', () => {
    let told = 0;
    const stop = subscribeQuizProgress(() => {
      told += 1;
    });
    recordQuizPass({ entryId: 'a', entryAt: 'at', hash: 'h', at: 1 });
    expect(told).toBe(1);
    stop();
    recordQuizPass({ entryId: 'b', entryAt: 'at', hash: 'h', at: 2 });
    expect(told).toBe(1);
    clearQuizProgress();
    expect(quizProgressSnapshot().size).toBe(0);
  });
});
