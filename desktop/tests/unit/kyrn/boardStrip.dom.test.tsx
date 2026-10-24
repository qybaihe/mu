import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { Activity } from '@/common/kyrn/types';
import type { NativeConversation } from '@/common/kyrn/nativeBridge';
import {
  readWorkPanelMemory,
  rememberWorkPanel,
  resetWorkPanelStoreForTest,
} from '@/renderer/components/layout/WorkPanel/workPanelStore';
import NativeBoardStrip from '@/renderer/pages/native/components/NativeBoardStrip';
import NativeHeader from '@/renderer/pages/native/components/NativeHeader';
import { publishNativeActivity } from '@/renderer/pages/native/utils/nativeActivityStore';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import enConversation from '@/renderer/services/i18n/locales/en-US/conversation.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import zhCommon from '@/renderer/services/i18n/locales/zh-CN/common.json';

/**
 * The board's headline in the conversation's header, while the work panel is closed: shown only when the board is on
 * and has a headline, one line long, and a click opens the panel on the board.
 */

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en',
    resources: {
      en: { translation: { common: enCommon, conversation: enConversation, mu: enMu } },
      'zh-CN': { translation: { common: zhCommon } },
    },
    interpolation: { escapeValue: false },
  });
});
beforeEach(() => {
  localStorage.clear();
  resetWorkPanelStoreForTest();
});
afterEach(() => {
  cleanup();
  publishNativeActivity(undefined);
});

let next = 0;
const event = (kind: string, payload: Record<string, unknown>): Activity => ({
  id: `e${++next}`,
  at: next,
  kind,
  payload,
});
const switched = (on: boolean) => event('board.switched', { on, cwd: '/work/app' });
const board = (payload: Record<string, unknown> = {}) =>
  event('board.update', {
    progress: 'Cause found; the fix is not verified yet.',
    now: 'scout is back: the retry delay reads the clock twice.',
    confirm: [],
    phase: 'blocked',
    needsUser: false,
    done: 1,
    total: 2,
    by: 'model',
    ended: false,
    headline: 'fixer has run one test for 6 min with no output',
    blocked: 'fixer: npx vitest has run 6 min with no output.',
    ...payload,
  });

/** What the native page publishes for conversation `c1`. */
const publish = (events: Activity[]) =>
  act(() => publishNativeActivity({ conversationId: 'c1', activity: { events, loading: false, settled: true } }));

const showStrip = () =>
  render(
    <I18nextProvider i18n={i18n}>
      <NativeBoardStrip conversationId='c1' />
    </I18nextProvider>
  );
const strip = () => screen.queryByTestId('mu-board-strip');

describe('the board’s headline strip', () => {
  it('shows the headline while the panel is closed, with what is blocked in its tooltip', () => {
    publish([switched(true), board()]);
    showStrip();
    expect(strip()).toBeVisible();
    expect(screen.getByTestId('mu-board-strip-text')).toHaveTextContent(
      'fixer has run one test for 6 min with no output'
    );
    // One line that ends in an ellipsis, never two.
    expect(screen.getByTestId('mu-board-strip-text')).toHaveClass('truncate');
    expect(strip()).toHaveAttribute('data-mark', 'blocked');
    expect(strip()).toHaveAttribute(
      'aria-label',
      'Plain-language board: fixer has run one test for 6 min with no output'
    );
    expect(strip()?.getAttribute('title')).toContain('Blocked: fixer: npx vitest has run 6 min with no output.');
  });

  it('opens the work panel on the board tab, and goes away while the panel is open', () => {
    rememberWorkPanel('c1', { open: false, tab: 'files' });
    publish([switched(true), board()]);
    showStrip();
    fireEvent.click(strip() as HTMLElement);
    expect(readWorkPanelMemory('c1')).toMatchObject({ open: true, tab: 'board' });
    expect(strip()).toBeNull();
    act(() => rememberWorkPanel('c1', { open: false }));
    expect(strip()).toBeVisible();
  });

  it('follows the board: a newer headline replaces it, and it goes when the board turns off', () => {
    const events = [switched(true), board()];
    publish(events);
    showStrip();
    const later = board({ headline: 'scout and docs are back; fixer still running', blocked: '' });
    publish([...events, later]);
    expect(screen.getByTestId('mu-board-strip-text')).toHaveTextContent('scout and docs are back');
    expect(strip()).toHaveAttribute('data-mark', 'dot');
    publish([...events, later, switched(false)]);
    expect(strip()).toBeNull();
  });

  it('is not there for a board without a headline, a conversation without a board, or another conversation', () => {
    publish([switched(true), board({ headline: undefined })]);
    showStrip();
    expect(strip()).toBeNull();
    publish([]);
    expect(strip()).toBeNull();
    act(() =>
      publishNativeActivity({
        conversationId: 'c2',
        activity: { events: [switched(true), board()], loading: false, settled: true },
      })
    );
    expect(strip()).toBeNull();
  });

  it('marks a board that waits for the person, and words a rules headline in the app’s language', async () => {
    publish([
      switched(true),
      board({
        blocked: '',
        needsUser: true,
        headline: 'Waiting for you to allow: npm publish',
        headlineCode: 'waiting_permission',
        headlineParams: { what: 'npm publish' },
      }),
    ]);
    await act(() => i18n.changeLanguage('zh-CN'));
    try {
      showStrip();
      expect(strip()).toHaveAttribute('data-mark', 'asks');
      expect(screen.getByTestId('mu-board-strip-text')).toHaveTextContent('在等你允许：npm publish');
    } finally {
      await act(() => i18n.changeLanguage('en'));
    }
  });

  it('calls a stuck helper by its label in a rules headline', () => {
    const rewrite = 'rewrite retry.test.ts with fake timers';
    publish([
      switched(true),
      board({
        headline: `${rewrite}: npx vitest has run 6 min with no output`,
        headlineCode: 'still_running',
        headlineParams: { who: rewrite, what: 'npx vitest', minutes: 6 },
        agents: [{ who: rewrite, label: 'test rewrite', state: 'stuck', doing: 'no output' }],
      }),
    ]);
    showStrip();
    expect(screen.getByTestId('mu-board-strip-text')).toHaveTextContent(
      'test rewrite: npx vitest has run 6 min with no output'
    );
  });

  it('sits in the conversation’s header, between the title and mu’s state', () => {
    publish([switched(true), board()]);
    const conversation: NativeConversation = {
      id: 'c1',
      cwd: '/work/app',
      title: 'Fix the flaky retry test',
      createdAt: 1,
      updatedAt: 1,
      live: true,
    };
    render(
      <I18nextProvider i18n={i18n}>
        <NativeHeader conversation={conversation} host={{ phase: 'running' }} working conversationId='c1' />
      </I18nextProvider>
    );
    const header = screen.getByTestId('native-header');
    const shown = screen.getByTestId('mu-board-strip');
    expect(header).toContainElement(shown);
    expect(screen.getByTestId('native-header-folder').compareDocumentPosition(shown)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(shown.compareDocumentPosition(screen.getByTestId('native-header-phase'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });
});
