import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PiRecord } from '@/common/utils/nativeHost';
import NativeConversationPage from '@/renderer/pages/native';
import { NativeClientContext } from '@/renderer/pages/native/utils/nativeClient';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import enConversation from '@/renderer/services/i18n/locales/en-US/conversation.json';
import enMessages from '@/renderer/services/i18n/locales/en-US/messages.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import { createFakeHost } from './fakeClient';
import { findRecord, recorded } from './records';

/**
 * The native page, mounted in jsdom against an in-memory host that plays the conversation recorded from a real one
 * (../fixtures/record.mjs), record by record as the main process would push them: six turns, a file written, a
 * command run, mu asking about a command and being answered, mu asking again and the run stopped instead, and a
 * reply stopped mid-way. The list, its rows and the tool box run for real; text rows and the send box are stood in
 * for. What is looked up is what the end-to-end tests look up (the `native-*` test ids).
 */

vi.mock('@/renderer/components/chat/SendBox', () => ({ default: () => <div data-testid='sendbox' /> }));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageText', () => ({
  default: ({ message }: { message: { position: string; content: { content: string } } }) => (
    <div data-testid={`row-text-${message.position}`}>{message.content.content}</div>
  ),
}));

afterEach(cleanup);

const i18n = createInstance();
void i18n.init({
  lng: 'en',
  resources: {
    en: { translation: { common: enCommon, conversation: enConversation, messages: enMessages, mu: enMu } },
  },
  interpolation: { escapeValue: false },
});

const isDialog = (record: PiRecord): boolean =>
  record.type === 'extension_ui_request' && (record as { method?: unknown }).method === 'select';

describe('the native page, playing a recorded conversation', () => {
  it('shows every turn, asks mu’s questions while they wait, and ends where the host ended', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1', cwd: '/work/e2e' });
    render(
      <I18nextProvider i18n={i18n}>
        <NativeClientContext.Provider value={host.client}>
          <MemoryRouter initialEntries={['/conversation/native/c1']}>
            <Routes>
              <Route path='/conversation/native/:id' element={<NativeConversationPage />} />
            </Routes>
          </MemoryRouter>
        </NativeClientContext.Provider>
      </I18nextProvider>
    );
    await waitFor(() => expect(screen.getByTestId('native-empty')).toBeInTheDocument());

    const firstAsk = findRecord(isDialog);
    const secondAsk = findRecord(isDialog, firstAsk + 1);
    const play = (from: number, to: number) =>
      act(() => {
        for (const record of recorded.slice(from, to)) host.push('c1', record);
      });

    // Up to mu's first question: a run is on, and the line above the box says so.
    const status = () => screen.getByTestId('native-status');
    expect(status()).toHaveAttribute('data-status', 'idle');
    play(0, firstAsk);
    expect(status().dataset.status).toMatch(/^(working|thinking)$/);
    expect(status()).not.toBeEmptyDOMElement();
    expect(screen.queryByTestId('native-dialog')).toBeNull();
    play(firstAsk, firstAsk + 1);
    const dialog = screen.getByTestId('native-dialog');
    expect(dialog).toHaveAttribute('data-method', 'select');
    expect(dialog).toHaveTextContent('mu wants to run a command');
    expect(dialog).toHaveTextContent('sleep 0.2; echo asked-ok');
    const options = screen.getAllByTestId('native-dialog-option').map((option) => option.textContent);
    expect(options[0]).toBe('Allow once');
    expect(options.at(-1)).toBe('Don’t allow');
    // Answered (in the recording, by the host): the question goes.
    play(firstAsk + 1, firstAsk + 2);
    expect(screen.queryByTestId('native-dialog')).toBeNull();

    // Asked again, and the run stopped instead of an answer: mu says it resolved, and the question goes too.
    play(firstAsk + 2, secondAsk + 1);
    expect(screen.getByTestId('native-dialog')).toBeInTheDocument();
    const resolved = findRecord(
      (record) =>
        record.type === 'extension_ui_request' &&
        String((record as { statusText?: unknown }).statusText ?? '').includes('"permissions.resolved"'),
      secondAsk
    );
    play(secondAsk + 1, resolved + 1);
    expect(screen.queryByTestId('native-dialog')).toBeNull();

    play(resolved + 1, recorded.length);
    // The run was stopped: the line goes, and the status says how the run ended.
    await waitFor(() => expect(status()).toHaveAttribute('data-status', 'aborted'));
    expect(status()).toBeEmptyDOMElement();

    // Every message the person sent, in order.
    expect(screen.getAllByTestId('native-message-user').map((row) => row.textContent)).toEqual([
      'E2E:PLAIN',
      'E2E:WRITE notes/hello.txt',
      'E2E:BASH echo native-host-bash-ok',
      'E2E:BASH sleep 0.2; echo asked-ok',
      'E2E:BASH sleep 0.2; echo asked-ok',
      'E2E:SLOW',
    ]);
    // mu's replies, the calls it made, Jev's class for each message, and mu's notices.
    const view = host.viewOf('c1');
    const replies = view.messages.filter(
      (message) => message.role === 'assistant' && message.blocks.some((block) => block.type === 'text' && block.text)
    );
    expect(screen.getAllByTestId('native-message-assistant')).toHaveLength(replies.length);
    expect(screen.getAllByTestId('row-text-left')).toHaveLength(replies.length);
    // Each call by pi's tool name and how it ended: the one mu asked about while the run was stopped, pi ended as
    // failed ("Operation aborted").
    expect(screen.getAllByTestId('native-tool-call').map((call) => [call.dataset.tool, call.dataset.status])).toEqual([
      ['write', 'completed'],
      ['bash', 'completed'],
      ['bash', 'completed'],
      ['bash', 'error'],
    ]);
    const verdicts = view.messages.filter((message) => message.role === 'user' && message.verdict).length;
    expect(verdicts).toBeGreaterThan(0);
    expect(screen.getAllByTestId('mu-jev-line')).toHaveLength(verdicts);
    const notices = screen.getAllByTestId('mu-notice');
    expect(notices.map((notice) => notice.dataset.code)).toEqual(expect.arrayContaining(['checkpoint_off', 'stopped']));
    expect(screen.getByText(/Checkpoints are off in this conversation/)).toBeInTheDocument();
    expect(view.status).toBe('aborted');
  });
});
