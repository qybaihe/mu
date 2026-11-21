import type { TFunction } from 'i18next';
import { formatDuration, formatNumber } from '@/renderer/services/i18n/format';
import { DECISIONS, type JudgeStage, type ReasonParams } from './activity';
import { findQuestion, JUDGE_QUESTIONS, questionKey, type JudgeQuestion } from './questions';

const KEY = 'common.kyrn.judgeView';

/** The `<kind>` of a failed judge call (`error:<kind>`); `all` is a batch in which every item failed. */
export const JUDGE_ERROR_KINDS = [
  'timeout',
  'aborted',
  'unreachable',
  'auth',
  'payment_required',
  'rate_limited',
  'bad_request',
  'server',
  'invalid_response',
  'unexpected',
  'all',
] as const;

/**
 * Why a judgment did not drive execution, other than an error: the decision's own reasons (`shadow`, `abstain`,
 * `off`), the preflight's (`skipped`, `no_answer`) and why its wait ended (`timeout`, `verdict`).
 */
export const JUDGE_REASONS = ['shadow', 'abstain', 'off', 'skipped', 'no_answer', 'timeout', 'verdict'] as const;

/**
 * The preflight's hints to the main model, by the id the harness records beside each sentence (the harness's
 * kyrn/docs/features/presentation-codes.md, preflight.verdict). `clarify` is an older harness's; the others are
 * what it sends now.
 */
export const PREFLIGHT_HINT_IDS = [
  'answered',
  'resolve',
  'clarify',
  'side_question',
  'plan_first',
  'try_hive',
  'try_delegate',
] as const;

export type PreflightHintId = (typeof PREFLIGHT_HINT_IDS)[number];

const known = <T extends string>(ids: readonly T[], id: string): id is T => (ids as readonly string[]).includes(id);

/** Whether this build has words for a hint id (`hints.<id>`, `hintChips.<id>`). */
export const isPreflightHintId = (id: string): id is PreflightHintId => known(PREFLIGHT_HINT_IDS, id);

/**
 * A recorded reason in the app language. A code this build has no words for is shown in the recorded English
 * (`fallback`), or as the code itself where the record has nothing else, so a reason the harness adds later still
 * says something; an empty one says nothing.
 */
export function reasonText(
  t: TFunction,
  language: string,
  code: string,
  params?: ReasonParams,
  fallback?: string
): string {
  if (!code) return '';
  if (code.startsWith('error:')) {
    const kind = code.slice('error:'.length);
    return t(`${KEY}.errorValue`, { kind: known(JUDGE_ERROR_KINDS, kind) ? t(`${KEY}.values.${kind}`) : kind });
  }
  if (code === 'no_answer' && params?.seconds !== undefined)
    return t(`${KEY}.noAnswerAfter`, { duration: formatDuration(params.seconds * 1000, language) });
  return known(JUDGE_REASONS, code) ? t(`${KEY}.values.${code}`) : fallback || code;
}

/**
 * The hints as the reader's language says them: by id where the record has one, otherwise the sentence the main
 * model was given (older records, or an id this build does not know).
 */
export function hintLines(t: TFunction, hints: readonly string[], hintIds: readonly string[]): string[] {
  return Array.from({ length: Math.max(hints.length, hintIds.length) }, (_, index) => {
    const id = hintIds[index] ?? '';
    return known(PREFLIGHT_HINT_IDS, id) ? t(`${KEY}.hints.${id}`) : (hints[index] ?? '');
  }).filter(Boolean);
}

/**
 * The short name of a hint for a chip after the verdict line ("Plan first"); an id this build does not know stays as
 * recorded, so a hint the harness adds later still shows. Empty ids (older records) have no chip.
 */
export function hintChips(t: TFunction, hintIds: readonly string[]): { id: string; label: string }[] {
  return hintIds
    .filter(Boolean)
    .map((id) => ({ id, label: known(PREFLIGHT_HINT_IDS, id) ? t(`${KEY}.hintChips.${id}`) : id }));
}

/** Each decision point's questions by its stage, from the table by spec id. */
const QUESTIONS = new Map<JudgeStage, readonly JudgeQuestion[]>(
  (Object.keys(DECISIONS) as (keyof typeof DECISIONS)[]).map((specId) => [DECISIONS[specId], JUDGE_QUESTIONS[specId]])
);

const questionOf = (stage: JudgeStage, id: string) => findQuestion(QUESTIONS.get(stage) ?? [], id);

/**
 * The name of the question an answer belongs to, by its decision point (`questions.ts`), so a question another point
 * asks under the same id keeps its own name. A question asked once per item says which item, counted from 1. An id
 * this build has no words for (a newer harness, an unknown decision point) is read as words, not shown as an id.
 */
export function answerLabel(t: TFunction, language: string, stage: JudgeStage, id: string): string {
  const found = questionOf(stage, id);
  if (!found) return id.replaceAll('_', ' ').trim() || id;
  const words = `${KEY}.answerWords.${stage}.questions.${questionKey(found.question)}`;
  return found.number === undefined ? t(words) : t(words, { number: formatNumber(found.number, language) });
}

/**
 * An answer to a choice in the app language, by the words its decision point gives it; undefined for an answer it
 * has none for (an element, a role or an item named at run time, or an answer a newer harness adds).
 */
export function answerValue(
  t: TFunction,
  language: string,
  stage: JudgeStage,
  id: string,
  value: string
): string | undefined {
  const question = questionOf(stage, id)?.question;
  if (question?.type !== 'choice') return undefined;
  const words = `${KEY}.answerWords.${stage}.answers`;
  if (question.answers.includes(value)) return t(`${words}.${value}`);
  if (!question.numberedAnswers) return undefined;
  const numbered = /^([a-z]+)_([1-9]\d*)$/.exec(value);
  if (!numbered || !question.numberedAnswers.includes(numbered[1])) return undefined;
  const number = Number(numbered[2]);
  return Number.isSafeInteger(number)
    ? t(`${words}.${numbered[1]}`, { number: formatNumber(number, language) })
    : undefined;
}

/** The step a score lands on, in words: the nearest step, as the harness rounds it. Undefined for an unknown score. */
export function scoreLevel(t: TFunction, stage: JudgeStage, id: string, score: number): string | undefined {
  const question = questionOf(stage, id)?.question;
  if (question?.type !== 'score') return undefined;
  const step = Math.min(question.levels - 1, Math.max(0, Math.round(score)));
  return t(`${KEY}.answerWords.${stage}.levels.${questionKey(question)}.${step}`);
}
