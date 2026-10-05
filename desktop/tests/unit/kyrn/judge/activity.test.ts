import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LANGUAGES } from '@/common/config/i18n';
import {
  answerRows,
  DECISIONS,
  judgeCards,
  readReason,
  reasonCode,
  resultFacts,
  runtimeEvents,
  stageOf,
} from '../../../../packages/desktop/src/renderer/pages/conversation/KyrnPanel/Judge/activity';
import { JUDGE_QUESTIONS } from '../../../../packages/desktop/src/renderer/pages/conversation/KyrnPanel/Judge/questions';
import common from '../../../../packages/desktop/src/renderer/services/i18n/locales/en-US/common.json';
import zhCN from '../../../../packages/desktop/src/renderer/services/i18n/locales/zh-CN/common.json';
import zhTW from '../../../../packages/desktop/src/renderer/services/i18n/locales/zh-TW/common.json';
import { event, gate, ledger, turn, verdict } from './judgeFixtures';

describe('Jev judgment cards: what is folded together', () => {
  it('folds the phases of one classification that share a runtime and a turn', () => {
    const cards = judgeCards([
      event('preflight.pending', { judge: 'jev-latest', mode: 'active' }, turn('runtime-a', 3, 20)),
      event('decision', ledger(), turn('runtime-a', 3, 21)),
      event('preflight.verdict', verdict(), turn('runtime-a', 3, 22)),
      event('preflight.wait_end', { reason: 'verdict', waitedMs: 702 }, turn('runtime-a', 3, 23)),
      event('preflight.verdict', verdict(), turn('runtime-a', 3, 25)),
    ]);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ stage: 'preflight', state: 'returned', unlinked: false, model: 'jev-1.13.0' });
    expect(cards[0].evidence).toHaveLength(5);
  });

  it('never merges the same turn number across two runtimes', () => {
    // Every runtime counts its turns from 1, so a reconnect repeats the numbers.
    const cards = judgeCards([
      event('preflight.pending', { judge: 'jev-latest', mode: 'active' }, turn('runtime-a', 1, 2)),
      event('preflight.verdict', verdict({ turnType: 'chat', gear: 'chat' }), turn('runtime-a', 1, 4)),
      event('preflight.pending', { judge: 'jev-latest', mode: 'active' }, turn('runtime-b', 1, 2)),
      event(
        'preflight.verdict',
        verdict({ state: 'late', turnType: 'research', gear: 'heavy' }),
        turn('runtime-b', 1, 4)
      ),
    ]);

    expect(cards).toHaveLength(2);
    const [second, first] = cards;
    expect(first.outcome).toEqual({ turnType: 'chat', gear: 'chat' });
    expect(first.state).toBe('returned');
    expect(second.outcome).toEqual({ turnType: 'research', gear: 'heavy' });
    expect(second.state).toBe('late');
    expect(first.evidence.every((record) => record.runtimeId === 'runtime-a')).toBe(true);
    expect(second.evidence.every((record) => record.runtimeId === 'runtime-b')).toBe(true);
  });

  it('does not treat a runtime id without a turn, or a turn without a runtime id, as correlation', () => {
    const cards = judgeCards([
      event('preflight.verdict', verdict(), { runtimeId: 'runtime-a' }),
      event('preflight.verdict', verdict(), { turnId: 1, sequence: 3 }),
    ]);

    expect(cards).toHaveLength(2);
    expect(cards.every((card) => card.unlinked)).toBe(true);
  });

  it('keeps old records without correlation apart, however close in time they are', () => {
    // The shape written before correlation fields existed: five records within three milliseconds.
    const at = 5_000;
    const records = [
      { ...event('preflight.pending', { judge: 'jev-latest', mode: 'active' }), at },
      { ...event('decision', ledger()), at: at + 1 },
      { ...event('preflight.verdict', verdict()), at: at + 1 },
      { ...event('preflight.wait_end', { reason: 'verdict', waitedMs: 650 }), at: at + 2 },
      { ...event('preflight.verdict', verdict({ hints: ['Write a short plan first.'] })), at: at + 3 },
    ];
    const cards = judgeCards(records);

    // The two verdict frames and the ledger record are judgments of their own; none absorbs another.
    expect(cards).toHaveLength(3);
    expect(cards.every((card) => card.unlinked && card.evidence.length === 1)).toBe(true);
    expect(cards.map((card) => card.evidence[0].kind).toSorted()).toEqual([
      'decision',
      'preflight.verdict',
      'preflight.verdict',
    ]);
    // A lone wait marker is no judgment: it stays an ordinary runtime event instead of being paired up.
    expect(runtimeEvents(records).map((record) => record.kind)).toEqual(['preflight.pending', 'preflight.wait_end']);
  });

  it('does not let a ledger record stamped with a later turn describe that turn', () => {
    // A judge that answers after the next message began is written under the new turn number.
    const [card] = judgeCards([
      event(
        'decision',
        ledger({ id: 'late-from-previous-turn', latencyMs: 15_000, modelId: 'other' }),
        turn('r', 5, 40)
      ),
      event('decision', ledger({ id: 'own', latencyMs: 700 }), turn('r', 5, 41)),
      event('preflight.verdict', verdict({ latencyMs: 700 }), turn('r', 5, 42)),
      event('decision', ledger({ id: 'late-again', latencyMs: 16_000, modelId: 'other' }), turn('r', 5, 43)),
    ]);

    expect(card.model).toBe('jev-1.13.0');
    expect(card.latencyMs).toBe(700);
  });
});

