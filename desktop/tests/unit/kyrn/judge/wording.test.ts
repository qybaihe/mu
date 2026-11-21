import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createInstance, type TFunction } from 'i18next';
import {
  answerLabel,
  answerValue,
  hintChips,
  hintLines,
  JUDGE_ERROR_KINDS,
  JUDGE_REASONS,
  PREFLIGHT_HINT_IDS,
  reasonText,
  scoreLevel,
} from '../../../../packages/desktop/src/renderer/pages/conversation/KyrnPanel/Judge/wording';
import common from '../../../../packages/desktop/src/renderer/services/i18n/locales/en-US/common.json';
import faIR from '../../../../packages/desktop/src/renderer/services/i18n/locales/fa-IR/common.json';
import zhCN from '../../../../packages/desktop/src/renderer/services/i18n/locales/zh-CN/common.json';
import zhTW from '../../../../packages/desktop/src/renderer/services/i18n/locales/zh-TW/common.json';

const copy = common.kyrn.judgeView;
const zh = zhCN.kyrn.judgeView;

let en: TFunction;
let chinese: TFunction;
let persian: TFunction;
beforeAll(async () => {
  const make = async (lng: string, translation: Record<string, unknown>) => {
    const i18n = createInstance();
    await i18n.init({ lng, resources: { [lng]: { translation } }, interpolation: { escapeValue: false } });
    return i18n.t;
  };
  en = await make('en-US', { common });
  chinese = await make('zh-CN', { common: zhCN });
  persian = await make('fa-IR', { common: faIR });
});

/** The harness's own sentences (packages/kyrn-judge/src/extension/features/preflight.ts, PREFLIGHT_HINTS). */
const HINTS = {
  clarify: 'The request looks under-specified. Ask one focused clarifying question before doing significant work.',
  plan_first: 'This looks like a large or risky change. Write a short plan and confirm the approach before editing.',
};

describe('Judge card wording: the judge’s reason', () => {
  it('names every judge error kind and keeps an unknown kind as recorded', () => {
    for (const kind of JUDGE_ERROR_KINDS) {
      const label = (copy.values as Record<string, string>)[kind];
      expect(reasonText(en, 'en-US', `error:${kind}`)).toBe(`${copy.values.error} · ${label}`);
    }
    expect(reasonText(chinese, 'zh-CN', 'error:rate_limited')).toBe(`${zh.values.error} · ${zh.values.rate_limited}`);
    expect(reasonText(en, 'en-US', 'error:quota_gone')).toBe(`${copy.values.error} · quota_gone`);
  });

  it('names the reasons that are no error, and shows a code it does not know as recorded', () => {
    expect(reasonText(en, 'en-US', 'abstain')).toBe(copy.values.abstain);
    expect(reasonText(en, 'en-US', 'shadow')).toBe(copy.values.shadow);
    expect(reasonText(chinese, 'zh-CN', 'skipped')).toBe(zh.values.skipped);
    expect(reasonText(chinese, 'zh-CN', 'verdict')).toBe(zh.values.verdict);
    expect(reasonText(en, 'en-US', 'no_answer')).toBe(copy.values.no_answer);
    expect(reasonText(en, 'en-US', 'someday_reason')).toBe('someday_reason');
    // A code this build has no words for says what the record says in English.
    expect(reasonText(chinese, 'zh-CN', 'budget_spent', undefined, 'the judge budget is spent')).toBe(
      'the judge budget is spent'
    );
    // A known code never shows the English beside it.
    expect(reasonText(chinese, 'zh-CN', 'skipped', undefined, 'skipped by the user')).toBe(zh.values.skipped);
    expect(reasonText(en, 'en-US', '')).toBe('');
  });

  it('says how long a wait without an answer lasted, in the app language', () => {
    expect(reasonText(en, 'en-US', 'no_answer', { seconds: 6 })).toMatch(/^No answer after 6\s?sec/);
    expect(reasonText(chinese, 'zh-CN', 'no_answer', { seconds: 6 })).toMatch(/^6\s?秒内未得到回答$/);
  });

  it('has words for every reason and error kind in each reference language', () => {
    for (const locale of [common, zhCN, zhTW]) {
      const view = locale.kyrn.judgeView;
      const values = view.values as Record<string, string>;
      for (const code of [...JUDGE_ERROR_KINDS, ...JUDGE_REASONS, 'error']) expect(values[code]).toBeTruthy();
      expect(view.noAnswerAfter).toContain('{{duration}}');
    }
  });
});

