/**
 * The quiz's main-process side (side-tutor case 3): one journal entry in, one
 * scenario question out, the answer key graded here and never sent across the
 * bridge. The question is made by the same cheap model the quick-decision
 * layer uses (`tools.quickDecisionModel`, resolved the same way) under its own
 * 10s ceiling, and kept in memory for the entry's content hash — the same
 * lesson is asked once, an edited lesson is a new quiz. Every doubt abandons:
 * no model configured, a thin entry, a model that declines, two answers that
 * do not parse. The entry itself is read from the same two files the journal
 * shows (mu's lessons and the positions' ledger); nothing is written anywhere.
 */
import { httpRequest } from '@/common/adapter/httpBridge';
import type { IProvider, TProviderWithModel } from '@/common/config/storage';
import {
  QUIZ_MIN_TEXT,
  QUIZ_TIMEOUT_MS,
  buildQuizPrompt,
  gradeQuiz,
  parseQuizDecision,
  quizHashOf,
  quizViewOf,
  type QuizAnswerResult,
  type QuizAskResult,
  type QuizQuestion,
  type QuizSource,
} from '@/common/chat/journal/quizCore';
import { parseLessonsLedger } from '@/common/kyrn/journal';
import {
  completeUnderCeiling,
  resolveQuickDecisionModel,
  type QuickDecisionModelSetting,
} from '@process/services/team/quickDecision/quickDecisionService';
import { readOptional } from './config/files';
import { readLessonsFile } from './lessons';

/** Everything injectable, so tests run no HTTP, no model and no clock. */
export type QuizDeps = {
  now: () => number;
  /** Reads `tools.quickDecisionModel`; undefined (or a throw) = the quiz is off. */
  readSetting: () => Promise<QuickDecisionModelSetting | undefined>;
  /** The live provider list, secrets included — the setting's id resolves against it. */
  listProviders: () => Promise<IProvider[]>;
  /** One completion: the prompt's messages in, the model's raw text out; must honor the timeout itself. */
  complete: (
    provider: TProviderWithModel,
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    timeoutMs: number
  ) => Promise<string>;
  log: (...args: unknown[]) => void;
};

/** The two files the journal shows; the quiz reads the same truth, never a copy. */
export type QuizFiles = { lessonsFile: string; ledgerFile: string };

/**
 * One entry by the journal's own id: a lesson's id, or `ledger:<index>` — the index of the line in the ledger file,
 * stable because the ledger only appends. Read fresh each time; a quiz is rare, the files move under it.
 */
const entryOf = (files: QuizFiles, entryId: string): QuizSource | undefined => {
  if (entryId.startsWith('ledger:')) {
    const index = Number(entryId.slice('ledger:'.length));
    if (!Number.isInteger(index) || index < 0) return undefined;
    const line = parseLessonsLedger(readOptional(files.ledgerFile))[index];
    return line ? { text: line.text } : undefined;
  }
  const lesson = readLessonsFile(files.lessonsFile).find((each) => each.id === entryId);
  return lesson ? { trigger: lesson.trigger, text: lesson.lesson } : undefined;
};

/**
 * The quiz of one entry: the model's question (the key held back), or why there is none. A thin entry is abandoned
 * without a call; a malformed answer is retried once; a timeout or a model error is not retried — ten seconds is
 * already the whole budget. Only questions that parsed are cached, under the entry's content hash.
 */
