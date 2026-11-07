import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance, type i18n as I18n } from 'i18next';
import React from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import GoalLine from '@/renderer/pages/conversation/platforms/acp/Composer/GoalLine';
import type { GoalSnapshot } from '@/renderer/pages/conversation/platforms/acp/Composer/goalState';
import en from '@/renderer/services/i18n/locales/en-US/conversation.json';
import zh from '@/renderer/services/i18n/locales/zh-CN/conversation.json';
import type { SendBoxCommandState } from '@/renderer/utils/emitter';

const instance = async (lng: string, conversation: unknown): Promise<I18n> => {
  const i18n = createInstance();
  await i18n.init({
    lng,
    resources: { [lng]: { translation: { conversation } } },
    interpolation: { escapeValue: false },
  });
  return i18n;
};

let chinese: I18n;
let english: I18n;
beforeAll(async () => {
  chinese = await instance('zh-CN', zh);
  english = await instance('en-US', en);
});
afterEach(cleanup);

const show = (i18n: I18n, goal: GoalSnapshot, onEnd = vi.fn()) => {
  render(
    <I18nextProvider i18n={i18n}>
      <GoalLine goal={goal} onEnd={onEnd} />
    </I18nextProvider>
  );
  return onEnd;
};

const end = () => screen.getByTestId('composer-goal-end') as HTMLButtonElement;

describe('the goal line above the send box', () => {
  it('says a goal is running, with its condition, and offers a plain way to end it', () => {
    show(chinese, { status: 'active', text: 'packages/x 的测试全部通过' });
    expect(screen.getByTestId('composer-goal-text').textContent).toBe('目标进行中：packages/x 的测试全部通过');
    expect(end().textContent).toBe('结束');
    expect(end().getAttribute('aria-label')).toBe('结束目标');
  });

  it('says a paused goal is paused: the next message picks it up, so it is still there to end', () => {
    show(chinese, { status: 'paused', text: 'the build is green' });
    expect(screen.getByTestId('composer-goal-text').textContent).toBe('目标已暂停：the build is green');
    expect(screen.getByTestId('composer-goal-line').getAttribute('data-status')).toBe('paused');
  });

  it('speaks the app language', () => {
    show(english, { status: 'active', text: 'every test passes' });
    expect(screen.getByTestId('composer-goal-text').textContent).toBe('Goal in progress: every test passes');
    expect(end().textContent).toBe('End');
  });

  it('ends the goal once: the link waits after a press, and comes back when the command was dropped', () => {
    let heard: ((state: SendBoxCommandState) => void) | undefined;
    const onEnd = show(
      chinese,
      { status: 'active', text: 'every test passes' },
      vi.fn((listener) => (heard = listener))
    );

    fireEvent.click(end());
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(end().disabled).toBe(true);

    act(() => heard?.('waiting'));
    expect(end().disabled).toBe(true);
    act(() => heard?.('dropped'));
    expect(end().disabled).toBe(false);
  });

  it('keeps waiting while the stopped run pauses the goal, and comes back if the goal is still there a minute later', () => {
    vi.useFakeTimers();
    try {
      const running: GoalSnapshot = { status: 'active', text: 'every test passes' };
      const line = (goal: GoalSnapshot) => (
        <I18nextProvider i18n={chinese}>
          <GoalLine goal={goal} onEnd={vi.fn()} />
        </I18nextProvider>
      );
      const { rerender } = render(line(running));
      fireEvent.click(end());
      rerender(line({ ...running, status: 'paused' }));
      expect(end().disabled).toBe(true);

      act(() => vi.advanceTimersByTime(60_000));
      expect(end().disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
