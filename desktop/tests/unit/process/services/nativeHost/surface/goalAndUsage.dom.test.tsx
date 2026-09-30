import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromEntries, type PiCommand } from '@/common/utils/nativeHost';
import NativeComposer from '@/renderer/pages/native/components/NativeComposer';
import { useNativeConversation } from '@/renderer/pages/native/hooks/useNativeConversation';
import { NativeClientContext } from '@/renderer/pages/native/utils/nativeClient';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import enConversation from '@/renderer/services/i18n/locales/en-US/conversation.json';
import enMessages from '@/renderer/services/i18n/locales/en-US/messages.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import { createFakeHost, type FakeHost } from './fakeClient';
import { ended, frame, reply, text, user } from './records';

/**
 * What the native send box shows besides the text, against an in-memory host: mu's goal in the line above it (live
 * from mu's `goal.state` frames, and from the session file's `kyrn.goal` entries with no host), ended from the line
 * with `/goal clear`; the context ring beside the send button once pi has said how full the context is, with pi's
 * session counts asked after each run; and a command an extension answers (`/goal …`) that is not left on its way.
 */

type BoxProps = {
  value?: string;
  onChange?: (value: string) => void;
  onSend: (message: string) => Promise<void | false>;
  loading?: boolean;
  allowSendWhileLoading?: boolean;
  tools?: React.ReactNode;
  sendButtonPrefix?: React.ReactNode;
  testIds?: { input?: string; send?: string; stop?: string };
};

vi.mock('@/renderer/components/chat/SendBox', () => ({
  default: ({
    value = '',
    onChange,
    onSend,
    loading,
    allowSendWhileLoading,
    tools,
    sendButtonPrefix,
    testIds,
  }: BoxProps) => (
    <div data-testid='sendbox'>
      {tools}
      <textarea
        data-testid={testIds?.input ?? 'sendbox-input'}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
      />
      {sendButtonPrefix}
      <button
        type='button'
        data-testid={testIds?.send ?? 'sendbox-send-btn'}
        onClick={() => {
          if (loading && !allowSendWhileLoading) return;
          onChange?.('');
          void onSend(value);
        }}
      />
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
  render(
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
}

const commands = (host: FakeHost): PiCommand[] =>
  host.calls.filter((call) => call.method === 'request').flatMap((call) => (call.command ? [call.command] : []));
const line = () => screen.queryByTestId('composer-goal-line');
const goalFrame = (status: string, goal: string) => frame('goal.state', { status, text: goal, continuations: 0 });
/** A session file's entry, each the child of the one before (`file`). */
const entry = (id: string, fields: Record<string, unknown>) => ({
  id,
  timestamp: '2026-09-29T10:00:00.000Z',
  ...fields,
});
function file(entries: Array<Record<string, unknown>>) {
  return entries.map((each, index) => ({ ...each, parentId: index ? entries[index - 1].id : null }));
}

describe('the goal line of a native conversation', () => {
  it('shows the goal mu sets, and ends it with /goal clear, stopping the run that goes', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    host.setStatus('c1', { phase: 'running' });
    await mount(host);
    expect(line()).toBeNull();
    act(() => {
      host.play('c1', [{ type: 'agent_start' }, goalFrame('active', 'every test passes')]);
    });
    expect(line()).toHaveAttribute('data-status', 'active');
    expect(screen.getByTestId('composer-goal-text')).toHaveTextContent('every test passes');
    // Above the status line, which tucks under the send box and would cover what came between them.
    expect(line()!.compareDocumentPosition(screen.getByTestId('native-status'))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-goal-end'));
    });
    // Cleared first, then the run is stopped (so the stop does not pause the goal on the way).
    expect(commands(host).filter((command) => command.type === 'prompt' || command.type === 'abort')).toEqual([
      { type: 'prompt', message: '/goal clear' },
      { type: 'abort' },
    ]);
    expect(screen.getByTestId('composer-goal-end')).toBeDisabled();
    act(() => {
      host.push('c1', goalFrame('cleared', 'every test passes'));
    });
    expect(line()).toBeNull();
  });

  it('says a paused goal is paused, and shows no goal that was met', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    host.setStatus('c1', { phase: 'running' });
    await mount(host);
    act(() => {
      host.push('c1', goalFrame('paused', 'the page loads'));
    });
    expect(line()).toHaveAttribute('data-status', 'paused');
    expect(line()).toHaveTextContent('Goal paused');
    act(() => {
      host.push('c1', goalFrame('met', 'the page loads'));
    });
    expect(line()).toBeNull();
  });

  it('reads the goal from the session file with no host, as paused, and ends it without a stop', async () => {
    const host = createFakeHost();
    const goal = { status: 'active', text: 'the docs build', continuations: 2 };
    host.add(
      { id: 'c1' },
      fromEntries(
        file([
          entry('u1', { type: 'message', message: user('/goal the docs build') }),
          entry('g1', { type: 'custom', customType: 'kyrn.goal', data: goal }),
          entry('a1', { type: 'message', message: reply([text('working on it')]) }),
        ])
      )
    );
    await mount(host);
    // No mu runs: a goal the file says runs waits for the next message, as mu says when it resumes the session.
    expect(line()).toHaveAttribute('data-status', 'paused');
    expect(screen.getByTestId('composer-goal-text')).toHaveTextContent('the docs build');
    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-goal-end'));
    });
    expect(commands(host).filter((command) => command.type === 'prompt' || command.type === 'abort')).toEqual([
      { type: 'prompt', message: '/goal clear' },
    ]);
  });

  it('comes back when the command is refused', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    host.setStatus('c1', { phase: 'running' });
    host.answer((_id, command) =>
      command.type === 'prompt' ? { ok: false, kind: 'timeout', message: 'pi did not answer' } : { ok: true, data: {} }
    );
    await mount(host);
    act(() => {
      host.push('c1', goalFrame('active', 'ship it'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-goal-end'));
    });
    await waitFor(() => expect(screen.getByTestId('composer-goal-end')).not.toBeDisabled());
    expect(line()).toHaveAttribute('data-status', 'active');
  });
});

