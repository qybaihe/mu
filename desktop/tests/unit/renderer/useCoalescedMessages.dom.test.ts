import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TMessage } from '@/common/chat/chatLib';
import { useCoalescedMessages } from '@/renderer/pages/conversation/Messages/useCoalescedMessages';

const text = (id: string, content: string): TMessage =>
  ({ id, conversation_id: 'c', type: 'text', position: 'left', content: { content } }) as TMessage;

const thinking = (id: string, content: string, status: 'thinking' | 'done'): TMessage =>
  ({ id, conversation_id: 'c', type: 'thinking', position: 'left', content: { content, status } }) as TMessage;

const toolCall = (id: string, status: string, output: string): TMessage =>
  ({
    id,
    conversation_id: 'c',
    type: 'acp_tool_call',
    position: 'left',
    content: { update: { tool_call_id: id, status, content: [{ type: 'content', content: { text: output } }] } },
  }) as unknown as TMessage;

let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const runFrame = () =>
  act(() => {
    const pending = frames;
    frames = [];
    for (const callback of pending) callback(0);
  });

describe('a list redrawn at most once a frame while rows grow', () => {
  it('holds a reply chunk for the next frame and lands the newest one', () => {
    const first = [text('a', 'Hel')];
    const { result, rerender } = renderHook(({ list }) => useCoalescedMessages(list), {
      initialProps: { list: first },
    });

    rerender({ list: [text('a', 'Hello')] });
    rerender({ list: [text('a', 'Hello, wor')] });
    expect(result.current).toBe(first);

    runFrame();
    expect(result.current[0]).toMatchObject({ content: { content: 'Hello, wor' } });
  });

  it('holds a tool call still in progress, and lands its completion at once', () => {
    const first = [text('a', 'Running'), toolCall('t', 'in_progress', 'line 1')];
    const { result, rerender } = renderHook(({ list }) => useCoalescedMessages(list), {
      initialProps: { list: first },
    });

    rerender({ list: [first[0], toolCall('t', 'in_progress', 'line 1\nline 2')] });
    expect(result.current).toBe(first);

    const done = [first[0], toolCall('t', 'completed', 'line 1\nline 2')];
    rerender({ list: done });
    expect(result.current).toBe(done);
  });

  it('lands a thought that stopped thinking at once', () => {
    const first = [thinking('t', 'Hmm', 'thinking')];
    const { result, rerender } = renderHook(({ list }) => useCoalescedMessages(list), {
      initialProps: { list: first },
    });

    const done = [thinking('t', 'Hmm.', 'done')];
    rerender({ list: done });
    expect(result.current).toBe(done);
  });

  it('lands a new row at once', () => {
    const first = [text('a', 'Hi')];
    const { result, rerender } = renderHook(({ list }) => useCoalescedMessages(list), {
      initialProps: { list: first },
    });

    const next = [first[0], text('b', 'There')];
    rerender({ list: next });
    expect(result.current).toBe(next);
  });

  it('lands at once when two rows change together', () => {
    const first = [text('a', 'Hi'), text('b', 'There')];
    const { result, rerender } = renderHook(({ list }) => useCoalescedMessages(list), {
      initialProps: { list: first },
    });

    const next = [text('a', 'Hi!'), text('b', 'There!')];
    rerender({ list: next });
    expect(result.current).toBe(next);
  });
});
