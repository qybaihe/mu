import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { StoredLesson } from '@/common/kyrn/lessons';
import type { Activity, ActivityPage, Result } from '@/common/kyrn/types';
import common from '@/renderer/services/i18n/locales/en-US/common.json';
import mu from '@/renderer/services/i18n/locales/en-US/mu.json';
import zhCommon from '@/renderer/services/i18n/locales/zh-CN/common.json';
import zhMu from '@/renderer/services/i18n/locales/zh-CN/mu.json';
import { KernelBody, useKyrnActivity } from '@/renderer/pages/conversation/KyrnPanel';
import JudgeLog from '@/renderer/pages/conversation/KyrnPanel/Judge';
import { judgeCards } from '@/renderer/pages/conversation/KyrnPanel/Judge/activity';
import JudgeCardView from '@/renderer/pages/conversation/KyrnPanel/Judge/JudgeCardView';
import { event, gate, ledger, turn, verdict } from './judgeFixtures';

const { activity, lessons } = vi.hoisted(() => ({ activity: vi.fn(), lessons: vi.fn() }));
vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: { activity: { invoke: activity }, lessons: { invoke: lessons } },
  unwrap: (result: Result<ActivityPage>) => {
    if (result.ok === false) throw new Error(result.error);
    return result.data;
  },
}));

const copy = common.kyrn.judgeView;
const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en',
    resources: { en: { translation: { common, mu } } },
    interpolation: { escapeValue: false },
  });
});
beforeEach(() =>
  activity.mockResolvedValue({ ok: true, data: { sessionId: 'session', cursor: 0, more: false, events: [] } })
);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Every judgment as a line of the log opens it, newest first. */
function Judge({ events }: { events: Activity[] }) {
  return (
    <div data-testid='kyrn-judge'>
      {judgeCards(events).map((card) => (
        <JudgeCardView key={card.id} card={card} />
      ))}
    </div>
  );
}
const view = (events: Activity[]) =>
  render(
    <I18nextProvider i18n={i18n}>
      <Judge events={events} />
    </I18nextProvider>
  );
const cards = () => screen.getAllByTestId('judge-card');