describe('Jev judgment cards: what a verdict did to execution', () => {
  const stateOf = (payload: Record<string, unknown>) =>
    judgeCards([event('preflight.verdict', payload, turn('runtime-a', 1, 2))])[0];

  it('says a returned verdict was handed over, not that the operation completed', () => {
    const card = stateOf(verdict());

    expect(card).toMatchObject({ state: 'returned', action: 'toRuntime' });
    expect(card.thinking).toBeUndefined();
  });

  it('confirms an effect only when an adjustment or hints were recorded as applied', () => {
    expect(stateOf(verdict({ thinking: { from: 'medium', to: 'high' } }))).toMatchObject({
      state: 'confirmed',
      action: 'mainGiven',
      thinking: { from: 'medium', to: 'high' },
    });
    expect(stateOf(verdict({ hints: ['Ask one clarifying question.'] }))).toMatchObject({
      state: 'confirmed',
      hints: ['Ask one clarifying question.'],
    });
    // An unchanged level is not an adjustment.
    expect(stateOf(verdict({ thinking: { from: 'medium', to: 'medium' } })).state).toBe('returned');
  });

  it('keeps shadow, late, fallback and rule verdicts apart from each other and from a returned one', () => {
    const shadow = stateOf(verdict({ state: 'shadow', hints: ['not applied'], thinking: { from: 'low', to: 'high' } }));
    const late = stateOf(verdict({ state: 'late' }));
    const fallback = stateOf(verdict({ state: 'none', by: 'rule', turnType: 'unknown', reason: 'error:timeout' }));
    const rule = stateOf(verdict({ by: 'rule', turnType: 'chat', gear: 'chat' }));

    expect(shadow).toMatchObject({ state: 'shadow', action: 'observeOnly', hints: [] });
    // Observed only: nothing it would have changed is reported as changed.
    expect(shadow.thinking).toBeUndefined();
    expect(late).toMatchObject({ state: 'late', action: 'lateIgnored' });
    expect(fallback).toMatchObject({ state: 'fallback', action: 'useDefault', reason: 'error:timeout' });
    // A rule settled it: it is not shown as the judge's decision, and the judge is not named.
    expect(rule).toMatchObject({ state: 'rule', action: 'useDefault', model: '' });
    expect(new Set([shadow, late, fallback, rule, stateOf(verdict())].map((card) => card.state)).size).toBe(5);
  });

  it('does not name the judge on a rule verdict, even when the same turn recorded which judge was asked', () => {
    const [card] = judgeCards([
      event('preflight.pending', { judge: 'jev-latest', mode: 'active' }, turn('runtime-a', 1, 2)),
      event('decision', ledger({ source: 'fallback', reason: 'abstain' }), turn('runtime-a', 1, 3)),
      event('preflight.verdict', verdict({ by: 'rule', turnType: 'chat', gear: 'chat' }), turn('runtime-a', 1, 4)),
    ]);

    expect(card).toMatchObject({ state: 'rule', model: '' });
    // What was asked stays available as evidence; it is only kept out of the byline.
    expect(card.evidence).toHaveLength(3);
  });

  it('reads a wait without any verdict as a wait, a timeout, or an ended wait', () => {
    const pending = event('preflight.pending', { judge: 'jev-latest', mode: 'active' }, turn('runtime-a', 1, 2));
    expect(judgeCards([pending])[0]).toMatchObject({ state: 'pending', action: 'waiting', model: 'jev-latest' });

    const timedOut = event('preflight.wait_end', { reason: 'timeout', waitedMs: 6_002 }, turn('runtime-a', 1, 3));
    expect(judgeCards([pending, timedOut])[0]).toMatchObject({
      state: 'fallback',
      action: 'useDefault',
      latencyMs: 6_002,
    });

    // The task that followed has settled: whatever that wait was, it is not still running.
    const settled = { ...event('agent_settled', {}), at: pending.at + 60_000 };
    expect(judgeCards([pending, settled])[0]).toMatchObject({ state: 'ended', action: 'waitEnded' });
    const nextTurn = event('preflight.pending', { judge: 'jev-latest', mode: 'active' }, turn('runtime-a', 2, 9));
    expect(judgeCards([pending, nextTurn]).find((card) => card.id.includes(',1]'))?.state).toBe('ended');
  });

  it('shows what an observe-only judge would have said, while reporting that nothing changed', () => {
    const [card] = judgeCards([
      event(
        'decision',
        ledger({
          specId: 'tool.risk',
          mode: 'shadow',
          source: 'fallback',
          reason: 'shadow',
          outcome: 'confirm',
          judged: 'allow',
        }),
        turn('runtime-a', 2, 9)
      ),
    ]);

    expect(card).toMatchObject({ stage: 'risk', state: 'shadow', action: 'observeOnly', outcome: 'allow' });
  });

  it('does not read a fallback as a pass: the risk gate falls back to asking the user', () => {
    const [card] = judgeCards([
      event(
        'decision',
        ledger({
          specId: 'tool.risk',
          source: 'fallback',
          reason: 'error:timeout',
          outcome: 'confirm',
          modelId: undefined,
        }),
        turn('runtime-a', 2, 9)
      ),
    ]);

    expect(card).toMatchObject({ stage: 'risk', state: 'fallback', action: 'useDefault', outcome: 'confirm' });
    expect(resultFacts(card)).toEqual([{ name: 'result', values: ['confirm'] }]);
  });

  it('reports how much of a batch got no answer', () => {
    const [card] = judgeCards([
      event(
        'decision',
        ledger({
          specId: 'tool.admission',
          outcome: [
            { kind: 'result', drop: false },
            { kind: 'progress', drop: true },
            { kind: 'unknown', drop: false },
          ],
          answers: undefined,
          batch: { size: 3, failures: 1, answers: [null, null, null] },
        }),
        turn('runtime-a', 2, 9)
      ),
    ]);

    expect(card.batch).toEqual({ size: 3, failures: 1 });
    expect(resultFacts(card)).toEqual([
      { name: 'drop', values: ['1'] },
      { name: 'keep', values: ['2'] },
    ]);
  });
});