export async function quizAskIn(
  deps: QuizDeps,
  files: QuizFiles,
  cache: Map<string, QuizQuestion>,
  entryId: string
): Promise<QuizAskResult> {
  const entry = entryOf(files, entryId);
  if (entry === undefined) return { action: 'unknown-entry' };
  if (entry.text.trim().length < QUIZ_MIN_TEXT) return { action: 'thin-entry' };
  const model = await resolveQuickDecisionModel(deps);
  if (!model) return { action: 'no-model' };
  const hash = quizHashOf(entry);
  const cached = cache.get(hash);
  if (cached) return { action: 'ask', question: quizViewOf(hash, cached) };
  const prompt = buildQuizPrompt(entry);

  /** One ask under the ceiling; false = the call itself failed (timeout or model error). */
  const ask = async (): Promise<QuizQuestion | { skip: string } | false> => {
    try {
      return parseQuizDecision(
        await deps.complete(
          model,
          [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          QUIZ_TIMEOUT_MS
        )
      );
    } catch (error) {
      deps.log(`[quiz] ask failed entry=${entryId} after=${deps.now()}ms ${String(error).slice(0, 140)}`);
      return false;
    }
  };

  const startedAt = deps.now();
  let parsed = await ask();
  // A model that answered but not in shape gets exactly one more chance; a failed call gets none.
  if (parsed === undefined) parsed = await ask();
  if (parsed === undefined || parsed === false) return { action: 'no-question' };
  if ('skip' in parsed) {
    deps.log(
      `[quiz] model declined entry=${entryId} after=${deps.now() - startedAt}ms reason=${parsed.skip.slice(0, 120)}`
    );
    return { action: 'thin-entry' };
  }
  cache.set(hash, parsed);
  deps.log(`[quiz] asked entry=${entryId} hash=${hash} model=${model.use_model} after=${deps.now() - startedAt}ms`);
  return { action: 'ask', question: quizViewOf(hash, parsed) };
}

/**
 * One answer, graded where the key lives. The entry is read again: if its content hash has moved since the question
 * was shown (`stale-entry`), the old key is worthless — the renderer asks anew. A hash the service never issued
 * (a restart, a different entry) is `no-question`, the same answer the renderer re-asks for.
 */
export function quizAnswerIn(
  files: QuizFiles,
  cache: Map<string, QuizQuestion>,
  entryId: string,
  hash: string,
  choice: number
): QuizAnswerResult {
  const entry = entryOf(files, entryId);
  if (entry === undefined) return { action: 'unknown-entry' };
  // A hash this process never issued (a restart, a bogus ask) has no key to grade against.
  const question = cache.get(hash);
  if (question === undefined) return { action: 'no-question' };
  // The entry's content has moved since the question was shown: the old key grades nothing.
  if (quizHashOf(entry) !== hash) return { action: 'stale-entry' };
  if (!Number.isInteger(choice) || choice < 0 || choice >= question.options.length) return { action: 'no-question' };
  const correct = gradeQuiz(choice, question);
  return {
    action: 'verdict',
    correct,
    correctIndex: question.answerIndex,
    ...(entry.trigger ? { source: entry.trigger } : {}),
  };
}

/** The quiz, as one app run holds it: one shared cache, alive as long as the process is. */
export class QuizService {
  private cache = new Map<string, QuizQuestion>();

  constructor(
    private files: QuizFiles,
    private deps: QuizDeps
  ) {}

  /** The quiz of one entry, made or remembered. */
  ask(entryId: string): Promise<QuizAskResult> {
    return quizAskIn(this.deps, this.files, this.cache, entryId);
  }

  /** One answer, graded against the key this process holds. */
  answer(entryId: string, hash: string, choice: number): QuizAnswerResult {
    return quizAnswerIn(this.files, this.cache, entryId, hash, choice);
  }
}

/** The production wiring: the same backend settings and providers, and the same ceiling racer, the quick-decision layer uses. */
export const quizProdDeps = (): QuizDeps => ({
  now: Date.now,
  readSetting: async () => {
    const data = await httpRequest<Record<string, QuickDecisionModelSetting | undefined>>(
      'GET',
      `/api/settings/client?keys=${encodeURIComponent('tools.quickDecisionModel')}`
    );
    return data?.['tools.quickDecisionModel'];
  },
  listProviders: () => httpRequest<IProvider[]>('GET', '/api/providers'),
  complete: completeUnderCeiling,
  log: (...args) => console.log(...args),
});

/** The readiness the journal's buttons wait on: the model the quiz would use, by name, or none. */
export async function quizModelStateIn(deps: QuizDeps): Promise<{ model?: string }> {
  const model = await resolveQuickDecisionModel(deps);
  return model ? { model: model.use_model } : {};
}
