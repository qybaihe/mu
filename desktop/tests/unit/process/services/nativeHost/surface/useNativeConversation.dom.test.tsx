import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { NativeResult, NativeSnapshot } from '@/common/kyrn/nativeBridge';
import { durable, reduceAll, type NativeView, type PiRecord } from '@/common/utils/nativeHost';
import { useNativeConversation } from '@/renderer/pages/native/hooks/useNativeConversation';
import { NativeClientContext, type NativeClient } from '@/renderer/pages/native/utils/nativeClient';
import { createFakeHost, type FakeHost } from './fakeClient';
import { ended, findRecord, frame, recorded, reply, text, user } from './records';

/** The native conversation hook against an in-memory host: snapshot, records, commands, dialogs, ids. */

const wrapperOf =
  (client: NativeClient) =>
  ({ children }: { children: React.ReactNode }) => (
    <NativeClientContext.Provider value={client}>{children}</NativeClientContext.Provider>
  );

function mount(host: FakeHost, id = 'c1', client: NativeClient = host.client) {
  return renderHook(({ conversation }) => useNativeConversation(conversation), {
    initialProps: { conversation: id },
    wrapper: wrapperOf(client),
  });
}

/** A client whose `open` answers only when the test says. */
function slowOpen(host: FakeHost) {
  const gate: { open?: () => void } = {};
  const opened = new Promise<void>((resolve) => {
    gate.open = resolve;
  });
  const client: NativeClient = {
    ...host.client,
    open: async (id): Promise<NativeResult<NativeSnapshot>> => {
      const answer = await host.client.open(id);
      await opened;
      return answer;
    },
  };
  return { client, release: () => gate.open?.() };
}

/** How many messages of the person a view holds. */
const users = (view: NativeView): number => view.messages.filter((message) => message.role === 'user').length;

const settledAt = recorded.flatMap((record, index) => (record.type === 'agent_settled' ? [index] : []));

