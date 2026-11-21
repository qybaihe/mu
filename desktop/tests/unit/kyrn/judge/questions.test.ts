import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LANGUAGES } from '@/common/config/i18n';
import { DECISIONS } from '../../../../packages/desktop/src/renderer/pages/conversation/KyrnPanel/Judge/activity';
import {
  findQuestion,
  JUDGE_QUESTIONS,
  questionKey,
} from '../../../../packages/desktop/src/renderer/pages/conversation/KyrnPanel/Judge/questions';

/**
 * Every question a decision point asks the judge has words in every language: its name, each answer a choice offers,
 * each step of a score. A card never shows a question id or an answer id.
 */

type Words = {
  questions: Record<string, string>;
  answers?: Record<string, string>;
  levels?: Record<string, Record<string, string>>;
};

const localeRoot = fileURLToPath(
  new URL('../../../../packages/desktop/src/renderer/services/i18n/locales/', import.meta.url)
);
const wordsOf = (language: string): Record<string, Words> =>
  JSON.parse(readFileSync(join(localeRoot, language, 'common.json'), 'utf8')).kyrn.judgeView.answerWords;
const specIds = Object.keys(DECISIONS) as (keyof typeof DECISIONS)[];

describe('the judge question table', () => {
  it('has a table for every decision point the view knows, and nothing else', () => {
    expect(Object.keys(JUDGE_QUESTIONS).toSorted()).toEqual(specIds.toSorted());
    for (const specId of specIds) expect(JUDGE_QUESTIONS[specId].length, specId).toBeGreaterThan(0);
  });

  it('gives each question of a decision point words of its own', () => {
    for (const specId of specIds) {
      const keys = JUDGE_QUESTIONS[specId].map(questionKey);
      expect(new Set(keys).size, specId).toBe(keys.length);
    }
  });

  it('finds a question by its id, and one asked per item by its index, counted from 1', () => {
    const board = JUDGE_QUESTIONS['board.read'];
    expect(findQuestion(board, 'phase')?.question.id).toBe('phase');
    expect(findQuestion(board, 'event_0')).toMatchObject({ question: { id: 'event_' }, number: 1 });
    expect(findQuestion(board, 'event_12')).toMatchObject({ number: 13 });
    expect(findQuestion(JUDGE_QUESTIONS['memory.worth'], 'worth_1')).toMatchObject({ number: 1 });
    // The single admission question and the batch's `k1`, `k2` … are told apart.
    const admission = JUDGE_QUESTIONS['tool.admission'];
    expect(findQuestion(admission, 'kind')).toEqual({ question: admission[0] });
    expect(findQuestion(admission, 'k3')).toMatchObject({ question: { key: 'chunk' }, number: 3 });
    expect(findQuestion(board, 'event_')).toBeUndefined();
    expect(findQuestion(board, 'event_x')).toBeUndefined();
    expect(findQuestion(board, 'phases')).toBeUndefined();
  });
});

describe.each(SUPPORTED_LANGUAGES)('the judge answer words in %s', (language) => {
  const words = wordsOf(language);

  it('covers exactly the decision points of the table', () => {
    expect(Object.keys(words).toSorted()).toEqual(specIds.map((specId) => DECISIONS[specId]).toSorted());
  });

  it('names every question, says every answer and every step of a score, and keeps no word unused', () => {
    for (const specId of specIds) {
      const stage = DECISIONS[specId];
      const said = words[stage];
      const questions = JUDGE_QUESTIONS[specId];
      const where = `${language} ${stage}`;
      expect(Object.keys(said.questions).toSorted(), where).toEqual(questions.map(questionKey).toSorted());
      const choices = questions.filter((question) => question.type === 'choice');
      const numbered = new Set(choices.flatMap((question) => question.numberedAnswers ?? []));
      const answers = new Set([...choices.flatMap((question) => question.answers), ...numbered]);
      expect(Object.keys(said.answers ?? {}).toSorted(), where).toEqual([...answers].toSorted());
      for (const [id, text] of Object.entries(said.answers ?? {})) {
        expect(text.includes('{{number}}'), `${where} ${id}`).toBe(numbered.has(id));
      }
      const scores = questions.filter((question) => question.type === 'score');
      expect(Object.keys(said.levels ?? {}).toSorted(), where).toEqual(scores.map(questionKey).toSorted());

      for (const question of questions) {
        const name = said.questions[questionKey(question)];
        expect(name, `${where} ${question.id}`).toBeTruthy();
        // One asked per item says which; a single question never shows a number slot.
        expect(name.includes('{{number}}'), `${where} ${question.id}`).toBe(question.from !== undefined);
        if (question.type === 'score') {
          const steps = said.levels?.[questionKey(question)] ?? {};
          expect(Object.keys(steps), `${where} ${question.id}`).toEqual(
            Array.from({ length: question.levels }, (_, step) => String(step))
          );
        }
      }
    }
  });

  it('says every question and answer in words, never as the id', () => {
    for (const specId of specIds) {
      const said = words[DECISIONS[specId]];
      const texts = [
        ...Object.entries(said.questions),
        ...Object.entries(said.answers ?? {}),
        ...Object.values(said.levels ?? {}).flatMap((steps) => Object.entries(steps)),
      ];
      for (const [id, text] of texts) {
        expect(text.trim(), `${language} ${specId} ${id}`).not.toBe('');
        expect(text, `${language} ${specId} ${id}`).not.toBe(id);
        expect(text, `${language} ${specId} ${id}`).not.toContain('_');
      }
    }
  });
});