describe('Jev judgment cards: Hive gates', () => {
  const deliverGate = (overrides: Record<string, unknown> = {}) =>
    event(
      'hive.gate',
      gate({ gate: 'deliver', from: 'scout', to: 'worker', note: 'note-1', deliver: true, ...overrides }),
      {
        run: 'run-1',
      }
    );

  it('calls a delivery delivered only when a receipt for that run, note and bee exists', () => {
    const allowed = deliverGate();
    expect(judgeCards([allowed])[0]).toMatchObject({ state: 'returned', action: 'allowDelivery' });

    const receipt = event('hive.delivery', { note: 'note-1', to: 'worker', score: 0.8 }, { run: 'run-1' });
    expect(judgeCards([allowed, receipt])[0]).toMatchObject({ state: 'confirmed', action: 'delivered' });
  });

  it('does not borrow a receipt from another run, another bee or another note', () => {
    const allowed = deliverGate();
    for (const receipt of [
      event('hive.delivery', { note: 'note-1', to: 'worker' }, { run: 'run-2' }),
      event('hive.delivery', { note: 'note-1', to: 'reviewer' }, { run: 'run-1' }),
      event('hive.delivery', { note: 'note-2', to: 'worker' }, { run: 'run-1' }),
    ]) {
      expect(judgeCards([allowed, receipt])[0].action).toBe('allowDelivery');
    }
  });

  it('never upgrades a refused delivery, even if a receipt with the same keys exists', () => {
    const refused = deliverGate({ deliver: false });
    const receipt = event('hive.delivery', { note: 'note-1', to: 'worker' }, { run: 'run-1' });

    expect(judgeCards([refused, receipt])[0]).toMatchObject({ state: 'returned', action: 'denyDelivery' });
  });

  it('reports a publish verdict as permission only, and a gate fallback as withheld', () => {
    const publish = (overrides: Record<string, unknown>) =>
      judgeCards([
        event('hive.gate', gate({ gate: 'publish', bee: 'scout', text: 'Prefix is stable.', ...overrides }), {
          run: 'run-1',
        }),
      ])[0];

    expect(publish({ publish: true, kind: 'finding' })).toMatchObject({
      stage: 'publish',
      state: 'returned',
      action: 'allowPublish',
      preview: 'Prefix is stable.',
      route: { from: 'scout', to: '' },
    });
    expect(publish({ publish: false, kind: null })).toMatchObject({ action: 'denyPublish' });
    // The gate fails closed: a judge error withholds the note, and is never shown as "allowed".
    expect(publish({ publish: false, kind: null, score: 0, reason: 'error:timeout' })).toMatchObject({
      state: 'fallback',
      action: 'useDefault',
      outcome: { publish: false, score: 0 },
    });
    expect(publish({ publish: false, reason: 'shadow' })).toMatchObject({ state: 'shadow', action: 'observeOnly' });
  });

  it('keeps every gate a card of its own', () => {
    const cards = judgeCards([deliverGate(), deliverGate({ to: 'reviewer' }), deliverGate({ note: 'note-2' })]);

    expect(cards).toHaveLength(3);
    expect(cards.every((card) => card.evidence.length === 1 && !card.unlinked)).toBe(true);
  });
});

