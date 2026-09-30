import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeResult } from '@/common/kyrn/nativeBridge';
import type { PiCommand } from '@/common/utils/nativeHost';
import NativeComposer from '@/renderer/pages/native/components/NativeComposer';
import { useNativeConversation } from '@/renderer/pages/native/hooks/useNativeConversation';
import { NativeClientContext } from '@/renderer/pages/native/utils/nativeClient';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import enConversation from '@/renderer/services/i18n/locales/en-US/conversation.json';
import enMessages from '@/renderer/services/i18n/locales/en-US/messages.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import { emitter } from '@/renderer/utils/emitter';
import { createFakeHost, type FakeHost } from './fakeClient';
import { delta, ended, frame, reply, text, user } from './records';

/**
 * The bottom of a native conversation against an in-memory host: the send box in each state (idle, a message Jev
 * reads, a run going), the queue, the status line, the notices about mu, and a panel's command. The shared send box
 * is stood in for by its contract (value, send, stop, loading, sending while loading, tools, test ids), so the ids
 * found here are the ones the native screen gives the real box.
 */

type BoxProps = {
  value?: string;
  onChange?: (value: string) => void;
  onSend: (message: string) => Promise<void | false>;
  onStop?: () => Promise<void>;
  loading?: boolean;
  allowSendWhileLoading?: boolean;
  placeholder?: string;
  tools?: React.ReactNode;
  testIds?: { input?: string; send?: string; stop?: string };
};

vi.mock('@/renderer/components/chat/SendBox', () => ({
  // As the real box: sending clears the text and a `false` answer brings it back; stop shows while loading.
  default: ({
    value = '',
    onChange,
    onSend,
    onStop,
    loading,
    allowSendWhileLoading,
    placeholder,
    tools,
    testIds,
  }: BoxProps) => (
    <div
      data-testid='sendbox'
      data-loading={String(Boolean(loading))}
      data-send={String(Boolean(allowSendWhileLoading))}
    >
      {tools}
      <textarea
        data-testid={testIds?.input ?? 'sendbox-input'}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange?.(event.target.value)}
      />
      <button
        type='button'
        data-testid={testIds?.send ?? 'sendbox-send-btn'}
        onClick={() => {
          if (loading && !allowSendWhileLoading) return;
          onChange?.('');
          void onSend(value).then((result) => {
            if (result === false) onChange?.(value);
          });
        }}
      />
      {loading ? (
        <button type='button' data-testid={testIds?.stop ?? 'sendbox-stop-btn'} onClick={() => void onStop?.()} />
      ) : null}
    </div>
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

const Harness: React.FC<{ id: string }> = ({ id }) => <NativeComposer conversation={useNativeConversation(id)} />;

async function mount(host: FakeHost, id = 'c1') {
  const view = render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <NativeClientContext.Provider value={host.client}>
          <Harness id={id} />
        </NativeClientContext.Provider>
      </MemoryRouter>
    </I18nextProvider>
  );
  await waitFor(() => expect(host.calls.some((call) => call.method === 'open')).toBe(true));
  await act(async () => {});
  return view;
}

const commands = (host: FakeHost): PiCommand[] =>
  host.calls.filter((call) => call.method === 'request').flatMap((call) => (call.command ? [call.command] : []));

const box = () => screen.getByTestId('sendbox');
const input = () => screen.getByTestId('native-send-input');
const status = () => screen.getByTestId('native-status');
const type = (value: string) => fireEvent.change(input(), { target: { value } });
const send = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('native-send'));
  });
};

/** A run going: pi started it and the model writes. */
const running = (host: FakeHost) =>
  act(() => {
    host.play('c1', [
      { type: 'agent_start' },
      ended(user('go')),
      { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 2 } },
    ]);
  });