describe('Judge card wording: hints and answers', () => {
  it('says each hint by its id and keeps the recorded sentence where there is none', () => {
    expect(hintLines(en, [HINTS.clarify, HINTS.plan_first], ['clarify', 'plan_first'])).toEqual([
      copy.hints.clarify,
      copy.hints.plan_first,
    ]);
    expect(hintLines(chinese, [HINTS.clarify], ['clarify'])).toEqual([zh.hints.clarify]);
    // Older records carry the sentences only; an id this build does not know falls back to its sentence.
    expect(hintLines(chinese, ['Write a short plan.'], [])).toEqual(['Write a short plan.']);
    expect(hintLines(chinese, ['A new hint.', HINTS.clarify], ['new_hint', 'clarify'])).toEqual([
      'A new hint.',
      zh.hints.clarify,
    ]);
    expect(hintLines(en, [], [])).toEqual([]);
  });

  it('names each question by its own decision point, and one asked per item with the item counted from 1', () => {
    const words = copy.answerWords;
    expect(answerLabel(en, 'en-US', 'preflight', 'turn_type')).toBe(words.preflight.questions.turn_type);
    expect(answerLabel(chinese, 'zh-CN', 'preflight', 'needs_clarification')).toBe(
      zh.answerWords.preflight.questions.needs_clarification
    );
    expect(answerLabel(en, 'en-US', 'rewind', 'dead_end')).toBe(words.rewind.questions.dead_end);
    expect(answerLabel(en, 'en-US', 'approval', 'verdict')).toBe(words.approval.questions.verdict);
    expect(answerLabel(en, 'en-US', 'relate', 'relation')).toBe(words.relate.questions.relation);
    // Two decision points ask a `correction`, each its own question.
    expect(answerLabel(en, 'en-US', 'capture', 'correction')).toBe(words.capture.questions.correction);
    expect(answerLabel(en, 'en-US', 'skills', 'skill_0')).toBe('Skill 1 would help');
    expect(answerLabel(en, 'en-US', 'worth', 'worth_2')).toBe('Lesson 2');
    expect(answerLabel(en, 'en-US', 'admission', 'k12')).toBe('Output part 12');
    expect(answerLabel(chinese, 'zh-CN', 'board', 'event_0')).toBe('事件 1');
  });

  it('reads an id it has no words for as words, never as the id', () => {
    // A question a newer harness adds, a decision point this build does not know, an older record's English label.
    expect(answerLabel(en, 'en-US', 'drift', 'plan_first')).toBe('plan first');
    expect(answerLabel(en, 'en-US', 'other', 'still_to_come')).toBe('still to come');
    expect(answerLabel(en, 'en-US', 'preflight', 'Turn type')).toBe('Turn type');
  });

  it('says a choice’s answers in the decision point’s words, and leaves an answer named at run time to the view', () => {
    const words = copy.answerWords;
    expect(answerValue(en, 'en-US', 'approval', 'verdict', 'needed')).toBe(words.approval.answers.needed);
    expect(answerValue(en, 'en-US', 'approval', 'verdict', 'unclear')).toBe(words.approval.answers.unclear);
    expect(answerValue(chinese, 'zh-CN', 'relate', 'relation', 'supersedes')).toBe(
      zh.answerWords.relate.answers.supersedes
    );
    expect(answerValue(en, 'en-US', 'browser', 'operation', 'SCROLL_DOWN')).toBe(words.browser.answers.SCROLL_DOWN);
    expect(answerValue(en, 'en-US', 'admission', 'k2', 'passing')).toBe(words.admission.answers.passing);
    expect(answerValue(en, 'en-US', 'board', 'event_3', 'key')).toBe(words.board.answers.key);
    // An element number, a role, an answer a newer harness adds, a question that is no choice.
    expect(answerValue(en, 'en-US', 'browser', 'click_target', '3')).toBeUndefined();
    expect(answerValue(en, 'en-US', 'routing', 'agent', 'scout')).toBeUndefined();
    expect(answerValue(en, 'en-US', 'drift', 'course', 'sideways')).toBeUndefined();
    expect(answerValue(en, 'en-US', 'risk', 'destructive', 'true')).toBeUndefined();
  });

  it('names a constraint target using its recorded 1-based number in the app language', () => {
    expect(answerLabel(en, 'en-US', 'taskFrame', 'limit')).toBe('Change to constraints');
    expect(answerValue(en, 'en-US', 'taskFrame', 'limit', 'withdraw_2')).toBe('Lift constraint 2');
    expect(answerValue(en, 'en-US', 'taskFrame', 'limit', 'replace_1')).toBe('Replace constraint 1');
    expect(answerValue(persian, 'fa-IR', 'taskFrame', 'limit', 'withdraw_2')).toBe('لغو محدودیت ۲');
    expect(answerValue(en, 'en-US', 'taskFrame', 'limit', 'withdraw_0')).toBeUndefined();
    expect(answerValue(en, 'en-US', 'taskFrame', 'limit', 'keep_2')).toBeUndefined();
    expect(answerValue(en, 'en-US', 'taskFrame', 'change', 'replace_1')).toBeUndefined();
  });

  it('distinguishes allowing one exact call from lifting the rule', () => {
    expect(answerValue(en, 'en-US', 'taskFrame', 'limit', 'once_2')).toBe('Allow a one-time exception to constraint 2');
    expect(answerValue(persian, 'fa-IR', 'taskFrame', 'limit', 'once_2')).toBe('اجازهٔ استثنای یک‌باره برای محدودیت ۲');
    expect(answerValue(en, 'en-US', 'taskFrame', 'limit', 'once_0')).toBeUndefined();
    expect(answerLabel(en, 'en-US', 'constraint', 'permission_once')).toBe(
      'Did you explicitly allow this exact call once?'
    );
    expect(answerValue(en, 'en-US', 'constraint', 'permission_once', 'true')).toBeUndefined();
  });

  it('labels constraint verdicts and keeps the v1 task-frame choice readable', () => {
    expect(answerLabel(en, 'en-US', 'constraint', 'constraint_0')).toBe('Does the call violate constraint 1?');
    expect(answerValue(en, 'en-US', 'constraint', 'constraint_0', 'violates')).toBe('Direct violation');
    expect(answerValue(en, 'en-US', 'constraint', 'constraint_0', 'compatible')).toBe('No direct violation');
    expect(answerValue(en, 'en-US', 'constraint', 'constraint_0', 'unclear')).toBe("Can't tell");
    expect(answerValue(en, 'en-US', 'taskFrame', 'change', 'constraint')).toBe('A new rule for the work');
  });

  it('says the step a score lands on, as the harness rounds it', () => {
    const levels = copy.answerWords.preflight.levels.task_complexity;
    expect(scoreLevel(en, 'preflight', 'task_complexity', 1.91)).toBe(levels['2']);
    expect(scoreLevel(en, 'preflight', 'task_complexity', 0.2)).toBe(levels['0']);
    expect(scoreLevel(en, 'preflight', 'task_complexity', 7)).toBe(levels['3']);
    expect(scoreLevel(en, 'routing', 'reasoning', 1)).toBe(copy.answerWords.routing.levels.reasoning['1']);
    expect(scoreLevel(en, 'preflight', 'plan_first', 1)).toBeUndefined();
    expect(scoreLevel(en, 'other', 'fit', 1)).toBeUndefined();
  });

  it('has words for every hint in each reference language', () => {
    for (const locale of [common, zhCN, zhTW]) {
      const view = locale.kyrn.judgeView;
      for (const id of PREFLIGHT_HINT_IDS) expect((view.hints as Record<string, string>)[id]).toBeTruthy();
    }
  });
});