describe('a judgment, opened', () => {
  it('shows each judgment as question, verdict and effect, with probabilities and JSON held back', () => {
    view([
      event('preflight.pending', { judge: 'jev-latest', mode: 'active' }, turn('runtime-a', 1, 2)),
      event('decision', ledger({ state: { user_message: 'PRIVATE JUDGE INPUT' } }), turn('runtime-a', 1, 3)),
      event(
        'preflight.verdict',
        verdict({ thinking: { from: 'medium', to: 'high' }, hints: ['Write a short plan.'] }),
        {
          ...turn('runtime-a', 1, 4),
        }
      ),
    ]);

    const card = within(cards()[0]);
    expect(card.getByText(copy.question)).toBeInTheDocument();
    expect(card.getByText(copy.questions.preflight)).toBeInTheDocument();
    expect(card.getByText(copy.result)).toBeInTheDocument();
    expect(card.getByText(copy.values.multi_step_task)).toBeInTheDocument();
    expect(card.getByText(copy.action)).toBeInTheDocument();
    expect(card.getByText(copy.actions.mainGiven)).toBeInTheDocument();
    expect(card.getByText('Thinking level: Medium → High')).toBeInTheDocument();
    expect(card.getByText('Write a short plan.')).toBeInTheDocument();
    expect(card.getByText(copy.state.confirmed)).toBeInTheDocument();

    // Raw probabilities and records are details, not the headline.
    expect(card.queryByText(/stateDigest/)).not.toBeInTheDocument();
    expect(card.queryByText(/55%/)).not.toBeInTheDocument();
    fireEvent.click(card.getByText(copy.details));
    expect(card.getByText(/Multi-step task 55%/)).toBeInTheDocument();
    expect(card.getByText(/"stateDigest": "digest"/)).toBeInTheDocument();
    // The judge's own input is never part of the view, even when a diagnostic build recorded it.
    expect(card.queryByText(/PRIVATE JUDGE INPUT/)).not.toBeInTheDocument();
  });

  it('never words a handed-over verdict as a finished operation', () => {
    view([event('preflight.verdict', verdict(), turn('runtime-a', 1, 2))]);

    const card = within(cards()[0]);
    expect(card.getByText(copy.state.returned)).toBeInTheDocument();
    expect(card.getByText(copy.actions.toRuntime)).toBeInTheDocument();
    expect(copy.actions.toRuntime).toMatch(/doesn't confirm the action finished/);
    expect(card.queryByText(copy.state.confirmed)).not.toBeInTheDocument();
    expect(card.queryByText(copy.actions.mainGiven)).not.toBeInTheDocument();
  });

  it('labels shadow, late, fallback and rule verdicts with different words and effects', () => {
    view([
      event('preflight.verdict', verdict({ state: 'shadow' }), turn('runtime-a', 1, 2)),
      event('preflight.verdict', verdict({ state: 'late' }), turn('runtime-a', 2, 6)),
      event('preflight.verdict', verdict({ state: 'none', by: 'rule', turnType: 'unknown', reason: 'error:timeout' }), {
        ...turn('runtime-a', 3, 10),
      }),
      event('preflight.verdict', verdict({ by: 'rule', turnType: 'chat', gear: 'chat' }), turn('runtime-a', 4, 14)),
    ]);

    const [rule, fallback, late, shadow] = cards().map((card) => within(card));
    expect(shadow.getByText(copy.state.shadow)).toBeInTheDocument();
    expect(shadow.getByText(copy.actions.observeOnly)).toBeInTheDocument();
    expect(late.getByText(copy.state.late)).toBeInTheDocument();
    expect(late.getByText(copy.actions.lateIgnored)).toBeInTheDocument();
    expect(fallback.getByText(copy.state.fallback)).toBeInTheDocument();
    expect(fallback.getByText(copy.actions.useDefault)).toBeInTheDocument();
    expect(
      fallback.getByText(`${copy.fields.reason}: ${copy.values.error} · ${copy.values.timeout}`)
    ).toBeInTheDocument();
    expect(rule.getByText(copy.state.rule)).toBeInTheDocument();
    expect(
      new Set([copy.state.shadow, copy.state.late, copy.state.fallback, copy.state.rule, copy.state.returned]).size
    ).toBe(5);
    expect(cards().map((card) => card.getAttribute('data-state'))).toEqual(['rule', 'fallback', 'late', 'shadow']);
    // A default is described as a default, never as permission.
    expect(copy.actions.useDefault).toMatch(/isn't permission to proceed/);
  });

  it('separates permission to deliver from a confirmed delivery', () => {
    view([
      event('hive.gate', gate({ gate: 'deliver', from: 'scout', to: 'worker', note: 'note-1', deliver: true }), {
        run: 'run-1',
      }),
      event('hive.gate', gate({ gate: 'deliver', from: 'scout', to: 'reviewer', note: 'note-1', deliver: true }), {
        run: 'run-1',
      }),
      event('hive.note', { id: 'note-1', bee: 'scout', kind: 'finding', text: 'Prefix is stable.' }, { run: 'run-1' }),
      event('hive.delivery', { note: 'note-1', to: 'worker', score: 0.8 }, { run: 'run-1' }),
    ]);

    const [toReviewer, toWorker] = cards().map((card) => within(card));
    expect(toWorker.getByText(copy.actions.delivered)).toBeInTheDocument();
    expect(toWorker.getByText(copy.state.confirmed)).toBeInTheDocument();
    expect(toReviewer.getByText(copy.actions.allowDelivery)).toBeInTheDocument();
    expect(toReviewer.queryByText(copy.actions.delivered)).not.toBeInTheDocument();
    expect(toReviewer.getByText('Prefix is stable.')).toBeInTheDocument();
  });

  it('shows a conservative fallback as refused, with the number of unanswered candidates', () => {
    view([
      event('hive.gate', gate({ gate: 'publish', bee: 'scout', publish: false, score: 0, reason: 'error:timeout' }), {
        run: 'run-1',
      }),
      event(
        'decision',
        ledger({
          id: 'admission-1',
          specId: 'tool.admission',
          source: 'fallback',
          reason: 'error:all',
          outcome: [{ kind: 'unknown', drop: false }],
          answers: undefined,
          batch: { size: 4, failures: 4 },
        }),
        turn('runtime-a', 1, 8)
      ),
    ]);

    const [admission, publish] = cards().map((card) => within(card));
    expect(publish.getByText(copy.state.fallback)).toBeInTheDocument();
    expect(publish.getByText(`${copy.fields.publish}`).parentElement).toHaveTextContent(copy.values.false);
    expect(publish.queryByText(copy.actions.allowPublish)).not.toBeInTheDocument();
    expect(admission.getByText(/Candidates covered by this record: 4\./)).toBeInTheDocument();
    expect(admission.getByText(/\(default used\): 4\./)).toBeInTheDocument();
  });

  it('does not present token savings, cost or a model reasoning trace', () => {
    view([
      event('decision', ledger({ usage: { inputTokens: 321, outputTokens: 12 } }), turn('runtime-a', 1, 3)),
      event('preflight.verdict', verdict(), turn('runtime-a', 1, 4)),
    ]);

    // Usage stays inside the raw record; the summary makes no claim about savings or cost.
    expect(screen.getByTestId('kyrn-judge').textContent).not.toMatch(
      /token|saving|saved|cost|\$|chain of thought|reasoning/i
    );
    expect(JSON.stringify(copy)).not.toMatch(/token|saving|saved|cost|chain of thought/i);
  });

  it('marks an uncorrelated record as standing alone', () => {
    view([event('preflight.verdict', verdict()), event('preflight.verdict', verdict())]);

    expect(cards()).toHaveLength(2);
    expect(screen.getAllByText(copy.unlinked)).toHaveLength(2);
  });

  it('names the reason of a fallback in words, including a wait without an answer and every judge error', () => {
    view([
      event('preflight.verdict', verdict({ state: 'none', reason: 'no answer after 6.0 s', waitedMs: 6000 }), {
        ...turn('runtime-a', 1, 2),
      }),
      event(
        'decision',
        ledger({ id: 'risk-1', specId: 'tool.risk', source: 'fallback', reason: 'error:rate_limited' }),
        {
          ...turn('runtime-a', 1, 5),
        }
      ),
    ]);

    const [risk, preflight] = cards().map((card) => within(card));
    // The seconds the English sentence named are kept, in the app's words for a duration.
    expect(preflight.getByText(/^Reason: No answer after 6\s?sec/)).toBeInTheDocument();
    expect(preflight.queryByText(/no answer after/)).not.toBeInTheDocument();
    expect(risk.getByText(`Reason: Error · ${copy.values.rate_limited}`)).toBeInTheDocument();
  });

  it('asks the question of every harness decision point and labels its outcome', () => {
    view([
      event('decision', ledger({ id: 'goal-1', specId: 'goal.met', outcome: 'met' }), turn('runtime-a', 1, 2)),
      event(
        'decision',
        ledger({
          id: 'board-1',
          specId: 'board.read',
          outcome: { phase: 'wrapping_up', focus: null, needsUser: false, update: true },
        }),
        turn('runtime-a', 1, 3)
      ),
    ]);

    const [board, goal] = cards().map((card) => within(card));
    expect(goal.getByText(copy.questions.goalMet)).toBeInTheDocument();
    expect(goal.getByText(copy.values.met)).toBeInTheDocument();
    expect(board.getByText(copy.questions.board)).toBeInTheDocument();
    expect(board.getByText(copy.fields.phase).parentElement).toHaveTextContent(
      common.kyrn.boardView.phases.wrapping_up
    );
    expect(board.getByText(copy.fields.needsUser).parentElement).toHaveTextContent(copy.values.false);
    expect(screen.queryByText(copy.questions.other)).not.toBeInTheDocument();
  });

  it('asks the hive’s relate question and the judge’s approval question, not a nameless recorded judgment', () => {
    view([
      event(
        'decision',
        ledger({ id: 'relate-1', specId: 'hive.relate', outcome: { relation: 'supersedes', score: 0.9 } }),
        turn('r', 3, 2)
      ),
      event('decision', ledger({ id: 'approval-1', specId: 'tool.approval', outcome: 'beyond' }), turn('r', 3, 3)),
    ]);

    const [approval, relate] = cards().map((card) => within(card));
    expect(relate.getByText(copy.questions.relate)).toBeInTheDocument();
    expect(relate.getByText(copy.fields.relation).parentElement).toHaveTextContent(copy.values.supersedes);
    expect(approval.getByText(copy.questions.approval)).toBeInTheDocument();
    expect(approval.getByText(copy.fields.result).parentElement).toHaveTextContent(copy.values.beyond);
    expect(screen.queryByText(copy.questions.other)).not.toBeInTheDocument();
  });

  it('asks the experience library’s questions and says which lessons were followed', () => {
    view([
      event(
        'decision',
        ledger({ id: 'merge-1', specId: 'memory.merge', outcome: ['same', 'unrelated'] }),
        turn('r', 2, 2)
      ),
      event(
        'decision',
        ledger({
          id: 'applied-1',
          specId: 'memory.applied',
          outcome: { applied: ['lesson-1'], notApplied: ['lesson-2'] },
        }),
        turn('r', 2, 3)
      ),
    ]);

    const [applied, merge] = cards().map((card) => within(card));
    expect(merge.getByText(copy.questions.merge)).toBeInTheDocument();
    expect(merge.getByText(copy.values.same)).toBeInTheDocument();
    expect(merge.getByText(copy.values.unrelated)).toBeInTheDocument();
    expect(applied.getByText(copy.questions.applied)).toBeInTheDocument();
    expect(applied.getByText(copy.fields.applied).parentElement).toHaveTextContent('lesson-1');
    expect(applied.getByText(copy.fields.notApplied).parentElement).toHaveTextContent('lesson-2');
    expect(screen.queryByText(copy.questions.other)).not.toBeInTheDocument();
  });

  it('labels the answers a batch counted as answers, and gives each batch sentence a line of its own', () => {
    view([
      event(
        'decision',
        ledger({
          id: 'forget-1',
          specId: 'context.forget',
          outcome: ['keep', 'shrink', 'keep', 'now'],
          answers: undefined,
          batch: { size: 4, failures: 1 },
        }),
        turn('runtime-a', 1, 2)
      ),
    ]);

    const card = within(cards()[0]);
    // The counted answers are values ("Keep"), never a field's label ("Parts kept") or the raw id.
    expect(card.getByText(copy.values.keep).parentElement).toHaveTextContent(`${copy.values.keep}×2`);
    expect(card.getByText(copy.values.shrink).parentElement).toHaveTextContent(`${copy.values.shrink}×1`);
    expect(card.getByText(copy.values.now)).toBeInTheDocument();
    expect(card.queryByText(copy.fields.keep)).not.toBeInTheDocument();
    expect(card.queryByText('shrink')).not.toBeInTheDocument();
    expect(card.getByText('Candidates covered by this record: 4.')).toBeInTheDocument();
    expect(card.getByText('Candidates with no answer (default used): 1.')).toBeInTheDocument();
  });

  it('formats numbers in the app language rather than the operating system’s', async () => {
    const german = createInstance();
    await german.init({
      lng: 'de-DE',
      fallbackLng: 'en',
      resources: { en: { translation: { common, mu } } },
      interpolation: { escapeValue: false },
    });
    render(
      <I18nextProvider i18n={german}>
        <Judge
          events={[
            event(
              'decision',
              ledger({
                latencyMs: 12_345,
                answers: { ok: { type: 'boolean', probability: 0.925 }, fit: { type: 'score', score: 0.5 } },
              }),
              turn('runtime-a', 1, 2)
            ),
          ]}
        />
      </I18nextProvider>
    );

    const card = within(cards()[0]);
    expect(card.getByText(/12\.345 ms/)).toBeInTheDocument();
    fireEvent.click(card.getByText(copy.details));
    expect(card.getByText(/Probability of yes: 93\s%/)).toBeInTheDocument();
    expect(card.getByText(/Score: 0,50/)).toBeInTheDocument();
  });

  it('keeps Chinese punctuation and list separators inside the Chinese texts', async () => {
    const chinese = createInstance();
    await chinese.init({
      lng: 'zh-CN',
      resources: { 'zh-CN': { translation: { common: zhCommon, mu: zhMu } } },
      interpolation: { escapeValue: false },
    });
    const zh = zhCommon.kyrn.judgeView;
    render(
      <I18nextProvider i18n={chinese}>
        <Judge
          events={[
            event(
              'preflight.verdict',
              verdict({ thinking: { from: 'medium', to: 'xhigh' }, reason: 'error:timeout' }),
              turn('runtime-a', 1, 2)
            ),
            event(
              'decision',
              ledger({ id: 'skills-1', specId: 'skills.disclosure', outcome: { relevant: ['git', 'deploy', 'docs'] } }),
              turn('runtime-a', 1, 5)
            ),
          ]}
        />
      </I18nextProvider>
    );

    const [skills, preflight] = cards().map((card) => within(card));
    expect(preflight.getByText(`原因：${zh.values.error} · ${zh.values.timeout}`)).toBeInTheDocument();
    expect(preflight.getByText(`思考强度：${zhMu.levels.medium} → ${zhMu.levels.xhigh}`)).toBeInTheDocument();
    expect(skills.getByText(zh.fields.relevant).parentElement).toHaveTextContent('git、deploy 和 docs');
  });

  it('says the preflight’s hints, answers and reason in the app language by their codes', async () => {
    const chinese = createInstance();
    await chinese.init({
      lng: 'zh-CN',
      resources: { 'zh-CN': { translation: { common: zhCommon, mu: zhMu } } },
      interpolation: { escapeValue: false },
    });
    const zh = zhCommon.kyrn.judgeView;
    const sentence =
      'The request looks under-specified. Ask one focused clarifying question before doing significant work.';
    render(
      <I18nextProvider i18n={chinese}>
        <Judge
          events={[
            event(
              'preflight.verdict',
              verdict({
                hints: [sentence, 'An older hint without an id.'],
                hintIds: ['clarify'],
                answers: [['large or risky', 'yes · 80% likely']],
                answerValues: {
                  turn_type: { type: 'choice', choice: 'research', probabilities: { research: 0.6 } },
                  plan_first: { type: 'boolean', probability: 0.8 },
                },
              }),
              turn('runtime-a', 1, 2)
            ),
            event(
              'preflight.verdict',
              verdict({ state: 'none', reason: 'abstain', reasonCode: 'error:payment_required' }),
              turn('runtime-a', 2, 6)
            ),
            // A code this build has no words for: the English beside it is what the card says.
            event(
              'preflight.verdict',
              verdict({ state: 'none', reason: 'the judge budget is spent', reasonCode: 'budget_spent' }),
              turn('runtime-a', 3, 9)
            ),
          ]}
        />
      </I18nextProvider>
    );

    const [unknown, fallback, applied] = cards().map((card) => within(card));
    expect(unknown.getByText('原因：the judge budget is spent')).toBeInTheDocument();
    expect(unknown.queryByText(/budget_spent/)).not.toBeInTheDocument();
    expect(fallback.getByText(`原因：${zh.values.error} · ${zh.values.payment_required}`)).toBeInTheDocument();
    expect(applied.getByText(zh.hints.clarify)).toBeInTheDocument();
    expect(applied.queryByText(sentence)).not.toBeInTheDocument();
    // A hint without an id is shown as the main model was given it.
    expect(applied.getByText('An older hint without an id.')).toBeInTheDocument();
    fireEvent.click(applied.getByText(zh.details));
    const words = zh.answerWords.preflight;
    expect(applied.getByText(words.questions.plan_first).parentElement).toHaveTextContent('判定为「是」的概率：80%');
    // "Task type" also names the verdict's own field; the answer row is the one with the judge's choice.
    const turnType = applied.getAllByText(words.questions.turn_type).map((label) => label.parentElement?.textContent);
    expect(turnType).toContain(`${words.questions.turn_type}${words.answers.research} · ${words.answers.research} 60%`);
    expect(applied.queryByText('large or risky')).not.toBeInTheDocument();
  });
});

/** A label and what follows it, for each place the label appears (a question and a result field can share one). */
const labelled = (card: ReturnType<typeof within>, label: string) =>
  card.getAllByText(label).map((node) => node.parentElement?.textContent);

describe('a judgment’s answers, in words', () => {
  it('names every decision point’s questions and answers, never by their ids', () => {
    view([
      event(
        'decision',
        ledger({
          id: 'approval-1',
          specId: 'tool.approval',
          outcome: 'approve',
          answers: {
            verdict: { type: 'choice', choice: 'needed', probabilities: { needed: 0.8, unclear: 0.15, beyond: 0.05 } },
          },
        }),
        turn('runtime-a', 1, 2)
      ),
      event(
        'decision',
        ledger({
          id: 'browser-1',
          specId: 'browser.step',
          outcome: { operation: 'CLICK', target: '3', probability: 0.9 },
          answers: {
            operation: { type: 'choice', choice: 'CLICK', probabilities: { CLICK: 0.9, other: 0.1 } },
            click_target: { type: 'choice', choice: '3', probabilities: { '3': 0.7, none: 0.3 } },
          },
        }),
        turn('runtime-a', 1, 3)
      ),
      event(
        'decision',
        ledger({
          id: 'routing-1',
          specId: 'swarm.routing',
          answers: {
            skill_0: { type: 'boolean', probability: 0.5 },
            difficulty: { type: 'score', score: 2.2 },
          },
        }),
        turn('runtime-a', 1, 4)
      ),
    ]);

    const words = copy.answerWords;
    const [routing, browser, approval] = cards().map((card) => within(card));
    for (const card of [routing, browser, approval]) fireEvent.click(card.getByText(copy.details));

    const approvalWords = words.approval;
    expect(labelled(approval, approvalWords.questions.verdict)).toContain(
      `${approvalWords.questions.verdict}${approvalWords.answers.needed} · ${approvalWords.answers.needed} 80% · ` +
        `${approvalWords.answers.unclear} 15% · ${approvalWords.answers.beyond} 5%`
    );
    const stepWords = words.browser;
    expect(labelled(browser, stepWords.questions.operation)).toContain(
      `${stepWords.questions.operation}${stepWords.answers.CLICK} · ${stepWords.answers.CLICK} 90% · ${stepWords.answers.other} 10%`
    );
    // An element number is what the page named it; "none" is said in words.
    expect(labelled(browser, stepWords.questions.click_target)).toContain(
      `${stepWords.questions.click_target}3 · 3 70% · ${stepWords.answers.none} 30%`
    );
    // The result says the step and its field in words too.
    expect(labelled(browser, copy.fields.operation)).toContain(`${copy.fields.operation}${copy.values.CLICK}`);
    expect(labelled(routing, words.routing.questions.difficulty)).toContain(
      `${words.routing.questions.difficulty}${words.routing.levels.difficulty['2']} · Score: 2.20`
    );
    // An id the decision point's table does not have is read as words.
    expect(routing.getByText('skill 0')).toBeInTheDocument();
    for (const card of [routing, browser, approval]) {
      const answers = card.getByText(copy.answers).nextElementSibling?.textContent ?? '';
      for (const id of ['verdict', 'needed', 'unclear', 'operation', 'CLICK', 'click_target', 'difficulty', 'skill_0'])
        expect(answers).not.toMatch(new RegExp(`\\b${id}\\b`));
    }
  });
});

/** A lesson as mu's file keeps it. */
const stored = (id: string, text: string): StoredLesson => ({
  id,
  kind: 'correction',
  trigger: `When ${id} comes up`,
  lesson: text,
  scope: {},
  source: { origin: 'user' },
  status: 'active',
  uses: { recalled: 1, applied: 0 },
  created: '2026-09-20T00:00:00.000Z',
  updated: '2026-09-20T00:00:00.000Z',
});

/** The judge tab as the work panel shows it: the log, inside a router for its settings button. */
const showLog = (events: Activity[]) => {
  const result = render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <JudgeLog events={events} />
      </MemoryRouter>
    </I18nextProvider>
  );
  const rerender = (next: Activity[]) =>
    result.rerender(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <JudgeLog events={next} />
        </MemoryRouter>
      </I18nextProvider>
    );
  return { ...result, rerender };
};
const lines = () => screen.getAllByTestId('judge-line');

/**
 * jsdom lays nothing out: the log's scroller gets a height of 100px and 20px per line, and remembers where it was
 * scrolled to, as a browser would.
 */
function measure(scroller: HTMLElement) {
  let top = 0;
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 100 });
  Object.defineProperty(scroller, 'scrollHeight', {
    configurable: true,
    get: () => scroller.querySelectorAll('[data-testid="judge-line"]').length * 20,
  });
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, scroller.scrollHeight - scroller.clientHeight));
    },
  });
  return { bottom: () => scroller.scrollHeight - scroller.clientHeight };
}