describe('useNativeConversation', () => {
  it('opens the snapshot, folds the records that follow, and ends where the host ends', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    host.play('c1', recorded.slice(0, settledAt[0] + 1));
    const { result } = mount(host);
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.seq).toBe(settledAt[0] + 1);
    act(() => host.play('c1', recorded.slice(settledAt[0] + 1)));
    expect(result.current.seq).toBe(recorded.length);
    expect(result.current.view).toStrictEqual(host.viewOf('c1'));
    expect(result.current.view.status).toBe('aborted');
  });

  it('shows a run in progress to a window that opens during it, as the first window sees it', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    const midway = findRecord((record) => (record.assistantMessageEvent as { delta?: string })?.delta === '好几段');
    host.play('c1', recorded.slice(0, midway + 1));
    const first = mount(host);
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    const second = mount(host);
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(second.result.current.view.status).toBe('working');
    expect(second.result.current.view).toStrictEqual(first.result.current.view);
    act(() => host.play('c1', recorded.slice(midway + 1, settledAt[0] + 1)));
    expect(second.result.current.view).toStrictEqual(first.result.current.view);
    expect(durable(first.result.current.view)).toStrictEqual(durable(reduceAll(recorded.slice(0, settledAt[0] + 1))));
  });

  it('folds records that come while the snapshot is on its way, once, and ignores ones it has', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    host.play('c1', [{ type: 'agent_start' }, ended(user('hi'))]);
    const { client, release } = slowOpen(host);
    const { result } = mount(host, 'c1', client);
    // Pushed after the host answered `open` but before the window has the answer.
    await waitFor(() => expect(host.calls.some((call) => call.method === 'open')).toBe(true));
    act(() => {
      host.push('c1', ended(reply([text('hello')])));
    });
    await act(async () => release());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.seq).toBe(3);
    expect(result.current.view.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    act(() => host.pushRaw({ id: 'c1', seq: 2, record: ended(user('again')) }));
    expect(result.current.view.messages).toHaveLength(2);
  });

  it('opens the conversation again when it missed records', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    const { result } = mount(host);
    await waitFor(() => expect(result.current.loading).toBe(false));
    const opens = host.calls.filter((call) => call.method === 'open').length;
    host.push('c1', ended(user('one')), true);
    host.push('c1', ended(user('two')), true);
    act(() => {
      host.push('c1', ended(user('three')));
    });
    await waitFor(() => expect(result.current.seq).toBe(3));
    expect(host.calls.filter((call) => call.method === 'open')).toHaveLength(opens + 1);
    expect(result.current.view.messages.map((message) => message.role === 'user' && message.text)).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  it('shows a prompt on its way until the conversation has it, and steers or queues while a run goes', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    const { result } = mount(host);
    await waitFor(() => expect(result.current.loading).toBe(false));
    host.answer((id, command) => {
      if (command.type === 'prompt') {
        host.play(id, [
          frame('preflight.pending', { judge: 'mock' }),
          { type: 'response', command: 'prompt', success: true },
        ]);
        host.play(id, [{ type: 'agent_start' }]);
      }
      if (command.type === 'get_state') return { ok: true, data: { isStreaming: true, isCompacting: false } };
      return { ok: true, data: undefined };
    });
    let sending: Promise<unknown> = Promise.resolve();
    act(() => {
      sending = result.current.send('fix it');
    });
    expect(result.current.outgoing).toMatchObject({ text: 'fix it' });
    await act(async () => {
      await sending;
    });
    expect(result.current.outgoing).toMatchObject({ text: 'fix it' });
    act(() => {
      host.push('c1', ended(user('fix it')));
    });
    expect(result.current.outgoing).toBeUndefined();

    await act(async () => {
      await result.current.send('also b');
      await result.current.send('then c', 'followUp');
    });
    const commands = host.calls.filter((call) => call.method === 'request').map((call) => call.command);
    expect(commands).toContainEqual({ type: 'prompt', message: 'fix it' });
    // As prompts with pi's streamingBehavior: a run that ended meanwhile is started by the message, not left waiting.
    expect(commands).toContainEqual({ type: 'prompt', message: 'also b', streamingBehavior: 'steer' });
    expect(commands).toContainEqual({ type: 'prompt', message: 'then c', streamingBehavior: 'followUp' });
  });

  it('lets pi show a refused prompt, and says a failure pi could not', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    const { result } = mount(host);
    await waitFor(() => expect(result.current.loading).toBe(false));
    host.answer((id, command) => {
      if (command.type !== 'prompt') return { ok: true, data: undefined };
      host.push(id, { type: 'response', command: 'prompt', success: false, error: 'No API key found for p.' });
      return { ok: false, kind: 'command', message: 'No API key found for p.' };
    });
    await act(async () => {
      await result.current.send('hi');
    });
    expect(result.current.outgoing).toBeUndefined();
    expect(result.current.commandFailure).toBeUndefined();
    expect(result.current.view).toMatchObject({ status: 'error', error: 'No API key found for p.' });

    host.answer(() => ({ ok: false, kind: 'no-harness', message: 'mu is not installed' }));
    await act(async () => {
      await result.current.send('hi');
    });
    expect(result.current.commandFailure).toMatchObject({ kind: 'no-harness' });
    act(() => result.current.clearFailure());
    expect(result.current.commandFailure).toBeUndefined();
  });

  it('lets go of a prompt pi answered without a run, a command of an extension', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    const { result } = mount(host);
    await waitFor(() => expect(result.current.loading).toBe(false));
    host.answer((id, command) => {
      if (command.type === 'prompt')
        host.play(id, [
          { type: 'extension_ui_request', id: 'n', method: 'notify', message: 'No lessons yet.' },
          { type: 'response', command: 'prompt', success: true },
        ]);
      if (command.type === 'get_state') return { ok: true, data: { isStreaming: false, isCompacting: false } };
      return { ok: true, data: undefined };
    });
    await act(async () => {
      await result.current.send('/lessons');
    });
    expect(result.current.outgoing).toBeUndefined();
    expect(result.current.view.host.notices.map((notice) => notice.text)).toEqual(['No lessons yet.']);
  });

  it('stops a prompt Jev still classifies, and the run it starts after all', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    const { result } = mount(host);
    await waitFor(() => expect(result.current.loading).toBe(false));
    const pi: { accept?: () => void } = {};
    host.answer(async (_id, command) => {
      if (command.type === 'prompt')
        await new Promise<void>((resolve) => {
          pi.accept = resolve;
        });
      if (command.type === 'get_state') return { ok: true, data: { isStreaming: false } };
      return { ok: true, data: undefined };
    });
    let sending: Promise<unknown> = Promise.resolve();
    act(() => {
      sending = result.current.send('go');
    });
    await act(async () => {
      await result.current.abort();
      pi.accept?.();
      await sending;
    });
    const commands = host.calls.filter((call) => call.method === 'request').map((call) => call.command?.type);
    expect(commands).toEqual(['prompt', 'abort', 'abort', 'get_state']);
  });

  it('closes a dialog as soon as it is answered or runs out, and opens it again when the answer fails', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    const { result } = mount(host);
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      host.play('c1', [
        { type: 'agent_start' },
        {
          type: 'extension_ui_request',
          id: 'd1',
          method: 'confirm',
          title: 'Sure?',
          message: 'Delete it',
          timeout: 50,
        },
        { type: 'extension_ui_request', id: 'd2', method: 'input', title: 'Name' },
      ]);
    });
    expect(result.current.view.dialogs.map((dialog) => dialog.id)).toEqual(['d1', 'd2']);
    act(() => result.current.expire('d1'));
    expect([...result.current.closed]).toEqual(['d1']);
    await act(async () => {
      await result.current.respond('d2', { value: 'x' });
    });
    expect(result.current.closed.has('d2')).toBe(true);
    expect(host.calls.find((call) => call.method === 'respond')).toMatchObject({
      dialogId: 'd2',
      answer: { value: 'x' },
    });

    const failing: NativeClient = {
      ...host.client,
      respond: async () => ({ ok: false, kind: 'closed', message: 'The host was ended' }),
    };
    const other = mount(host, 'c1', failing);
    await waitFor(() => expect(other.result.current.loading).toBe(false));
    await act(async () => {
      await other.result.current.respond('d2', { value: 'x' });
    });
    expect(other.result.current.closed.has('d2')).toBe(false);
    expect(other.result.current.commandFailure).toMatchObject({ kind: 'closed' });
  });

  it('follows the host’s status, a draft’s new id, a rebuilt view and a removal', async () => {
    const host = createFakeHost();
    host.add({ id: 'draft-1' });
    const { result, rerender } = mount(host, 'draft-1');
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => host.setStatus('draft-1', { phase: 'starting' }));
    expect(result.current.host).toEqual({ phase: 'starting' });

    act(() =>
      host.change({
        conversation: { id: 's-1', cwd: '/project', title: 'Hi', createdAt: 1, updatedAt: 2, live: true },
        replaces: 'draft-1',
      })
    );
    expect(result.current.id).toBe('s-1');
    act(() => {
      host.play('s-1', [{ type: 'agent_start' }, ended(user('hi'))] as PiRecord[]);
    });
    expect(result.current.view.messages).toHaveLength(1);
    const opens = host.calls.filter((call) => call.method === 'open').length;
    rerender({ conversation: 's-1' });
    expect(host.calls.filter((call) => call.method === 'open').length).toBe(opens);

    act(() => host.replace('s-1', reduceAll([ended(user('elsewhere'))])));
    expect(result.current.view.messages.map((m) => m.role === 'user' && m.text)).toEqual(['elsewhere']);

    await act(async () => {
      await host.client.remove('s-1');
    });
    expect(result.current.failure).toMatchObject({ kind: 'unknown-conversation' });
  });

  it('follows the conversation to a fork; the session it left is another conversation, opened afresh when asked', async () => {
    const host = createFakeHost();
    const whole = reduceAll([
      ended(user('one'), 'u1'),
      ended(reply([text('r1')]), 'a1'),
      ended(user('two'), 'u2'),
      ended(reply([text('r2')]), 'a2'),
    ]);
    const forked = reduceAll([ended(user('one'), 'u1'), ended(reply([text('r1')]), 'a1')]);
    host.add({ id: 'a', title: 'Two turns' }, whole);
    const { result, rerender } = mount(host, 'a');
    await waitFor(() => expect(result.current.loading).toBe(false));
    const key = result.current.key;

    // The main process moves the conversation to the fork: its id changes, then its view is rebuilt.
    act(() =>
      host.change({
        conversation: { id: 'b', cwd: '/project', title: 'Two turns', createdAt: 2, updatedAt: 2, live: true },
        replaces: 'a',
      })
    );
    act(() => host.replace('b', forked));
    expect(result.current.id).toBe('b');
    expect(users(result.current.view)).toBe(1);

    // The session it left is announced as a conversation of its own: that is no change to this one.
    host.add({ id: 'a', title: 'Two turns' }, whole);
    act(() =>
      host.change({
        conversation: { id: 'a', cwd: '/project', title: 'Two turns', createdAt: 1, updatedAt: 1, live: false },
      })
    );
    expect(result.current.id).toBe('b');
    expect(result.current.conversation?.live).toBe(true);

    // The route follows to the fork: the same conversation on screen, and the old id is no longer one of its own.
    rerender({ conversation: 'b' });
    expect(result.current.key).toBe(key);
    act(() => host.change({ removed: 'a' }));
    expect(result.current.failure).toBeUndefined();

    // Opening the old session is opening another conversation: shown afresh, whole, deaf to the fork's records.
    host.add({ id: 'a', title: 'Two turns' }, whole);
    rerender({ conversation: 'a' });
    await waitFor(() => expect(result.current.id).toBe('a'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.key).not.toBe(key);
    expect(users(result.current.view)).toBe(2);
    act(() => host.play('b', [ended(user('three'), 'u3')] as PiRecord[]));
    expect(users(result.current.view)).toBe(2);
    expect(result.current.id).toBe('a');
  });

  it('numbers each view it has: a record keeps the epoch, and a replaced or reopened view has a new one', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    host.add({ id: 'c2' });
    const { result, rerender } = mount(host);
    const loading = result.current.epoch;
    await waitFor(() => expect(result.current.loading).toBe(false));
    const opened = result.current.epoch;
    expect(opened).not.toBe(loading);

    act(() => host.play('c1', [{ type: 'agent_start' }, ended(user('hi'))] as PiRecord[]));
    expect(result.current.view.messages).toHaveLength(1);
    expect(result.current.epoch).toBe(opened);

    act(() => host.replace('c1', reduceAll([ended(user('elsewhere'))])));
    const replaced = result.current.epoch;
    expect(replaced).not.toBe(opened);

    // Another conversation in the same screen has a view of its own.
    rerender({ conversation: 'c2' });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.epoch).not.toBe(replaced);
    expect(result.current.epoch).not.toBe(opened);
  });

  it('says why a conversation cannot be opened', async () => {
    const host = createFakeHost();
    const { result } = mount(host, 'nowhere');
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.failure).toMatchObject({ kind: 'unknown-conversation' });
  });
});
