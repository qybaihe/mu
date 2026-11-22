/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The journal quiz's pure half (side-tutor case 3): a 10-second check that the
 * person, not the AI, learned the lesson. One journal entry goes in, one
 * scenario question comes out — a NEW situation the lesson decides, with
 * distractors the model must ground in how the mistake actually gets made —
 * and the answer key never leaves the main process: the renderer sees the
 * question only, sends back one choice, and the main process grades it by
 * integer comparison. Everything that can doubt (a thin entry, a model that
 * cannot commit, a parse that does not hold) abandons the quiz — 宁弃勿滥: no
 * quiz is better than a bad one. Nothing here touches the lessons file: the
 * kernel's statuses stay the kernel's.
 */
import { extractDecisionJson } from '../team/quickDecision/quickDecisionCore';

/** The ceiling of one quiz ask. The quick-decision layer's 2s serves sends; a quiz is off the send path, so it gets air. The quiz asks with thinking off (see `completeUnderCeiling`), which lands in seconds — but the channel was measured taking 22-34s while it thought, so the cap is that measured ceiling plus margin, and it is ONE ask's whole budget (a retry gets its own). */
export const QUIZ_TIMEOUT_MS = 45_000;
/** Exactly this many options, one of them right. */
export const QUIZ_OPTION_COUNT = 4;
/**
 * The least a lesson must say to be worth asking about — under it the entry is abandoned without a model call. Real
 * lessons run a dozen characters and up; a line shorter than this has nothing to attach a situation to.
 */
export const QUIZ_MIN_TEXT = 6;
/** The most the model's stem and each option may run: a quiz is read in ten seconds, not studied. */
export const QUIZ_MAX_STEM = 500;
export const QUIZ_MAX_OPTION = 200;

/** One entry as the quiz asks about it: what was learned, and (mu's lessons) when it applies. */
export type QuizSource = { trigger?: string; text: string };

/** The question with its key: the main process's own shape, never sent whole. */
export type QuizQuestion = { stem: string; options: string[]; answerIndex: number };

/** The question as the renderer may see it — same fields, no `answerIndex` anywhere. */
export type QuizQuestionView = { hash: string; stem: string; options: string[] };

/** Why there is no quiz for an entry. `no-model` = the setting is off; the rest = this entry, asked and abandoned. */
export type QuizAbsence = 'no-model' | 'thin-entry' | 'unknown-entry' | 'no-question';

/** The quiz of one entry: the question, or why there is none. */
export type QuizAskResult = { action: 'ask'; question: QuizQuestionView } | { action: QuizAbsence };

/** One answered quiz: the verdict, or why it could not be graded. `stale-entry` = the entry changed since the question was shown. */
export type QuizAnswerResult =
  | { action: 'verdict'; correct: boolean; correctIndex: number; source?: string }
  | { action: 'unknown-entry' | 'stale-entry' | 'no-question' };

const SYSTEM_PROMPT = [
  'You write one multiple-choice quiz item that checks whether a person has internalized a learned lesson.',
  'The stem is a NEW, concrete situation (never a restatement of the lesson) in which the lesson decides what to do.',
  `Exactly ${QUIZ_OPTION_COUNT} options, exactly one is what the lesson says to do; the other ${QUIZ_OPTION_COUNT - 1} are wrong but plausible — the ways a competent but careless person actually gets this wrong, grounded in the lesson, never absurd or obviously silly.`,
  'Options are short; the stem names the situation, not the answer.',
  'Write in the same language as the lesson.',
  `Answer with strict JSON only: {"stem": string, "options": [${Array(QUIZ_OPTION_COUNT).fill('string').join(', ')}], "answer": number} where answer is the 0-based index of the one right option.`,
  'If the lesson is too thin, purely factual with nothing to apply in a situation, or too ambiguous to test, answer {"skip": "<one short reason>"} instead — a skipped quiz is better than a bad one.',
].join(' ');

/** The ask for one entry: the system rules once, the entry as the user turn. */
export function buildQuizPrompt(source: QuizSource): { system: string; user: string } {
  const user = JSON.stringify({ trigger: source.trigger ?? '', lesson: source.text });
  return { system: SYSTEM_PROMPT, user };
}

/**
 * The model's raw output as one question, one deliberate skip, or undefined — anything that does not hold exactly
 * (missing stem, wrong option count, a blank or doubled option, an answer off the list) is no question at all.
 */
export function parseQuizDecision(raw: string): QuizQuestion | { skip: string } | undefined {
  const parsed = extractDecisionJson(raw);
  if (parsed === undefined) return undefined;
  if (typeof parsed.skip === 'string' && parsed.skip.trim()) return { skip: parsed.skip.trim() };
  const stem = typeof parsed.stem === 'string' ? parsed.stem.trim() : '';
  if (!stem || stem.length > QUIZ_MAX_STEM) return undefined;
  if (!Array.isArray(parsed.options) || parsed.options.length !== QUIZ_OPTION_COUNT) return undefined;
  const options: string[] = [];
  for (const option of parsed.options) {
    if (typeof option !== 'string') return undefined;
    const text = option.trim();
    if (!text || text.length > QUIZ_MAX_OPTION) return undefined;
    options.push(text);
  }
  // Two options that read the same make the key ambiguous: abandon, never guess which the model meant.
  if (new Set(options).size !== QUIZ_OPTION_COUNT) return undefined;
  const answer = parsed.answer;
  if (!Number.isInteger(answer) || (answer as number) < 0 || (answer as number) >= QUIZ_OPTION_COUNT) return undefined;
  return { stem, options, answerIndex: answer as number };
}

/** The grade: one integer comparison, done where the key lives. */
export function gradeQuiz(choice: number, question: QuizQuestion): boolean {
  return Number.isInteger(choice) && choice >= 0 && choice < question.options.length && choice === question.answerIndex;
}

/** 32-bit FNV-1a: a short, stable hex for content that has already been normalized. */
const fnv1a = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

/**
 * The quiz's identity: what it was made of. The same lesson (any way its whitespace, case or width is written) is
 * one quiz; an edited lesson is another, so a question cached under one hash is never graded against another.
 */
export function quizHashOf(source: QuizSource): string {
  const normalized = `${source.trigger ?? ''}\u0000${source.text}`
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return fnv1a(normalized);
}

/** The view of one question: the hash that ties it to its entry, nothing of the key. */
export const quizViewOf = (hash: string, question: QuizQuestion): QuizQuestionView => ({
  hash,
  stem: question.stem,
  options: [...question.options],
});
