import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeView } from '@/common/utils/nativeHost';
import { reduceAll } from '@/common/utils/nativeHost';
import NativeConversationPage from '@/renderer/pages/native';
import { NativeClientContext, type NativeClient } from '@/renderer/pages/native/utils/nativeClient';
import { ROW_WINDOW } from '@/renderer/pages/native/utils/rowWindow';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import enConversation from '@/renderer/services/i18n/locales/en-US/conversation.json';
import enMessages from '@/renderer/services/i18n/locales/en-US/messages.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import { createFakeHost } from './fakeClient';
import { ended, reply, text, user } from './records';

/**
 * A long conversation on the native page: it opens with its latest rows and not its whole history (a session of 6,752
 * entries drew every message and took 24 seconds), the rows before come when the reader scrolls to the top, one step
 * at a time, and rows that arrive at the end leave the window where it is. The message list runs for real; its text
 * rows are stood in for, and the height it keeps the reader's place by is the real app's to show (tests/e2e).
 */

type BoxProps = { value?: string; onChange?: (value: string) => void; testIds?: { input?: string } };

vi.mock('@/renderer/components/chat/SendBox', () => ({
  default: ({ value = '', onChange, testIds }: BoxProps) => (
    <textarea
      data-testid={testIds?.input ?? 'sendbox-input'}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageText', () => ({
  default: ({ message }: { message: { position: string; content: { content: string } } }) => (
    <div data-testid={`row-text-${message.position}`}>{message.content.content}</div>
  ),
}));

const watchers = new Set<() => void>();
class WatchedContent {
  constructor(callback: () => void) {
    this.callback = callback;
  }

  callback: () => void;

  observe() {
    watchers.add(this.callback);
  }

  unobserve() {}

  disconnect() {
    watchers.delete(this.callback);
  }
}
vi.stubGlobal('ResizeObserver', WatchedContent);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const i18n = createInstance();
void i18n.init({
  lng: 'en',
  resources: {
    en: { translation: { common: enCommon, conversation: enConversation, messages: enMessages, mu: enMu } },
  },
  interpolation: { escapeValue: false },
});

function page(client: NativeClient, id = 'c1') {
  return render(
    <I18nextProvider i18n={i18n}>
      <NativeClientContext.Provider value={client}>
        <MemoryRouter initialEntries={[`/conversation/native/${id}`]}>
          <Routes>
            <Route path='/conversation/native/:id' element={<NativeConversationPage />} />
          </Routes>
        </MemoryRouter>
      </NativeClientContext.Provider>
    </I18nextProvider>
  );
}

/** `count` turns of a question and its answer, numbered from `from`: two rows each. */
const turnRecords = (count: number, from = 0) =>
  Array.from({ length: count }, (_, index) => [
    ended(user(`question ${from + index}`, from + index + 1)),
    ended(reply([text(`answer ${from + index}`)], { timestamp: from + index + 1 })),
  ]).flat();

const viewOfTurns = (count: number, from = 0): NativeView => reduceAll(turnRecords(count, from));

const shown = () => screen.queryAllByTestId(/^row-text-/).map((row) => row.textContent);
const scroller = () => screen.getByTestId('message-list-scroller');

/** The reader reaches the top of the list: one scroll event with the list scrolled to its start. */
const reachTop = () => {
  const list = scroller();
  Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 0 });
  fireEvent.scroll(list);
};

const opened = async () => {
  await waitFor(() => expect(screen.getByTestId('native-header')).toBeInTheDocument());
  await act(async () => {});
};