/** pi's answer to `get_state`, with how full the context is. */
const state = (tokens: number | null, contextWindow: number) => ({
  type: 'response',
  command: 'get_state',
  success: true,
  data: { contextUsage: { tokens, contextWindow, percent: tokens === null ? null : (tokens / contextWindow) * 100 } },
});

describe('the context ring of a native conversation', () => {
  it('shows nothing until pi says how full the context is, then the fill against the window', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    await mount(host);
    expect(screen.queryByTestId('native-context-usage')).toBeNull();
    act(() => {
      host.play('c1', [
        { type: 'agent_start' },
        ended(user('go')),
        ended(reply([text('done')], { usage: { input: 900, output: 300, cacheRead: 40, cacheWrite: 0 } })),
        { type: 'agent_settled' },
        state(1240, 128000),
      ]);
    });
    const ring = screen.getByTestId('native-context-usage');
    expect(ring).toHaveAttribute('data-tokens', '1240');
    expect(ring).toHaveAttribute('data-window', '128000');
    // Right after a compaction pi does not know the count yet: nothing rather than an old number.
    act(() => {
      host.push('c1', state(null, 128000));
    });
    expect(screen.queryByTestId('native-context-usage')).toBeNull();
  });

  it('asks pi for the session’s counts once a host runs and after each run, and keeps the cost', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    await mount(host);
    const asked = () => commands(host).filter((command) => command.type === 'get_session_stats').length;
    // No host: nothing is asked (a read would start one).
    expect(asked()).toBe(0);
    act(() => host.setStatus('c1', { phase: 'running' }));
    await waitFor(() => expect(asked()).toBe(1));
    act(() => {
      host.play('c1', [{ type: 'agent_start' }, ended(user('go')), { type: 'agent_settled' }]);
    });
    await waitFor(() => expect(asked()).toBe(2));
    act(() => {
      host.push('c1', {
        type: 'response',
        command: 'get_session_stats',
        success: true,
        data: { tokens: { input: 10, output: 5 }, cost: 0.0421, contextUsage: { tokens: 15, contextWindow: 1000 } },
      });
    });
    expect(host.viewOf('c1').host.session?.cost).toBe(0.0421);
    expect(screen.getByTestId('native-context-usage')).toHaveAttribute('data-tokens', '15');
    // Nothing new: nothing asked again.
    act(() => {
      host.push('c1', frame('progress', { step: 'reading' }));
    });
    await act(async () => {});
    expect(asked()).toBe(2);
  });
});

describe('a command an extension answers', () => {
  it('is not left on its way when it starts a run (mu’s /goal)', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    host.setStatus('c1', { phase: 'running' });
    host.answer((id, command) => {
      if (command.type === 'get_commands')
        return {
          ok: true,
          data: {
            commands: [
              { name: 'goal', source: 'extension', description: 'Goal mode' },
              { name: 'review', source: 'prompt', description: 'A template' },
            ],
          },
        };
      // The goal's run starts before pi answers the command.
      if (command.type === 'prompt' && command.message.startsWith('/goal')) host.push(id, { type: 'agent_start' });
      return { ok: true, data: { isStreaming: true, isCompacting: false } };
    });
    await mount(host);
    await waitFor(() => expect(commands(host)).toContainEqual({ type: 'get_commands' }));
    await act(async () => {});
    fireEvent.change(screen.getByTestId('native-send-input'), { target: { value: '/goal the build is green' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-send'));
    });
    expect(commands(host)).toContainEqual({ type: 'prompt', message: '/goal the build is green' });
    await waitFor(() => expect(screen.getByTestId('native-status')).toHaveAttribute('data-sending', 'false'));
    expect(screen.getByTestId('native-status')).toHaveAttribute('data-status', 'working');
  });

  it('a prompt template still waits for the message it becomes', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    host.setStatus('c1', { phase: 'running' });
    host.answer((id, command) => {
      if (command.type === 'get_commands')
        return { ok: true, data: { commands: [{ name: 'review', source: 'prompt', description: 'A template' }] } };
      if (command.type === 'prompt') host.push(id, { type: 'agent_start' });
      return { ok: true, data: { isStreaming: true, isCompacting: false } };
    });
    await mount(host);
    await waitFor(() => expect(commands(host)).toContainEqual({ type: 'get_commands' }));
    await act(async () => {});
    fireEvent.change(screen.getByTestId('native-send-input'), { target: { value: '/review src' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-send'));
    });
    expect(screen.getByTestId('native-status')).toHaveAttribute('data-sending', 'true');
    act(() => {
      host.push('c1', ended(user('Review src carefully')));
    });
    expect(screen.getByTestId('native-status')).toHaveAttribute('data-sending', 'false');
  });
});
