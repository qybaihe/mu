import { beforeAll, describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import type { Activity } from '@/common/kyrn/types';
import {
  foldRepeats,
  itemSentence,
  logItems,
  namesLessons,
  type LogItem,
} from '@/renderer/pages/conversation/KyrnPanel/Judge/log';
import common from '@/renderer/services/i18n/locales/en-US/common.json';
import { event as recorded, turn, verdict } from './judgeFixtures';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { translation: { common } } }, interpolation: { escapeValue: false } });
});

/** The log's line for a message's classification, from what the harness recorded about it. */
function classification(...events: Activity[]): string | undefined {
  const item = logItems(events).find((each) => each.type === 'judgment');
  return item && itemSentence(i18n.t, item);
}
const answeredBy = (by: string) =>
  classification(recorded('preflight.verdict', verdict({ by }), turn('runtime', 1, 2)));
/** A classification that came to nothing, for the reason the harness gave. */
const noClass = (reasonCode: string) =>
  classification(
    recorded('preflight.verdict', verdict({ state: 'none', turnType: 'unknown', reasonCode }), turn('runtime', 1, 2))
  );

/** What a line of the log says. */
const sentence = (item: LogItem): string => itemSentence(i18n.t, item);

let sequence = 0;
const event = (kind: string, payload: Record<string, unknown> = {}): Activity => ({
  id: `${kind}:${++sequence}`,
  at: sequence,
  kind,
  payload,
  runtimeId: 'runtime',
  sequence,
});

describe('the judge log', () => {
  it('leaves the board to the board tab: neither its boards nor the lines of its account are listed', () => {
    const items = logItems([
      event('board.update', { now: 'Changing the code.', progress: 'Halfway.' }),
      event('board.note', { sequence: 1, at: 1, kind: 'step', text: 'Changed src/a.ts', by: 'rules' }),
      event('goal.state', { status: 'active' }),
    ]);
    expect(items.map((item) => (item.type === 'event' ? item.event.kind : item.type))).toEqual(['goal.state']);
  });

  it('lists a task frame restored as the conversation opens again only when it reads differently', () => {
    const frame = (goal: string, reason: string) =>
      event('frame.updated', {
        frame: { version: 1, goal },
        openQuestionCodes: [],
        reason,
        stale: false,
        unmerged: [],
      });
    const items = logItems([
      frame('Map the swarm', 'created'),
      frame('Map the swarm, then fix it', 'progress'),
      // Opened again three times: the same frame, restored each time.
      frame('Map the swarm, then fix it', 'restored'),
      frame('Map the swarm, then fix it', 'restored'),
      frame('Map the swarm, then fix it', 'restored'),
      frame('Fix the swarm', 'progress'),
    ]);
    const goals = items.map((item) => (item.type === 'event' ? item.event.payload.frame : undefined));
    expect(goals).toEqual([
      { version: 1, goal: 'Map the swarm' },
      { version: 1, goal: 'Map the swarm, then fix it' },
      { version: 1, goal: 'Fix the swarm' },
    ]);
  });

  it('asks for the lessons’ words where a judgment names lessons: the ones brought in and the ones followed', () => {
    const judged = (specId: string) =>
      logItems([event('decision', { id: `${specId}-1`, specId, source: 'judge', outcome: { apply: ['a'] } })])[0];
    expect(namesLessons(judged('memory.recall'))).toBe(true);
    expect(namesLessons(judged('memory.applied'))).toBe(true);
    expect(namesLessons(judged('memory.worth'))).toBe(false);
  });
});

describe('a classification in the judge log', () => {
  const task = common.kyrn.judgeView.values.multi_step_task;

  it('names the judge that answered: the first judge of a cascade, and a judge the app does not know as it is', () => {
    expect(answeredBy('jev-latest')).toBe(`Classified by Jev: ${task}`);
    expect(answeredBy('clm-8b>jev-latest')).toBe(`Classified by CLM: ${task}`);
    expect(answeredBy('clm-8b')).toBe(`Classified by CLM: ${task}`);
    expect(answeredBy('my-judge')).toBe(`Classified by my-judge: ${task}`);
    // Waiting, the line names the judge that was asked.
    expect(
      classification(recorded('preflight.pending', { judge: 'clm-8b', mode: 'active' }, turn('runtime', 1, 2)))
    ).toBe('CLM is classifying this message…');
  });

  it('says why a classification came to nothing: no judge, no answer, switched off, skipped, or no clear class', () => {
    expect(noClass('error:auth')).toBe(common.kyrn.judgeLine.noJudge);
    expect(noClass('error:unreachable')).toBe("Jev didn't answer this time; continuing as usual");
    expect(noClass('off')).toBe(common.kyrn.judgeLine.off);
    expect(noClass('skipped')).toBe(common.kyrn.judgeLine.skipped);
    expect(noClass('abstain')).toBe('Jev gave no clear answer this time; continuing as usual');
    // A wait that ran out is the judge not answering in time.
    expect(
      classification(
        recorded('preflight.pending', { judge: 'clm-8b' }, turn('runtime', 1, 2)),
        recorded('preflight.wait_end', { reason: 'timeout', waitedMs: 3000 }, turn('runtime', 1, 3))
      )
    ).toBe("CLM didn't answer this time; continuing as usual");
  });
});

describe('the judge log’s permission lines', () => {
  it('words an answer with the call its question named, asked in the same harness process', () => {
    const items = logItems([
      recorded('permissions.request', { id: 'permission-1', kind: 'shell', summary: 'rm -rf build' }, turn('a', 1, 1)),
      recorded('permissions.resolved', { id: 'permission-1', toolCallId: 'call-1', answer: 'deny' }, turn('a', 1, 2)),
      // Another harness process counts its questions from 1 again: its answer is not about that call.
      recorded('permissions.resolved', { id: 'permission-1', answer: 'once' }, turn('b', 1, 1)),
    ]);
    expect(items.map(sentence)).toEqual([
      'Waiting for your permission: rm -rf build',
      "You didn't allow it: rm -rf build",
      'You allowed it once',
    ]);
    // The record stays as it came.
    expect(items[1]).toMatchObject({
      about: 'rm -rf build',
      event: { payload: { id: 'permission-1', answer: 'deny' } },
    });
    expect(items[1].type === 'event' && items[1].event.payload.summary).toBeUndefined();
  });
});

describe('the judge log’s repeated lines', () => {
  const look = (text: string) => recorded('ttsr.interrupted', { text });

  it('are one line with a count, keyed by the first record and showing the latest', () => {
    const items = logItems([look('rule a'), look('rule a'), look('rule a'), look('rule b'), look('rule a')]);
    const rows = foldRepeats(items, sentence);
    expect(rows.map((row) => [sentence(row.item), row.count])).toEqual([
      [sentence(items[0]), 3],
      [sentence(items[3]), 1],
      [sentence(items[4]), 1],
    ]);
    expect(rows[0].key).toBe(items[0].id);
    expect(rows[0].item).toBe(items[2]);
  });

  it('fold only when the code is the same too', () => {
    const items = logItems([look('x'), recorded('mcp.started', { id: 'mcp:a', name: 'a', tools: [] }), look('x')]);
    expect(foldRepeats(items, () => 'the same words').map((row) => row.count)).toEqual([1, 1, 1]);
  });
});