describe('Judge hint chips', () => {
  it('names each hint the harness sends in a word or two, and keeps an unknown code as recorded', () => {
    expect(hintChips(en, ['answered', 'resolve', 'try_hive'])).toEqual([
      { id: 'answered', label: copy.hintChips.answered },
      { id: 'resolve', label: copy.hintChips.resolve },
      { id: 'try_hive', label: copy.hintChips.try_hive },
    ]);
    expect(hintChips(chinese, ['plan_first'])).toEqual([{ id: 'plan_first', label: zh.hintChips.plan_first }]);
    // Older records have sentences without ids: no chip for those.
    expect(hintChips(en, ['', 'someday_hint'])).toEqual([{ id: 'someday_hint', label: 'someday_hint' }]);
  });

  it('has a chip and a sentence for every hint in all 13 languages', () => {
    const root = path.resolve(__dirname, '../../../..');
    const { supportedLanguages } = JSON.parse(
      readFileSync(path.join(root, 'packages/desktop/src/common/config/i18n-config.json'), 'utf8')
    ) as { supportedLanguages: string[] };
    expect(supportedLanguages).toHaveLength(13);
    for (const language of supportedLanguages) {
      const locale = JSON.parse(
        readFileSync(
          path.join(root, 'packages/desktop/src/renderer/services/i18n/locales', language, 'common.json'),
          'utf8'
        )
      ) as { kyrn: { judgeView: { hints: Record<string, string>; hintChips: Record<string, string> } } };
      for (const id of PREFLIGHT_HINT_IDS) {
        expect(locale.kyrn.judgeView.hintChips[id], `${language} chip ${id}`).toBeTruthy();
        expect(locale.kyrn.judgeView.hints[id], `${language} hint ${id}`).toBeTruthy();
      }
    }
  });
});