describe('a long conversation on the native page', () => {
  it('opens with its latest rows, from the message that opens a turn', async () => {
    const host = createFakeHost();
    // 200 turns are 400 rows; the latest 120 start at row 280, the person's message of turn 140.
    host.add({ id: 'c1' }, viewOfTurns(200));
    page(host.client);
    await opened();

    const rows = shown();
    expect(rows).toHaveLength(ROW_WINDOW);
    expect(rows[0]).toBe('question 140');
    expect(rows.at(-1)).toBe('answer 199');
  });

  it('shows every row of a conversation no longer than the window', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' }, viewOfTurns(10));
    page(host.client);
    await opened();

    expect(shown()).toHaveLength(20);
    reachTop();
    await act(async () => {});
    expect(shown()).toHaveLength(20);
  });

  it('shows the rows before when the reader reaches the top, a step at a time, until the first row', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' }, viewOfTurns(200));
    page(host.client);
    await opened();
    expect(shown()).toHaveLength(120);

    for (const [count, first] of [
      [240, 'question 80'],
      [360, 'question 20'],
      [400, 'question 0'],
    ] as const) {
      reachTop();
      // oxlint-disable-next-line no-await-in-loop -- each step shows the rows before the ones the last step showed
      await waitFor(() => expect(shown()).toHaveLength(count));
      expect(shown()[0]).toBe(first);
      expect(shown().at(-1)).toBe('answer 199');
    }

    // Nothing is left before the first row.
    reachTop();
    await act(async () => {});
    expect(shown()).toHaveLength(400);
  });

  it('asks for the rows before on a wheel up when the reader is already at the top, where the list sends no scroll event', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' }, viewOfTurns(200));
    page(host.client);
    await opened();
    expect(shown()).toHaveLength(120);
    const list = scroller();
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 0 });

    // Down is not up: nothing is asked for.
    fireEvent.wheel(list, { deltaY: 100 });
    await act(async () => {});
    expect(shown()).toHaveLength(120);

    // Up, at the top of the list: one step more, as a scroll to the top would have shown.
    fireEvent.wheel(list, { deltaY: -100 });
    await waitFor(() => expect(shown()).toHaveLength(240));
    expect(shown()[0]).toBe('question 80');

    // Not at the top (the reader is reading further down): the wheel is theirs, and nothing is asked for.
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 3000 });
    fireEvent.wheel(list, { deltaY: -100 });
    await act(async () => {});
    expect(shown()).toHaveLength(240);
  });

  it('shows one step for scroll events that come before it is drawn', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' }, viewOfTurns(200));
    page(host.client);
    await opened();

    act(() => {
      reachTop();
      reachTop();
      reachTop();
    });
    await waitFor(() => expect(shown()).toHaveLength(240));
    await act(async () => {});
    expect(shown()).toHaveLength(240);
  });

  it('keeps the reader’s place while the rows drawn above grow, until the reader scrolls', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' }, viewOfTurns(200));
    page(host.client);
    await opened();
    const list = scroller();
    const content = screen.getByTestId('message-list-content');
    const rows = () => [...content.querySelectorAll('[id^="message-"]')];
    // jsdom has no layout: the rows are stacked, each `height` high, from the top of a list scrolled to `top`.
    let top = 0;
    let height = 100;
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value;
      },
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const index = rows().indexOf(this);
      const y = index >= 0 ? index * height - top : 0;
      return {
        x: 0,
        y,
        top: y,
        bottom: y + height,
        left: 0,
        right: 0,
        width: 0,
        height,
        toJSON: () => ({}),
      } as DOMRect;
    });
    // The list watches its content for a change of size: the test says when it changed.
    const sizeChanged = () => act(() => watchers.forEach((watcher) => watcher()));
    const before = rows().length;

    fireEvent.scroll(list);
    await waitFor(() => expect(rows().length).toBe(before + ROW_WINDOW));
    // The row that was first is where it was: the rows drawn above it are 120 high, and the list was scrolled by that.
    expect(top).toBe(ROW_WINDOW * 100);

    // Their content is drawn in a second pass and makes them higher: the list is scrolled by that too.
    height = 150;
    sizeChanged();
    expect(top).toBe(ROW_WINDOW * 150);

    // A reply that arrives below the reader does not move them.
    act(() => {
      host.play('c1', [{ type: 'agent_start' }, ...turnRecords(1, 200), { type: 'agent_settled' }]);
    });
    await waitFor(() => expect(shown().at(-1)).toBe('answer 200'));
    expect(top).toBe(ROW_WINDOW * 150);

    // Once the reader scrolls, the rows are theirs: a change of size no longer moves the list.
    fireEvent.wheel(list, { deltaY: -100 });
    height = 200;
    sizeChanged();
    expect(top).toBe(ROW_WINDOW * 150);
  });

  it('leaves the window where it is when rows arrive at the end', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' }, viewOfTurns(200));
    page(host.client);
    await opened();
    expect(shown()[0]).toBe('question 140');

    act(() => {
      host.play('c1', [{ type: 'agent_start' }, ...turnRecords(3, 200), { type: 'agent_settled' }]);
    });
    await waitFor(() => expect(shown().at(-1)).toBe('answer 202'));

    // Six rows came; none left from the top, where the reader may be.
    expect(shown()).toHaveLength(ROW_WINDOW + 6);
    expect(shown()[0]).toBe('question 140');
  });

  it('shows the latest rows of another session when the view is replaced', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' }, viewOfTurns(200));
    page(host.client);
    await opened();
    reachTop();
    await waitFor(() => expect(shown()).toHaveLength(240));

    act(() => host.replace('c1', viewOfTurns(150, 1000)));

    // 150 turns are 300 rows: the latest 120 start at the person's message at row 180, turn 90 of the new session.
    await waitFor(() => expect(shown()[0]).toBe('question 1090'));
    expect(shown()).toHaveLength(ROW_WINDOW);
    expect(shown().at(-1)).toBe('answer 1149');
  });
});
