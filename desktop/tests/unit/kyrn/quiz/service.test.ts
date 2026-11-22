/**
 * The quiz's main-process side (side-tutor case 3): the ask of one entry (no model, thin entry, the cached question,
 * the one retry, the deliberate skip), the grade against a key the bridge never carries, and the stale hash an edited
 * lesson makes of an old question.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QUIZ_TIMEOUT_MS } from '@/common/chat/journal/quizCore';
import type { IProvider, TProviderWithModel } from '@/common/config/storage';
import { QuizService, quizAnswerIn, quizAskIn, type QuizDeps } from '@process/agent/kyrn/quiz';

const dirs: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mu-quiz-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One lesson line of the file, the way the harness writes it. */
const lessonLine = (id: string, trigger: string, lesson: string, updated: string): string =>
  `${JSON.stringify({ id, kind: 'pitfall', trigger, lesson, cwd: 'E:/Projects/mu', updated })}\n`;

/** A deps whose model always answers `raw`, counts its calls, and records the ceiling it was asked under. */
const depsOf = (raw: string | Error): { deps: QuizDeps; calls: Array<{ messages: unknown[]; timeoutMs: number }> } => {
  const calls: Array<{ messages: unknown[]; timeoutMs: number }> = [];
  const provider = { id: 'p', name: 'p', use_model: 'cheap' } as unknown as TProviderWithModel;
  const deps: QuizDeps = {
    now: Date.now,
    readSetting: async () => ({ id: 'p', use_model: 'cheap' }) as unknown as TProviderWithModel,
    listProviders: async () => [provider] as unknown as IProvider[],
    complete: async (_model, messages, timeoutMs) => {
      calls.push({ messages, timeoutMs });
      if (raw instanceof Error) throw raw;
      return raw;
    },
    log: () => {},
  };
  return { deps, calls };
};

const filesOf = (lessonsText: string, ledgerText = ''): { lessonsFile: string; ledgerFile: string } => {
  const dir = temp();
  const lessonsFile = join(dir, 'lessons.jsonl');
  const ledgerFile = join(dir, 'LESSONS.md');
  mkdirSync(join(dir, 'positions', '_shared'), { recursive: true });
  writeFileSync(lessonsFile, lessonsText);
  writeFileSync(ledgerFile, ledgerText);
  return { lessonsFile, ledgerFile };
};

const QUESTION = JSON.stringify({
  stem: 'A push to main is about to happen for “just a doc change”. What does the lesson say?',
  options: [
    'Push it — docs are safe',
    'Push rules hold for docs too: ask first',
    'Revert silently',
    'Delete the branch',
  ],
  answer: 1,
});

const answered = (raw: string) => JSON.parse(raw);