/** A lesson's words, as the log would look them up. */
const lessonWords = (id: string) => `the lesson called ${id}`;

describe('Jev judgment cards: readable result and details', () => {
  const card = (payload: Record<string, unknown>) =>
    judgeCards([event('decision', payload, turn('runtime-a', 1, 5))])[0];

  it('counts per-item probabilities: passages withheld over 0.5, the agent’s question answered yes, no or unsure', () => {
    // A screen of two batches: batches are flattened, a passage without an answer counts as neither.
    expect(
      resultFacts(
        card(
          ledger({
            specId: 'tool.injection',
            outcome: [
              [0.98, 0.02, 0.5],
              [0.04, null],
            ],
          })
        )
      )
    ).toEqual([
      { name: 'withhold', values: ['1'] },
      { name: 'kept', values: ['3'] },
    ]);
    expect(
      resultFacts(
        card(
          ledger({
            specId: 'judge.items',
            outcome: [
              [0.95, 0.5, 0.02],
              [0.8, 0.2],
            ],
          })
        )
      )
    ).toEqual([
      { name: 'answeredYes', values: ['2'] },
      { name: 'answeredNo', values: ['2'] },
      { name: 'answeredUnsure', values: ['1'] },
    ]);
    expect(resultFacts(card(ledger({ specId: 'turn.continue', outcome: 'go_ahead' })))).toEqual([
      { name: 'result', values: ['go_ahead'] },
    ]);
  });

  it('labels scalar, list, ranked and per-candidate outcomes without inventing anything', () => {
    expect(resultFacts(card(ledger({ specId: 'turn.drift', outcome: 'on_track' })))).toEqual([
      { name: 'result', values: ['on_track'] },
    ]);
    expect(resultFacts(card(ledger({ specId: 'context.forget', outcome: ['keep', 'keep', 'shrink'] })))).toEqual([
      // A tally: the name is an answer the view labels as a value, not a field.
      { name: 'keep', values: ['×2'], tally: true },
      { name: 'shrink', values: ['×1'], tally: true },
    ]);
    expect(
      resultFacts(
        card(ledger({ specId: 'files.locate', outcome: { ranked: [{ path: 'src/a.ts', probability: 0.4 }] } }))
      )
    ).toEqual([{ name: 'path', values: ['src/a.ts'] }]);
    expect(
      resultFacts(
        card(
          ledger({ specId: 'swarm.routing', outcome: [{ strength: 0.606, thinking: 'high', agent: 'scout' }, null] })
        )
      )
    ).toEqual([
      {
        name: '1',
        values: [],
        pairs: [
          { key: 'strength', value: '0.61' },
          { key: 'thinking', value: 'high' },
          { key: 'agent', value: 'scout' },
        ],
      },
    ]);
    const hidden = Array.from({ length: 9 }, (_, index) => `skill-${index}`);
    expect(resultFacts(card(ledger({ specId: 'skills.disclosure', outcome: { hide: hidden, relevant: [] } })))).toEqual(
      [{ name: 'hide', values: hidden.slice(0, 6), more: 3 }]
    );
    expect(resultFacts(card(ledger({ specId: 'turn.drift', outcome: undefined })))).toEqual([]);
  });

  it('counts positions from 1 where the harness records them from 0, and leaves other lists as recorded', () => {
    expect(resultFacts(card(ledger({ specId: 'output.drift', outcome: { broken: [0, 2] } })))).toEqual([
      { name: 'broken', values: ['1', '3'] },
    ]);
    expect(resultFacts(card(ledger({ specId: 'tool.constraint', outcome: { broken: [1] } })))).toEqual([
      { name: 'broken', values: ['2'] },
    ]);
    expect(
      resultFacts(card(ledger({ specId: 'tool.admission.test-log', outcome: { omit: ['part_0', 'part_3'] } })))
    ).toEqual([{ name: 'omit', values: ['1', '4'] }]);
    const board = resultFacts(
      card(
        ledger({
          specId: 'board.read',
          outcome: { phase: 'changing', focus: null, needsUser: false, update: true, key: [0, 4] },
        })
      )
    );
    expect(board).toContainEqual({ name: 'key', values: ['1', '5'] });
    expect(board).toContainEqual({ name: 'phase', values: ['changing'] });
    expect(resultFacts(card(ledger({ specId: 'review.triage', outcome: { priorities: ['P0', 'P2'] } })))).toEqual([
      { name: 'priorities', values: ['P0', 'P2'] },
    ]);
  });

  it('has words in every language for what the browser step, the compaction, the board and the test log record', () => {
    const facts = [
      ...resultFacts(
        card(ledger({ specId: 'browser.step', outcome: { operation: 'SCROLL_DOWN', target: '3', probability: 0.9 } }))
      ),
      ...resultFacts(card(ledger({ specId: 'board.read', outcome: { key: [0] } }))),
      ...resultFacts(card(ledger({ specId: 'tool.admission.test-log', outcome: { omit: ['part_1'] } }))),
    ];
    const fields = facts.map((fact) => fact.name);
    expect(fields).toEqual(['operation', 'target', 'probability', 'key', 'omit']);
    const choices = (specId: keyof typeof JUDGE_QUESTIONS, id: string) =>
      JUDGE_QUESTIONS[specId].flatMap((question) =>
        question.id === id && question.type === 'choice' ? question.answers : []
      );
    // The operations and kinds as the outcome records them: the browser's "no way forward" is `BLOCKED` there.
    const values = [
      ...choices('browser.step', 'operation').filter((operation) => operation !== 'other'),
      'BLOCKED',
      ...choices('context.compact', 'kind'),
    ];
    expect(values).toContain('SCROLL_DOWN');

    const localeRoot = fileURLToPath(
      new URL('../../../../packages/desktop/src/renderer/services/i18n/locales/', import.meta.url)
    );
    for (const language of SUPPORTED_LANGUAGES) {
      const view = JSON.parse(readFileSync(join(localeRoot, language, 'common.json'), 'utf8')).kyrn.judgeView;
      for (const field of fields) expect(view.fields[field], `${language} fields.${field}`).toBeTruthy();
      for (const value of values) expect(view.values[value], `${language} values.${value}`).toBeTruthy();
      expect(view.questions.testLog, `${language} questions.testLog`).toBeTruthy();
    }
  });

  it('names the lessons brought into a turn by their words, as it does the ones followed', () => {
    expect(resultFacts(card(ledger({ specId: 'memory.recall', outcome: { apply: ['a', 'b'] } })), lessonWords)).toEqual(
      [
        { name: 'apply', values: ['the lesson called a'], text: true },
        { name: 'apply', values: ['the lesson called b'], text: true },
      ]
    );
    // Without the lessons' words, the ids stay a plain list.
    expect(resultFacts(card(ledger({ specId: 'memory.recall', outcome: { apply: ['a', 'b'] } })))).toEqual([
      { name: 'apply', values: ['a', 'b'] },
    ]);
  });

  it('words what the experience library decided in every language: verdicts as values, the followed as fields', () => {
    // The outcomes as the harness records them: a scalar verdict, one verdict per candidate or kept lesson, id lists.
    const facts = [
      ...resultFacts(card(ledger({ specId: 'memory.capture', outcome: 'preference' }))),
      ...resultFacts(card(ledger({ specId: 'memory.outcome', outcome: 'learn' }))),
      ...resultFacts(card(ledger({ specId: 'memory.worth', outcome: ['reusable', 'one_off', 'already_known'] }))),
      ...resultFacts(
        card(ledger({ specId: 'memory.merge', outcome: ['same', 'refines', 'contradicts', 'unrelated'] }))
      ),
      ...resultFacts(card(ledger({ specId: 'memory.applied', outcome: { applied: ['lesson-1'], notApplied: [] } }))),
    ];
    const values = facts.flatMap((fact) => (fact.tally ? [fact.name] : fact.name === 'result' ? fact.values : []));
    const fields = facts.filter((fact) => !fact.tally).map((fact) => fact.name);
    expect(values).toEqual([
      'preference',
      'learn',
      'reusable',
      'one_off',
      'already_known',
      'same',
      'refines',
      'contradicts',
      'unrelated',
    ]);
    expect(fields).toEqual(['result', 'result', 'applied']);

    const localeRoot = fileURLToPath(
      new URL('../../../../packages/desktop/src/renderer/services/i18n/locales/', import.meta.url)
    );
    for (const language of SUPPORTED_LANGUAGES) {
      const view = JSON.parse(readFileSync(join(localeRoot, language, 'common.json'), 'utf8')).kyrn.judgeView;
      for (const value of values) expect(view.values[value], `${language} values.${value}`).toBeTruthy();
      for (const field of [...fields, 'notApplied'])
        expect(view.fields[field], `${language} fields.${field}`).toBeTruthy();
      for (const stage of ['outcome', 'worth', 'merge', 'applied'])
        expect(view.questions[stage], `${language} questions.${stage}`).toBeTruthy();
    }
  });

  it('keeps the recorded probabilities for the details, ranked for a choice', () => {
    const { rows, more } = answerRows(
      card(
        ledger({
          answers: {
            turn_type: {
              type: 'choice',
              choice: 'research',
              probabilities: { chat: 0.02, research: 0.6, multi_step_task: 0.3, other: 0.08 },
            },
            is_side_question: { type: 'boolean', probability: 0.43 },
            task: { type: 'score', score: 1.91 },
            malformed: { type: 'boolean' },
          },
        })
      )
    );

    expect(more).toBe(0);
    expect(rows).toEqual([
      {
        id: 'turn_type',
        type: 'choice',
        choice: 'research',
        options: [
          { name: 'research', probability: 0.6 },
          { name: 'multi_step_task', probability: 0.3 },
          { name: 'other', probability: 0.08 },
        ],
      },
      { id: 'is_side_question', type: 'boolean', probability: 0.43 },
      { id: 'task', type: 'score', score: 1.91 },
    ]);
  });

  it('lists everything that is not a judgment as a runtime event, and nothing that another tab owns', () => {
    const kinds = runtimeEvents([
      event('agent_start', {}),
      event('progress', { step: 'choosing skills' }),
      event('decision', ledger({ specId: 'turn.drift' }), turn('runtime-a', 1, 5)),
      event('preflight.pending', {}, turn('runtime-a', 1, 2)),
      event('preflight.verdict', verdict()),
      event('hive.gate', gate({ gate: 'publish', publish: true }), { run: 'run-1' }),
      event('bee.event', {}, { run: 'run-1' }),
      event('swarm.snapshot', {}, { run: 'run-1' }),
      event('artifact.image', {}),
      event('memory.stored', {}),
    ]).map((record) => record.kind);

    expect(kinds).toEqual(['agent_start', 'progress', 'memory.stored']);
  });
});