describe('the judge log', () => {
  it('says what happened one line at a time, oldest first: the time and a short sentence, a verdict with its readout', () => {
    showLog([
      event('preflight.verdict', verdict(), turn('runtime-a', 1, 2)),
      event('decision', ledger({ id: 'drift-1', specId: 'turn.drift', outcome: 'on_track' }), turn('runtime-a', 1, 5)),
      event('mcp.failed', { name: 'github', code: 'timeout', reason: 'no answer within 30000 ms' }),
    ]);

    expect(lines().map((line) => line.getAttribute('data-code'))).toEqual([
      'input.preflight',
      'turn.drift',
      'mcp.failed',
    ]);
    expect(lines()[0]).toHaveTextContent(`Classified by Jev: ${copy.values.multi_step_task}`);
    expect(lines()[1]).toHaveTextContent(`${copy.questions.drift} · ${copy.state.returned}`);
    expect(lines()[2]).toHaveTextContent("github: it didn't respond in time");
    // A line leads with its sentence. A verdict follows it with a readout, the decision point that asked as the
    // ledger names it; an event of the run has none, and its code waits until the line is opened.
    expect(within(lines()[0]).getByTestId('judge-line-readout')).toHaveTextContent('input.preflight');
    expect(within(lines()[1]).getByTestId('judge-line-readout')).toHaveTextContent('turn.drift');
    expect(within(lines()[2]).queryByTestId('judge-line-readout')).not.toBeInTheDocument();
    expect(lines()[2]).not.toHaveTextContent('mcp.failed');
    // A line is one line: the whole record waits until it is opened.
    expect(screen.queryByTestId('judge-card')).not.toBeInTheDocument();
    fireEvent.click(within(lines()[1]).getByRole('button'));
    expect(within(lines()[1]).getByTestId('judge-line-code')).toHaveTextContent('turn.drift');
  });

  it('says the permission mode in words, by the name the permission menu gives it', () => {
    showLog([
      event('permissions.mode', { mode: 'judge', label: 'Judge mode', conversationSwitch: true, modes: [] }),
      event('permissions.mode', { mode: 'someday', conversationSwitch: true, modes: [] }),
    ]);

    expect(lines()[0]).toHaveTextContent(`Permission mode: ${mu.permissions.modes.judge.title}`);
    // A mode this build does not know, without a label of its own, is named by the event alone.
    expect(lines()[1]).toHaveTextContent(common.kyrn.event.permissions.mode);
    expect(lines()[1]).not.toHaveTextContent('permissions.mode');
  });

  it('says how things stand once: reopening the conversation adds no lines, a change adds one', () => {
    // Each open starts the harness again, and each start reports the permission mode, the board and what it inherited.
    const opened = (runtime: string, sequence: number) => [
      event('permissions.mode', { mode: 'judge', label: 'Judge mode', modes: [] }, turn(runtime, 0, sequence)),
      event(
        'board.switched',
        { on: false, cwd: '/p', model: null, modelChosen: false },
        turn(runtime, 0, sequence + 1)
      ),
      event('inherit.found', { rules: 2, skills: 1, servers: 0, problems: 0 }, turn(runtime, 0, sequence + 2)),
      event(
        'mcp.failed',
        { id: 'mcp:github', name: 'github', code: 'project_untrusted', reason: 'x' },
        turn(runtime, 0, sequence + 3)
      ),
    ];
    const first = opened('runtime-a', 1);
    const again = opened('runtime-b', 1);
    const switched = [
      event('board.switched', { on: true, cwd: '/p', model: null, modelChosen: false }, turn('runtime-b', 1, 9)),
      event('permissions.mode', { mode: 'full', label: 'Full', modes: [] }, turn('runtime-b', 1, 10)),
    ];
    // The same frame recorded twice, under another id.
    const repeated = { ...switched[0], id: 'copy-of-the-switch' };
    const { rerender } = showLog(first);
    const said = () => lines().map((line) => line.getAttribute('data-code'));
    expect(said()).toEqual(['permissions.mode', 'board.switched', 'inherit.found', 'mcp.failed']);
    expect(lines()[1]).toHaveTextContent('Board: off');
    expect(lines()[1]).not.toHaveTextContent(common.kyrn.event.board.switched);

    rerender([...first, ...again, ...opened('runtime-c', 1)]);
    expect(said()).toEqual(['permissions.mode', 'board.switched', 'inherit.found', 'mcp.failed']);

    rerender([...first, ...again, ...switched, repeated, ...opened('runtime-c', 1)]);
    expect(said()).toEqual([
      'permissions.mode',
      'board.switched',
      'inherit.found',
      'mcp.failed',
      'board.switched',
      'permissions.mode',
      // The next open reports the board off and judge mode again: both changed back, so both get a line.
      'permissions.mode',
      'board.switched',
    ]);
    expect(lines()[4]).toHaveTextContent('Board: on');
    expect(lines()[5]).toHaveTextContent(`Permission mode: ${mu.permissions.modes.full.title}`);
  });

  it('names the lessons a turn followed by their words, as the lessons tab has them', async () => {
    lessons.mockResolvedValue({
      ok: true,
      data: { project: '/work/app', lessons: [stored('lesson-1', 'Run the tests before saying it is done.')] },
    });
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <JudgeLog
            conversationId='conv'
            events={[
              event(
                'decision',
                ledger({
                  id: 'applied-1',
                  specId: 'memory.applied',
                  outcome: { applied: ['lesson-1'], notApplied: ['lesson-2-not-in-the-file'] },
                }),
                turn('r', 2, 3)
              ),
              event('memory.applied', { ids: ['lesson-1'] }),
            ]}
          />
        </MemoryRouter>
      </I18nextProvider>
    );
    await act(async () => undefined);
    expect(lessons).toHaveBeenCalledWith({ conversationId: 'conv' });

    const [judgment, followed] = lines();
    fireEvent.click(within(judgment).getByRole('button'));
    const card = within(within(judgment).getByTestId('judge-card'));
    expect(card.getByText(copy.fields.applied).parentElement).toHaveTextContent(
      'Run the tests before saying it is done.'
    );
    // A lesson that is not in the file goes by the start of its id, as the lessons tab names it.
    expect(card.getByText(copy.fields.notApplied).parentElement).toHaveTextContent('lesson-2');
    expect(card.queryByText(/lesson-1/)).not.toBeInTheDocument();

    fireEvent.click(within(followed).getByRole('button'));
    expect(within(followed).getByText('Run the tests before saying it is done.')).toBeInTheDocument();
  });

  it('reads no lessons file for a log that names no lesson', async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <JudgeLog conversationId='conv' events={[event('preflight.verdict', verdict(), turn('runtime-a', 1, 2))]} />
        </MemoryRouter>
      </I18nextProvider>
    );
    await act(async () => undefined);
    expect(lessons).not.toHaveBeenCalled();
  });

  it('opens a line to the whole record: a judgment as its card, an event as its words and raw payload', () => {
    showLog([
      event('preflight.verdict', verdict(), turn('runtime-a', 1, 2)),
      event('mcp.failed', { name: 'github', code: 'timeout', reason: 'no answer within 30000 ms' }),
    ]);

    fireEvent.click(within(lines()[0]).getByRole('button'));
    expect(within(lines()[0]).getByTestId('judge-card')).toHaveTextContent(copy.actions.toRuntime);

    fireEvent.click(within(lines()[1]).getByRole('button'));
    expect(within(lines()[1]).getByText('Details: no answer within 30000 ms')).toBeInTheDocument();
    expect(within(lines()[1]).getByText(/"code": "timeout"/)).toBeInTheDocument();
  });

  it('keeps the verdict on the message being worked on pinned above the log while its turn runs', () => {
    const start = event('agent_start', {});
    const judged = event('preflight.verdict', verdict({ turnType: 'research' }), turn('runtime-a', 1, 2));
    const { rerender } = showLog([start, judged]);

    const pinned = screen.getByTestId('judge-pinned');
    expect(pinned).toHaveTextContent(copy.log.thisTurn);
    expect(pinned).toHaveTextContent(`Classified by Jev: ${copy.values.research}`);

    rerender([start, judged, event('agent_settled', {})]);
    expect(screen.queryByTestId('judge-pinned')).not.toBeInTheDocument();
  });

  it('follows new lines at the bottom, and stops following while the person reads further up', () => {
    const events = Array.from({ length: 8 }, (_unused, index) => event('ttsr.interrupted', { text: `rule ${index}` }));
    const { rerender } = showLog(events);
    const scroller = screen.getByTestId('judge-log');
    const { bottom } = measure(scroller);

    // A new line arrives while the bottom is in view: the log follows it.
    const more = [...events, event('ttsr.interrupted', { text: 'rule 8' })];
    rerender(more);
    expect(scroller.scrollTop).toBe(bottom());
    expect(screen.queryByText(copy.log.latest)).not.toBeInTheDocument();

    // Scrolled up to read: the next line leaves the view where it is, and offers the way back.
    scroller.scrollTop = 20;
    fireEvent.scroll(scroller);
    const later = [...more, event('ttsr.interrupted', { text: 'rule 9' })];
    rerender(later);
    expect(scroller.scrollTop).toBe(20);
    fireEvent.click(screen.getByText(copy.log.latest));
    expect(scroller.scrollTop).toBe(bottom());

    // Back at the bottom, it follows again.
    rerender([...later, event('ttsr.interrupted', { text: 'rule 10' })]);
    expect(scroller.scrollTop).toBe(bottom());
    expect(screen.queryByText(copy.log.latest)).not.toBeInTheDocument();
  });

  it('says the same line many times in a row once, with a count, and an opened line stays open as it grows', () => {
    const look = () => event('ttsr.interrupted', { text: 'rule a' });
    const before = [event('mcp.failed', { name: 'github', code: 'timeout', reason: 'no answer' }), look(), look()];
    const { rerender } = showLog(before);
    expect(lines()).toHaveLength(2);
    expect(within(lines()[0]).queryByTestId('judge-line-count')).not.toBeInTheDocument();
    expect(within(lines()[1]).getByTestId('judge-line-count')).toHaveTextContent('×2');

    fireEvent.click(within(lines()[1]).getByRole('button'));
    rerender([...before, look()]);
    expect(lines()).toHaveLength(2);
    expect(within(lines()[1]).getByTestId('judge-line-count')).toHaveTextContent('×3');
    expect(within(lines()[1]).getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows the preflight’s hints as short chips after its verdict, and an unknown hint by its code', () => {
    showLog([
      event(
        'preflight.verdict',
        verdict({
          hints: ['Act on the reply.', 'Plan aloud.', 'A later hint.'],
          hintIds: ['answered', 'plan_first', 'someday_hint'],
        }),
        turn('runtime-a', 1, 2)
      ),
    ]);

    const chips = within(lines()[0]).getAllByTestId('judge-hint-chip');
    expect(chips.map((chip) => chip.getAttribute('data-hint'))).toEqual(['answered', 'plan_first', 'someday_hint']);
    expect(chips.map((chip) => chip.textContent)).toEqual([
      copy.hintChips.answered,
      copy.hintChips.plan_first,
      'someday_hint',
    ]);
  });

  it('says the chips in the app language', async () => {
    const chinese = createInstance();
    await chinese.init({
      lng: 'zh-CN',
      resources: { 'zh-CN': { translation: { common: zhCommon, mu: zhMu } } },
      interpolation: { escapeValue: false },
    });
    render(
      <I18nextProvider i18n={chinese}>
        <MemoryRouter>
          <JudgeLog
            events={[
              event(
                'preflight.verdict',
                verdict({ hints: ['Look first.'], hintIds: ['resolve'] }),
                turn('runtime-a', 1, 2)
              ),
            ]}
          />
        </MemoryRouter>
      </I18nextProvider>
    );
    expect(screen.getByTestId('judge-hint-chip')).toHaveTextContent(zhCommon.kyrn.judgeView.hintChips.resolve);
  });

  it('opens the judges’ settings from its toolbar', async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/conversation/conv']}>
          <Routes>
            <Route path='/conversation/:id' element={<JudgeLog events={[]} />} />
            <Route path='/settings/judges' element={<p>judges settings</p>} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: common.kyrn.settings }));
    expect(await screen.findByText('judges settings')).toBeInTheDocument();
  });

  it('says so when nothing was judged', () => {
    showLog([]);

    expect(screen.getByText(copy.empty)).toBeInTheDocument();
    expect(screen.queryByTestId('judge-line')).not.toBeInTheDocument();
  });

  it('is the judge tab of the work panel, once the conversation’s record has arrived', async () => {
    activity.mockResolvedValue({
      ok: true,
      data: {
        sessionId: 'session',
        cursor: 3,
        more: false,
        events: [
          event('preflight.verdict', verdict(), turn('runtime-a', 1, 2)),
          event('agent_start', {}),
          event('agent_settled', {}),
        ],
      },
    });
    function Tab() {
      const read = useKyrnActivity('conv');
      return <KernelBody tab='judge' conversationId='conv' activity={read} />;
    }
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <Tab />
        </MemoryRouter>
      </I18nextProvider>
    );

    expect(screen.getByText(common.loading)).toBeInTheDocument();
    expect(await screen.findByTestId('kyrn-judge')).toBeInTheDocument();
    // The verdict is one line, not also a raw row among the runtime events.
    expect(lines().map((line) => line.getAttribute('data-code'))).toEqual([
      'input.preflight',
      'agent_start',
      'agent_settled',
    ]);
    await act(async () => undefined);
  });
});