describe('the native send box', () => {
  it('sends a prompt, holds the box while Jev reads it, and stops it there', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    const gate: { release?: () => void } = {};
    host.answer((id, command) => {
      if (command.type !== 'prompt') return { ok: true, data: { isStreaming: false, isCompacting: false } };
      host.push(id, frame('preflight.pending', { judge: 'laya' }));
      return new Promise<NativeResult<unknown>>((resolve) => {
        gate.release = () => resolve({ ok: true, data: undefined });
      });
    });
    await mount(host);
    expect(input()).toHaveAttribute('placeholder', 'Message mu…');
    expect(screen.queryByTestId('native-abort')).toBeNull();
    expect(box()).toHaveAttribute('data-loading', 'false');
    expect(status()).toHaveAttribute('data-sending', 'false');
    type('fix the build');
    await send();
    expect(commands(host)).toContainEqual({ type: 'prompt', message: 'fix the build' });
    // On its way: the run it starts has not begun, so the status is still the last run's.
    expect(status()).toHaveAttribute('data-sending', 'true');
    expect(status()).toHaveAttribute('data-status', 'idle');
    // Jev reads the message: the box holds (no second prompt), says so, and offers to stop.
    expect(box()).toHaveAttribute('data-loading', 'true');
    expect(box()).toHaveAttribute('data-send', 'false');
    expect(status()).toHaveTextContent('Jev is reading your message…');
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-abort'));
    });
    expect(commands(host)).toContainEqual({ type: 'abort' });
    await act(async () => gate.release?.());
    // pi took the prompt after the stop: it is stopped once more, and the box is free again.
    expect(commands(host).filter((command) => command.type === 'abort')).toHaveLength(2);
    await waitFor(() => expect(box()).toHaveAttribute('data-loading', 'false'));
    expect(status()).toHaveAttribute('data-sending', 'false');
  });

  it('steers a run that goes, or leaves the message for after it', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    await mount(host);
    expect(screen.queryByTestId('native-send-mode')).toBeNull();
    await running(host);
    expect(screen.getByTestId('native-send-mode')).toBeInTheDocument();
    expect(box()).toHaveAttribute('data-loading', 'true');
    expect(box()).toHaveAttribute('data-send', 'true');
    expect(input()).toHaveAttribute('placeholder', 'Steer mu now, or leave a message for after this run…');
    type('also check the tests');
    await send();
    fireEvent.click(screen.getByText('After'));
    type('then write the notes');
    await send();
    expect(commands(host)).toEqual([
      { type: 'prompt', message: 'also check the tests', streamingBehavior: 'steer' },
      { type: 'prompt', message: 'then write the notes', streamingBehavior: 'followUp' },
    ]);
  });

  it('shows what waits in pi’s queue, and takes it back into the box', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    host.answer((_id, command) =>
      command.type === 'clear_queue'
        ? { ok: true, data: { steering: ['look at a'], followUp: ['then b'] } }
        : { ok: true, data: undefined }
    );
    await mount(host);
    await running(host);
    act(() => {
      host.push('c1', { type: 'queue_update', steering: ['look at a'], followUp: ['then b'] });
    });
    const queue = screen.getByTestId('native-queue');
    expect(queue).toHaveTextContent('Next steplook at a');
    expect(queue).toHaveTextContent('After this runthen b');
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-queue-take-back'));
    });
    expect(commands(host)).toContainEqual({ type: 'clear_queue' });
    expect(input()).toHaveValue('look at a\n\nthen b');
  });

  it('passes a panel’s command for this conversation to pi as it is', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    await mount(host);
    const heard = vi.fn();
    await act(async () => {
      emitter.emit('sendbox.command', '/board on', 'other', heard);
      emitter.emit('sendbox.command', '/board on', 'c1', heard);
    });
    expect(commands(host)).toEqual([{ type: 'prompt', message: '/board on' }]);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledWith('sent');
  });

  it('says when mu has no model, when it stopped, and why a command failed', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    host.answer(() => ({ ok: false, kind: 'timeout', message: 'pi did not answer prompt in 30 s' }));
    await mount(host);
    act(() => host.setStatus('c1', { phase: 'needs-model' }));
    expect(screen.getByTestId('native-needs-model')).toHaveTextContent('No model to answer with');
    act(() =>
      host.setStatus('c1', {
        phase: 'failed',
        error: { kind: 'crashed', message: 'mu exited with code 1', stderr: 'TypeError: boom' },
      })
    );
    expect(screen.queryByTestId('native-needs-model')).toBeNull();
    const stopped = screen.getByTestId('native-failed');
    expect(stopped).toHaveAttribute('data-kind', 'crashed');
    expect(stopped).toHaveTextContent('mu stopped unexpectedly.');
    expect(stopped).toHaveTextContent('mu exited with code 1');
    expect(stopped).toHaveTextContent('TypeError: boom');
    expect(stopped).toHaveTextContent('Send a message to start mu again.');
    type('hello');
    await send();
    expect(screen.getByTestId('native-command-failed')).toHaveTextContent('mu did not answer in time.');
    // What did not reach pi is back in the box.
    expect(input()).toHaveValue('hello');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('native-command-failed')).toBeNull();
  });

  it('says that the project folder is gone when a message cannot start mu in it, with the folder named, and keeps the message', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    host.answer(() => ({ ok: false, kind: 'no-folder', message: 'The project folder no longer exists: /work/gone' }));
    await mount(host);
    type('go on');
    await send();
    const card = screen.getByTestId('native-command-failed');
    expect(card).toHaveAttribute('data-kind', 'no-folder');
    expect(card).toHaveTextContent('The project folder no longer exists, so mu cannot start in it.');
    expect(card).toHaveTextContent('/work/gone');
    expect(input()).toHaveValue('go on');
  });

  it('says once why mu stopped when the message that found out fails with the same words', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    const error = { kind: 'failed' as const, message: 'The mu host stopped before pi started (exit code 1)' };
    host.answer(() => ({ ok: false, ...error, stderr: 'boom' }));
    await mount(host);
    act(() => host.setStatus('c1', { phase: 'failed', error: { ...error, stderr: 'boom' } }));
    type('hello');
    await send();
    expect(screen.getAllByTestId('native-failed')).toHaveLength(1);
    expect(screen.queryByTestId('native-command-failed')).toBeNull();
    // What did not reach pi is back in the box.
    expect(input()).toHaveValue('hello');
  });

  it('says on the line above the box what holds the run up or what it works out', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    await mount(host);
    // No line while nothing happens; the element is there, with the view's status.
    expect(status()).toHaveAttribute('data-status', 'idle');
    expect(status()).toBeEmptyDOMElement();
    act(() => host.setStatus('c1', { phase: 'starting' }));
    expect(status()).toHaveTextContent('Starting mu…');
    act(() => host.setStatus('c1', { phase: 'running' }));
    await running(host);
    expect(status()).toHaveAttribute('data-status', 'working');
    act(() => {
      host.push('c1', frame('progress', { step: 'Checking lessons', code: 'lessons' }));
    });
    expect(status()).toHaveTextContent('Checking lessons from earlier sessions');
    act(() => {
      host.push('c1', { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '529' });
    });
    expect(status()).toHaveTextContent('The model request failed. Trying again (1 of 3)…');
    act(() => {
      host.play('c1', [
        { type: 'auto_retry_end', success: true },
        { type: 'compaction_start', reason: 'threshold' },
      ]);
    });
    expect(status()).toHaveTextContent('Compacting the conversation…');
    act(() => {
      host.play('c1', [{ type: 'compaction_end', reason: 'threshold', aborted: false }, { type: 'agent_settled' }]);
    });
    expect(status()).toHaveAttribute('data-status', 'settled');
    expect(status()).toBeEmptyDOMElement();
  });

  it('carries the view’s status for what waits on a run: thinking, working, and how it ended', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    await mount(host);
    await running(host);
    act(() => {
      host.push('c1', delta({ type: 'thinking_start', contentIndex: 0 }));
    });
    expect(status()).toHaveAttribute('data-status', 'thinking');
    expect(status()).toHaveTextContent('Thinking…');
    act(() => {
      host.push('c1', delta({ type: 'thinking_end', contentIndex: 0, content: 'plan' }));
    });
    expect(status()).toHaveAttribute('data-status', 'working');
    act(() => {
      host.play('c1', [ended(reply([text('stopped')], { stopReason: 'aborted' })), { type: 'agent_settled' }]);
    });
    expect(status()).toHaveAttribute('data-status', 'aborted');
    await running(host);
    act(() => {
      host.play('c1', [
        ended(reply([], { stopReason: 'error', errorMessage: 'overloaded' })),
        { type: 'agent_settled' },
      ]);
    });
    expect(status()).toHaveAttribute('data-status', 'error');
    expect(status()).toBeEmptyDOMElement();
  });
});