describe('Jev judgment cards: what the view can translate', () => {
  it('knows every decision point of the harness, and has its question in each reference language', () => {
    // The spec ids of packages/kyrn-judge/src/decisions/*.ts in the harness repository.
    const harness = [
      'input.preflight',
      'input.interjection',
      'tool.admission',
      'context.forget',
      'context.compact',
      'skills.disclosure',
      'files.locate',
      'swarm.routing',
      'hive.publish',
      'hive.deliver',
      'browser.step',
      'memory.recall',
      'memory.capture',
      'memory.outcome',
      'memory.worth',
      'memory.merge',
      'memory.applied',
      'tool.risk',
      'turn.drift',
      'turn.completion',
      'notify.routing',
      'cache.warming',
      'turn.rewind',
      'goal.met',
      'output.drift',
      'task.frame',
      'tool.constraint',
      'capability.disclosure',
      'diagnostics.delivery',
      'swarm.patch',
      'review.triage',
      'board.read',
      'hive.relate',
      'tool.approval',
      'tool.admission.test-log',
      'tool.injection',
      'turn.continue',
      'judge.items',
    ];
    expect(harness.map(stageOf)).not.toContain('other');
    expect(new Set(harness.map(stageOf)).size).toBe(harness.length);
    expect(Object.keys(DECISIONS).toSorted()).toEqual(harness.toSorted());
    expect(stageOf('memory.future')).toBe('other');
    for (const locale of [common, zhCN, zhTW]) {
      const questions = locale.kyrn.judgeView.questions as Record<string, string>;
      for (const stage of [...Object.values(DECISIONS), 'other']) expect(questions[stage]).toBeTruthy();
    }
  });

  it('turns the preflight sentence for a wait without an answer into a code, and leaves codes alone', () => {
    expect(reasonCode('no answer after 6.0 s')).toBe('no_answer');
    expect(reasonCode('no answer after 12 s')).toBe('no_answer');
    expect(reasonCode('error:rate_limited')).toBe('error:rate_limited');
    expect(reasonCode('abstain')).toBe('abstain');
    expect(reasonCode('')).toBe('');
  });

  it('has a label for every judge error kind the harness reports', () => {
    const kinds = ['timeout', 'aborted', 'unreachable', 'auth', 'payment_required', 'rate_limited', 'bad_request'];
    for (const locale of [common, zhCN, zhTW]) {
      const values = locale.kyrn.judgeView.values as Record<string, string>;
      for (const kind of [...kinds, 'server', 'invalid_response', 'unexpected', 'all', 'no_answer'])
        expect(values[kind]).toBeTruthy();
    }
  });

  it('prefers the stable reason code and keeps what it names, reading older records by their words', () => {
    expect(readReason('no answer after 6.0 s')).toEqual({ code: 'no_answer', params: { seconds: 6 } });
    expect(readReason('no answer after 6.0 s', 'no_answer', { seconds: 6, note: 'x' })).toEqual({
      code: 'no_answer',
      params: { seconds: 6 },
      text: 'no answer after 6.0 s',
    });
    // A coded record that lost its parameters still names its seconds in its words.
    expect(readReason('no answer after 4.5 s', 'no_answer')).toMatchObject({ params: { seconds: 4.5 } });
    // The English beside a code is kept for a code the view has no words for; a reason that is its code is not.
    expect(readReason('the judge budget is spent', 'budget_spent')).toEqual({
      code: 'budget_spent',
      params: undefined,
      text: 'the judge budget is spent',
    });
    expect(readReason('error:auth', 'error:auth')).toEqual({ code: 'error:auth', params: undefined });
    expect(readReason('skipped', 'skipped', {})).toEqual({ code: 'skipped', params: undefined });
    expect(readReason(undefined)).toEqual({ code: '' });

    const [coded] = judgeCards([
      event(
        'preflight.verdict',
        verdict({
          state: 'none',
          reason: 'no answer after 4.5 s',
          reasonCode: 'no_answer',
          reasonParams: { seconds: 4.5 },
        }),
        turn('runtime-a', 1, 2)
      ),
    ]);
    const [older] = judgeCards([
      event('preflight.verdict', verdict({ state: 'none', reason: 'no answer after 6.0 s' }), turn('runtime-a', 1, 2)),
    ]);
    expect(coded).toMatchObject({
      reason: 'no_answer',
      reasonParams: { seconds: 4.5 },
      reasonFallback: 'no answer after 4.5 s',
    });
    expect(older).toMatchObject({ reason: 'no_answer', reasonParams: { seconds: 6 } });
  });

  it('keeps each hint beside its id, and has no ids for a record from before them', () => {
    const [card] = judgeCards([
      event(
        'preflight.verdict',
        verdict({ hints: ['Ask first.', 42, 'Plan first.'], hintIds: ['clarify', 'odd', 'plan_first'] }),
        turn('runtime-a', 1, 2)
      ),
    ]);
    expect(card.hints).toEqual(['Ask first.', '', 'Plan first.']);
    expect(card.hintIds).toEqual(['clarify', 'odd', 'plan_first']);

    const [older] = judgeCards([
      event('preflight.verdict', verdict({ hints: ['Ask first.'] }), turn('runtime-a', 1, 2)),
    ]);
    expect(older).toMatchObject({ hints: ['Ask first.'], hintIds: [''] });
    const [shadow] = judgeCards([
      event('preflight.verdict', verdict({ state: 'shadow', hints: ['Ask first.'], hintIds: ['clarify'] })),
    ]);
    expect(shadow).toMatchObject({ hints: [], hintIds: [] });
  });

  it('reads a verdict’s answers by question id rather than as English label and value pairs', () => {
    const answerValues = {
      turn_type: { type: 'choice', choice: 'research', probabilities: { research: 0.6, chat: 0.1 } },
      plan_first: { type: 'boolean', probability: 0.8 },
      task_complexity: { type: 'score', score: 2 },
    };
    const [card] = judgeCards([event('preflight.verdict', verdict({ answerValues }), turn('runtime-a', 1, 2))]);
    expect(answerRows(card).rows).toEqual([
      {
        id: 'turn_type',
        type: 'choice',
        choice: 'research',
        options: [
          { name: 'research', probability: 0.6 },
          { name: 'chat', probability: 0.1 },
        ],
      },
      { id: 'plan_first', type: 'boolean', probability: 0.8 },
      { id: 'task_complexity', type: 'score', score: 2 },
    ]);

    // Without the ids, the pairs the harness wrote are all there is.
    const [older] = judgeCards([event('preflight.verdict', verdict(), turn('runtime-a', 1, 2))]);
    expect(answerRows(older).rows).toEqual([
      { id: 'Turn type', type: 'text', text: 'multi-step task 55% · research 32%' },
    ]);
  });
});