describe('the ask of one entry', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('answers no-model before any call, when the setting is off', async () => {
    const files = filesOf(lessonLine('a', 'when pushing', 'Push rules hold for docs too.', '2026-11-22T06:00:00.000Z'));
    const { deps, calls } = depsOf(QUESTION);
    const off: QuizDeps = { ...deps, readSetting: async () => undefined };
    expect(await quizAskIn(off, files, new Map(), 'a')).toEqual({ action: 'no-model' });
    expect(calls).toHaveLength(0);
  });

  it('abandons a thin entry and an unknown one without a model call', async () => {
    const files = filesOf(lessonLine('a', 't', 'tiny', '2026-11-22T06:00:00.000Z'));
    const { deps, calls } = depsOf(QUESTION);
    expect(await quizAskIn(deps, files, new Map(), 'a')).toEqual({ action: 'thin-entry' });
    expect(await quizAskIn(deps, files, new Map(), 'nope')).toEqual({ action: 'unknown-entry' });
    expect(await quizAskIn(deps, files, new Map(), 'ledger:0')).toEqual({ action: 'unknown-entry' });
    expect(calls).toHaveLength(0);
  });

  it('asks the model under its own ceiling and answers the question without the key', async () => {
    const files = filesOf(lessonLine('a', 'when pushing', 'Push rules hold for docs too.', '2026-11-22T06:00:00.000Z'));
    const { deps, calls } = depsOf(QUESTION);
    const result = await quizAskIn(deps, files, new Map(), 'a');
    expect(result).toEqual({
      action: 'ask',
      question: { hash: expect.any(String), stem: answered(QUESTION).stem, options: answered(QUESTION).options },
    });
    // The bridge's object holds no key anywhere.
    expect(JSON.stringify(result)).not.toContain('answerIndex');
    expect(JSON.stringify(result)).not.toContain('"answer"');
    // The ceiling is the quiz's own, and the entry rode the user turn.
    expect(calls[0].timeoutMs).toBe(QUIZ_TIMEOUT_MS);
    expect(calls[0].messages).toEqual([
      { role: 'system', content: expect.stringContaining('NEW, concrete situation') },
      { role: 'user', content: expect.stringContaining('Push rules hold for docs too.') },
    ]);
  });

  it('remembers a question: the same entry asks the model once, whatever its id was written', async () => {
    const files = filesOf(lessonLine('a', 'when pushing', 'Push rules hold for docs too.', '2026-11-22T06:00:00.000Z'));
    const { deps, calls } = depsOf(QUESTION);
    const cache = new Map();
    const first = await quizAskIn(deps, files, cache, 'a');
    const second = await quizAskIn(deps, files, cache, 'a');
    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('retries a malformed answer exactly once, and gives up after two', async () => {
    const files = filesOf(lessonLine('a', 'when pushing', 'Push rules hold for docs too.', '2026-11-22T06:00:00.000Z'));
    const { deps, calls } = depsOf('I cannot do JSON');
    expect(await quizAskIn(deps, files, new Map(), 'a')).toEqual({ action: 'no-question' });
    expect(calls).toHaveLength(2);

    // First call malformed, second good: the retry carries the day.
    const raws = ['nope', QUESTION];
    const retried: QuizDeps = {
      ...deps,
      complete: async (_m, _x, _t) => raws.shift() ?? QUESTION,
    };
    const result = await quizAskIn(retried, files, new Map(), 'a');
    expect(result.action).toBe('ask');
  });

  it('does not retry a failed call — ten seconds is already the whole budget', async () => {
    const files = filesOf(lessonLine('a', 'when pushing', 'Push rules hold for docs too.', '2026-11-22T06:00:00.000Z'));
    const { deps, calls } = depsOf(new Error('quick-decision-timeout'));
    expect(await quizAskIn(deps, files, new Map(), 'a')).toEqual({ action: 'no-question' });
    expect(calls).toHaveLength(1);
  });

  it('takes a deliberate skip as a thin entry, without a retry', async () => {
    const files = filesOf(lessonLine('a', 'when pushing', 'Push rules hold for docs too.', '2026-11-22T06:00:00.000Z'));
    const { deps, calls } = depsOf('{"skip": "too ambiguous"}');
    expect(await quizAskIn(deps, files, new Map(), 'a')).toEqual({ action: 'thin-entry' });
    expect(calls).toHaveLength(1);
  });

  it('reads a ledger line by its index, with no trigger to offer', async () => {
    const files = filesOf('', '2026-11-22 | mu-dev | Read HANDOFF before any new feature work\n');
    const { deps, calls } = depsOf(QUESTION);
    const result = await quizAskIn(deps, files, new Map(), 'ledger:0');
    expect(result.action).toBe('ask');
    expect(JSON.parse((calls[0].messages[1] as { content: string }).content)).toEqual({
      trigger: '',
      lesson: 'Read HANDOFF before any new feature work',
    });
  });
});

describe('the answer, graded where the key lives', () => {
  it('compares one integer and reveals the key with the verdict only', async () => {
    const files = filesOf(lessonLine('a', 'when pushing', 'Push rules hold for docs too.', '2026-11-22T06:00:00.000Z'));
    const { deps } = depsOf(QUESTION);
    const cache = new Map();
    const ask = await quizAskIn(deps, files, cache, 'a');
    if (ask.action !== 'ask') throw new Error('ask failed');
    expect(quizAnswerIn(files, cache, 'a', ask.question.hash, 1)).toEqual({
      action: 'verdict',
      correct: true,
      correctIndex: 1,
      source: 'when pushing',
    });
    expect(quizAnswerIn(files, cache, 'a', ask.question.hash, 0)).toEqual({
      action: 'verdict',
      correct: false,
      correctIndex: 1,
      source: 'when pushing',
    });
  });

  it('refuses a choice that is not one of the options', async () => {
    const files = filesOf(lessonLine('a', 'when pushing', 'Push rules hold for docs too.', '2026-11-22T06:00:00.000Z'));
    const { deps } = depsOf(QUESTION);
    const cache = new Map();
    const ask = await quizAskIn(deps, files, cache, 'a');
    if (ask.action !== 'ask') throw new Error('ask failed');
    expect(quizAnswerIn(files, cache, 'a', ask.question.hash, 9)).toEqual({ action: 'no-question' });
    expect(quizAnswerIn(files, cache, 'a', ask.question.hash, -1)).toEqual({ action: 'no-question' });
  });

  it('refuses a hash it never issued: a restart or another entry', async () => {
    const files = filesOf(lessonLine('a', 'when pushing', 'Push rules hold for docs too.', '2026-11-22T06:00:00.000Z'));
    const { deps } = depsOf(QUESTION);
    const cache = new Map();
    await quizAskIn(deps, files, cache, 'a');
    expect(quizAnswerIn(files, cache, 'a', '00000000', 1)).toEqual({ action: 'no-question' });
    expect(quizAnswerIn(files, new Map(), 'a', 'whatever', 1)).toEqual({ action: 'no-question' });
  });

  it('calls an old question stale when the lesson has been edited since', async () => {
    const dir = temp();
    const lessonsFile = join(dir, 'lessons.jsonl');
    const ledgerFile = join(dir, 'LESSONS.md');
    writeFileSync(
      lessonsFile,
      lessonLine('a', 'when pushing', 'Push rules hold for docs too.', '2026-11-22T06:00:00.000Z')
    );
    writeFileSync(ledgerFile, '');
    const files = { lessonsFile, ledgerFile };
    const { deps } = depsOf(QUESTION);
    const cache = new Map();
    const ask = await quizAskIn(deps, files, cache, 'a');
    if (ask.action !== 'ask') throw new Error('ask failed');
    // An edit appends a line; the fold takes the newer lesson, the hash moves.
    writeFileSync(
      lessonsFile,
      `${lessonLine('a', 'when pushing', 'Push rules hold for docs too.', '2026-11-22T06:00:00.000Z')}${lessonLine(
        'a',
        'when pushing',
        'Docs are exempt from push rules.',
        '2026-11-22T09:00:00.000Z'
      )}`
    );
    expect(quizAnswerIn(files, cache, 'a', ask.question.hash, 1)).toEqual({ action: 'stale-entry' });
  });

  it('never writes anywhere: the two files stand byte for byte after ask and answer', async () => {
    const files = filesOf(
      lessonLine('a', 'when pushing', 'Push rules hold for docs too.', '2026-11-22T06:00:00.000Z'),
      '2026-11-22 | mu-dev | Read HANDOFF before any new feature work\n'
    );
    const before = `${readFileSync(files.lessonsFile, 'utf8')}|${readFileSync(files.ledgerFile, 'utf8')}`;
    const { deps } = depsOf(QUESTION);
    const cache = new Map();
    const ask = await quizAskIn(deps, files, cache, 'a');
    if (ask.action === 'ask') quizAnswerIn(files, cache, 'a', ask.question.hash, 1);
    expect(`${readFileSync(files.lessonsFile, 'utf8')}|${readFileSync(files.ledgerFile, 'utf8')}`).toBe(before);
  });
});

describe('the service wrapper', () => {
  it('shares one cache across its calls', async () => {
    const files = filesOf(lessonLine('a', 'when pushing', 'Push rules hold for docs too.', '2026-11-22T06:00:00.000Z'));
    const { deps, calls } = depsOf(QUESTION);
    const quiz = new QuizService(files, deps);
    const first = await quiz.ask('a');
    const second = await quiz.ask('a');
    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
    const ask = first.action === 'ask' ? first : undefined;
    if (!ask) throw new Error('ask failed');
    expect(quiz.answer('a', ask.question.hash, 1).action).toBe('verdict');
  });
});
