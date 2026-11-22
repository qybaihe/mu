/**
 * The quiz's pure half (side-tutor case 3): the prompt one entry becomes, the strict parse of a model's answer, the
 * integer grade, and the content hash that ties a question to the entry it was made of.
 */
import { describe, expect, it } from 'vitest';
import {
  QUIZ_MIN_TEXT,
  QUIZ_OPTION_COUNT,
  buildQuizPrompt,
  gradeQuiz,
  parseQuizDecision,
  quizHashOf,
  quizViewOf,
  type QuizQuestion,
} from '@/common/chat/journal/quizCore';

const QUESTION: QuizQuestion = {
  stem: 'A teammate is about to push straight to main because ‘it is just a doc change’. What does the lesson say?',
  options: [
    'Push it — docs are safe',
    'Ask first: push rules hold for docs too',
    'Revert the change silently',
    'Delete the branch',
  ],
  answerIndex: 1,
};

const RAW = JSON.stringify({ stem: QUESTION.stem, options: QUESTION.options, answer: 1 });

describe('the ask of one entry', () => {
  it('carries the trigger and the lesson to the model, under the scenario rules', () => {
    const prompt = buildQuizPrompt({
      trigger: 'when a push is about to happen',
      text: 'Push rules hold for docs too.',
    });
    expect(prompt.system).toContain('NEW, concrete situation');
    expect(prompt.system).toContain('skip');
    expect(JSON.parse(prompt.user)).toEqual({
      trigger: 'when a push is about to happen',
      lesson: 'Push rules hold for docs too.',
    });
  });

  it('sends an empty trigger when the entry has none (a ledger line)', () => {
    expect(JSON.parse(buildQuizPrompt({ text: 'Read HANDOFF first.' }).user)).toEqual({
      trigger: '',
      lesson: 'Read HANDOFF first.',
    });
  });
});

describe('the strict parse', () => {
  it('takes a whole, well-formed answer', () => {
    expect(parseQuizDecision(RAW)).toEqual(QUESTION);
  });

  it('takes the answer out of prose or a code fence', () => {
    expect(parseQuizDecision(`Here you go:\n\`\`\`json\n${RAW}\n\`\`\`\nGood luck!`)).toEqual(QUESTION);
  });

  it('takes a deliberate skip with its reason', () => {
    expect(parseQuizDecision('{"skip": "purely factual, nothing to apply"}')).toEqual({
      skip: 'purely factual, nothing to apply',
    });
  });

  it('refuses everything that does not hold exactly', () => {
    expect(parseQuizDecision('not json at all')).toBeUndefined();
    expect(parseQuizDecision('{}')).toBeUndefined();
    expect(parseQuizDecision('{"stem": "", "options": ["a","b","c","d"], "answer": 0}')).toBeUndefined();
    expect(parseQuizDecision('{"stem": "s", "options": ["a","b","c"], "answer": 0}')).toBeUndefined();
    expect(parseQuizDecision('{"stem": "s", "options": ["a","b","c","d","e"], "answer": 0}')).toBeUndefined();
    // A blank option is no option.
    expect(parseQuizDecision('{"stem": "s", "options": ["a","b","c"," "], "answer": 0}')).toBeUndefined();
    // Two options that read the same make the key ambiguous.
    expect(parseQuizDecision('{"stem": "s", "options": ["a","b","c","a"], "answer": 0}')).toBeUndefined();
    // An answer off the list is no answer.
    expect(parseQuizDecision('{"stem": "s", "options": ["a","b","c","d"], "answer": 4}')).toBeUndefined();
    expect(parseQuizDecision('{"stem": "s", "options": ["a","b","c","d"], "answer": "1"}')).toBeUndefined();
    expect(parseQuizDecision('{"stem": "s", "options": ["a","b","c","d"]}')).toBeUndefined();
  });
});

describe('the grade', () => {
  it('is one integer comparison', () => {
    expect(gradeQuiz(1, QUESTION)).toBe(true);
    expect(gradeQuiz(0, QUESTION)).toBe(false);
    expect(gradeQuiz(-1, QUESTION)).toBe(false);
    expect(gradeQuiz(1.5, QUESTION)).toBe(false);
    expect(gradeQuiz(Number.NaN, QUESTION)).toBe(false);
  });
});

describe('the content hash', () => {
  it('is one quiz per lesson, any way its whitespace, case or width is written', () => {
    const one = quizHashOf({ trigger: 'when  pushing', text: 'Docs  count' });
    expect(quizHashOf({ trigger: 'when pushing', text: 'docs count' })).toBe(one);
    expect(quizHashOf({ trigger: 'when pushing', text: 'docs  count ' })).toBe(one);
  });

  it('separates a changed lesson, and a lesson from its absence of trigger', () => {
    const one = quizHashOf({ trigger: 't', text: 'a' });
    expect(quizHashOf({ trigger: 't', text: 'b' })).not.toBe(one);
    expect(quizHashOf({ text: 'a' })).not.toBe(one);
  });
});

describe('the view the renderer gets', () => {
  it('carries the question and its hash, and nothing of the key', () => {
    const view = quizViewOf('ab cd', QUESTION);
    expect(view).toEqual({ hash: 'ab cd', stem: QUESTION.stem, options: QUESTION.options });
    expect(Object.keys(view).toSorted()).toEqual(['hash', 'options', 'stem']);
    expect(JSON.stringify(view)).not.toContain('answerIndex');
  });

  it('hands the options over as a copy, so the key cannot be edited into view', () => {
    const view = quizViewOf('h', QUESTION);
    view.options.push('a fifth');
    expect(QUESTION.options).toHaveLength(QUIZ_OPTION_COUNT);
  });
});

describe('the thin-entry floor', () => {
  it('sits where a real lesson starts', () => {
    // Real lessons run a dozen characters and up; the floor only takes lines with nothing to attach a situation to.
    expect(QUIZ_MIN_TEXT).toBeLessThanOrEqual(6);
  });
});
