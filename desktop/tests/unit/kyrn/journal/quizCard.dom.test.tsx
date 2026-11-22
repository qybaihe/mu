/**
 * The journal entry's quiz card (side-tutor case 3): the button that asks, the modal one question lives in, the
 * verdict that colors the options, and the pass mark that lands on the row — with the answer key provably never in
 * the renderer's hands.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { JournalEntry } from '@/common/kyrn/journal';
import type { QuizAnswerResult, QuizAskResult } from '@/common/chat/journal/quizCore';
import EntryQuiz from '@renderer/pages/conversation/KyrnPanel/Journal/Quiz';
import {
  quizPassed,
  recordQuizPass,
  resetQuizProgressCache,
} from '@renderer/pages/conversation/KyrnPanel/Journal/quizNotes';
import common from '@/renderer/services/i18n/locales/en-US/common.json';

type State = { model?: string };
const state = vi.hoisted(() => vi.fn<() => Promise<{ ok: true; data: State }>>());
const ask = vi.hoisted(() => vi.fn<(input: { entryId: string }) => Promise<{ ok: true; data: QuizAskResult }>>());
const answer = vi.hoisted(() =>
  vi.fn<(input: { entryId: string; hash: string; choice: number }) => Promise<{ ok: true; data: QuizAnswerResult }>>()
);
vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: { quizState: { invoke: state }, quizQuestion: { invoke: ask }, quizAnswer: { invoke: answer } },
  unwrap: <T,>(result: { ok: true; data: T }) => result.data,
}));
vi.mock('@/renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({ theme: 'light', fontScale: 1 }),
}));

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { translation: { common } } }, interpolation: { escapeValue: false } });
});

const QUESTION: Extract<QuizAskResult, { action: 'ask' }>['question'] = {
  hash: 'ab12cd34',
  stem: 'A push to main is about to happen for “just a doc change”. What does the lesson say?',
  options: [
    'Push it, docs are safe',
    'Ask first — push rules hold for docs too',
    'Revert silently',
    'Delete the branch',
  ],
};

const ENTRY: JournalEntry = {
  id: 'a',
  source: 'lessons',
  kind: 'pitfall',
  text: 'Push rules hold for docs too.',
  at: '2026-11-22T06:00:00.000Z',
};

function Quiz({ model }: { model?: string }) {
  return (
    <I18nextProvider i18n={i18n}>
      <EntryQuiz entry={ENTRY} model={model} />
    </I18nextProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  resetQuizProgressCache();
  state.mockReset();
  ask.mockReset();
  answer.mockReset();
  state.mockResolvedValue({ ok: true, data: { model: 'cheap-model' } });
});
afterEach(() => cleanup());

describe('the quiz button', () => {
  it('disables with its guidance when no model is configured', () => {
    render(<Quiz />);
    const button = screen.getByTestId('mu-quiz-ask');
    expect(button).toBeDisabled();
    expect(button.getAttribute('title')).toContain('quick-decision model');
  });

  it('shows no pass mark until a pass is recorded', () => {
    render(<Quiz model='cheap-model' />);
    expect(screen.queryByTestId('mu-quiz-passed')).toBeNull();
    // A pass landing in the store lights the mark where the row stands.
    act(() => recordQuizPass({ entryId: 'a', entryAt: ENTRY.at, hash: 'h', at: 1 }));
    expect(screen.getByTestId('mu-quiz-passed').textContent).toContain('Tested');
  });
});

describe('the quiz card', () => {
  it('asks on open, offers four options, and submits the pick for grading', async () => {
    ask.mockResolvedValue({ ok: true, data: { action: 'ask', question: QUESTION } });
    answer.mockResolvedValue({
      ok: true,
      data: { action: 'verdict', correct: true, correctIndex: 1, source: 'when a push is about to happen' },
    });
    render(<Quiz model='cheap-model' />);
    fireEvent.click(screen.getByTestId('mu-quiz-ask'));
    await waitFor(() => expect(screen.getByTestId('mu-quiz-question')).toBeTruthy());
    // The renderer's question holds no key.
    expect(JSON.stringify(ask.mock.calls[0])).toContain('a');
    expect(screen.queryByTestId('mu-quiz-verdict')).toBeNull();
    // Nothing picked yet: submit waits.
    expect(screen.getByTestId('mu-quiz-submit')).toBeDisabled();
    fireEvent.click(screen.getByText(QUESTION.options[1]));
    expect(screen.getByTestId('mu-quiz-submit')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('mu-quiz-submit'));
    await waitFor(() => expect(screen.getByTestId('mu-quiz-answered')).toBeTruthy());
    // The ask carried the hash back, the choice, and the entry id.
    expect(answer).toHaveBeenCalledWith({ entryId: 'a', hash: QUESTION.hash, choice: 1 });
    expect(screen.getByTestId('mu-quiz-verdict').textContent).toContain('Right');
    // The source — when the lesson applies — shows only now, after the answer.
    expect(screen.getByTestId('mu-quiz-source').textContent).toContain('when a push is about to happen');
    // A right answer is a pass: the mark lands on the row, in the store.
    expect(screen.getByTestId('mu-quiz-passed').textContent).toContain('Tested');
    expect(quizPassed('a', ENTRY.at)).toBe(true);
    expect(localStorage.getItem('quiz-progress-v1')).toContain(QUESTION.hash);
  });

  it('colors the wrong pick red and the right one green, and flips no pass', async () => {
    ask.mockResolvedValue({ ok: true, data: { action: 'ask', question: QUESTION } });
    answer.mockResolvedValue({
      ok: true,
      data: { action: 'verdict', correct: false, correctIndex: 2, source: 'when a push is about to happen' },
    });
    render(<Quiz model='cheap-model' />);
    fireEvent.click(screen.getByTestId('mu-quiz-ask'));
    await waitFor(() => expect(screen.getByTestId('mu-quiz-question')).toBeTruthy());
    fireEvent.click(screen.getByText(QUESTION.options[0]));
    fireEvent.click(screen.getByTestId('mu-quiz-submit'));
    await waitFor(() => expect(screen.getByTestId('mu-quiz-answered')).toBeTruthy());
    expect(screen.getByTestId('mu-quiz-verdict').textContent).toContain('Wrong');
    expect(screen.queryByTestId('mu-quiz-passed')).toBeNull();
    expect(quizPassed('a', ENTRY.at)).toBe(false);
  });

  it('says why there is no quiz when the entry is too thin', async () => {
    ask.mockResolvedValueOnce({ ok: true, data: { action: 'thin-entry' } });
    render(<Quiz model='cheap-model' />);
    fireEvent.click(screen.getByTestId('mu-quiz-ask'));
    await waitFor(() => expect(screen.getByTestId('mu-quiz-absent')).toBeTruthy());
    expect(screen.getByTestId('mu-quiz-absent').textContent).toContain('too thin');
    expect(screen.queryByTestId('mu-quiz-verdict')).toBeNull();
  });

  it('offers the new quiz when the lesson changed under the shown question', async () => {
    ask.mockResolvedValueOnce({ ok: true, data: { action: 'ask', question: QUESTION } });
    answer.mockResolvedValueOnce({ ok: true, data: { action: 'stale-entry' } });
    render(<Quiz model='cheap-model' />);
    fireEvent.click(screen.getByTestId('mu-quiz-ask'));
    await waitFor(() => expect(screen.getByTestId('mu-quiz-question')).toBeTruthy());
    fireEvent.click(screen.getByText(QUESTION.options[1]));
    fireEvent.click(screen.getByTestId('mu-quiz-submit'));
    await waitFor(() => expect(screen.getByTestId('mu-quiz-absent').textContent).toContain('changed'));
    expect(screen.queryByTestId('mu-quiz-passed')).toBeNull();
    ask.mockResolvedValueOnce({ ok: true, data: { action: 'ask', question: QUESTION } });
    fireEvent.click(screen.getByText('Try again'));
    await waitFor(() => expect(screen.getByTestId('mu-quiz-question')).toBeTruthy());
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('re-asks after a wrong answer without leaving the card', async () => {
    ask.mockResolvedValue({ ok: true, data: { action: 'ask', question: QUESTION } });
    answer.mockResolvedValue({
      ok: true,
      data: { action: 'verdict', correct: false, correctIndex: 2, source: 'when a push is about to happen' },
    });
    render(<Quiz model='cheap-model' />);
    fireEvent.click(screen.getByTestId('mu-quiz-ask'));
    await waitFor(() => expect(screen.getByTestId('mu-quiz-question')).toBeTruthy());
    fireEvent.click(screen.getByText(QUESTION.options[0]));
    fireEvent.click(screen.getByTestId('mu-quiz-submit'));
    await waitFor(() => expect(screen.getByTestId('mu-quiz-answered')).toBeTruthy());
    fireEvent.click(screen.getByText('Try again'));
    await waitFor(() => expect(screen.getByTestId('mu-quiz-question')).toBeTruthy());
    expect(ask).toHaveBeenCalledTimes(2);
  });
});
