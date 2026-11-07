/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMessageThinking } from '@/common/chat/chatLib';
import MessageThinking, {
  THOUGHT_TAIL_CHARS,
  ThoughtHistory,
  thoughtTail,
} from '@/renderer/pages/conversation/Messages/components/MessageThinking';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string } & Record<string, unknown>) => {
      const templates: Record<string, string> = {
        'conversation.thinking.labelWithTime': '{{label}} · {{time}}',
        'conversation.thinking.completeWithTime': 'Thought complete · {{time}}',
        'conversation.thinking.thoughtFor': 'Thought for {{time}}',
      };
      const template = templates[key] ?? options?.defaultValue ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
        options && name in options ? String(options[name]) : match
      );
    },
  }),
}));

function createThinkingMessage(createdAt: number, status: 'thinking' | 'done' = 'thinking'): IMessageThinking {
  return {
    id: 'thinking-1',
    type: 'thinking',
    msg_id: 'msg-1',
    conversation_id: 'conversation-1',
    position: 'left',
    created_at: createdAt,
    content: {
      content: 'analyzing',
      status,
    },
  };
}

describe('MessageThinking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves elapsed time when the component remounts for an active thinking message', () => {
    vi.setSystemTime(new Date('2026-05-26T09:00:10.000Z'));
    const createdAt = Date.now() - 5_000;

    const { unmount } = render(<MessageThinking message={createThinkingMessage(createdAt)} />);

    expect(screen.getByText('Thinking... · 5s')).toBeInTheDocument();

    unmount();

    vi.setSystemTime(new Date('2026-05-26T09:00:12.000Z'));
    render(<MessageThinking message={createThinkingMessage(createdAt)} />);

    expect(screen.getByText('Thinking... · 7s')).toBeInTheDocument();
  });

  it('keeps a completed thought body collapsed until its history is opened', () => {
    render(<MessageThinking message={createThinkingMessage(Date.now(), 'done')} />);

    expect(screen.getByText('Thinking history')).toBeInTheDocument();
    expect(screen.queryByText('Thought complete · 0s')).not.toBeInTheDocument();
    expect(screen.queryByText('analyzing')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /thinking history/i }));

    expect(screen.getByText('Thought complete · 0s')).toBeInTheDocument();
    expect(screen.getByText('analyzing')).toBeInTheDocument();
  });

  it('streams a live thought as one quiet line until the reader opens it', () => {
    const { container } = render(<MessageThinking message={createThinkingMessage(Date.now())} active />);

    expect(screen.getByTestId('thinking-active')).toBeInTheDocument();
    expect(container.querySelector('.arco-spin')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Thinking\.\.\./ })).toHaveAttribute('aria-expanded', 'false');
    // The thought itself streams under the header, muted, without opening anything.
    expect(screen.getByTestId('thinking-stream')).toHaveTextContent('analyzing');

    fireEvent.click(screen.getByRole('button', { name: /Thinking\.\.\./ }));

    // Open, the whole thought stands on its own and the running line steps aside.
    expect(screen.queryByTestId('thinking-stream')).not.toBeInTheDocument();
    expect(screen.getByText('analyzing')).toBeInTheDocument();
  });

  it('keeps the live line to the newest words, whatever the thought grows to', () => {
    const long = `${'first words that scrolled away. '.repeat(20)}the newest sentence.`;
    render(
      <MessageThinking
        message={{ ...createThinkingMessage(Date.now()), content: { content: long, status: 'thinking' } }}
        active
      />
    );

    const stream = screen.getByTestId('thinking-stream');
    expect(stream).toHaveTextContent('the newest sentence.');
    expect(stream.textContent?.startsWith('…')).toBe(true);
    expect(stream.textContent!.length).toBeLessThanOrEqual(THOUGHT_TAIL_CHARS + 1);

    const multiKilobyte = `${'reasoning step\n\n'.repeat(400)}final check   before   answering\n`;
    expect(thoughtTail(multiKilobyte, 40)).toBe('…step final check before answering');
  });

  it('folds to one line saying how long it thought, once the thought is no longer live', () => {
    render(
      <MessageThinking
        message={{
          ...createThinkingMessage(Date.now(), 'done'),
          content: { content: 'analyzing', status: 'done', duration: 12_000 },
        }}
        active={false}
      />
    );

    expect(screen.getByRole('button', { name: 'Thought for 12s' })).toBeInTheDocument();
    expect(screen.queryByTestId('thinking-stream')).not.toBeInTheDocument();
    expect(screen.queryByText('analyzing')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Thought for 12s' }));
    expect(screen.getByText('analyzing')).toBeInTheDocument();
  });

  it('keeps the body open when the thought completes under the reader', () => {
    const createdAt = Date.now();
    const { rerender } = render(<MessageThinking message={createThinkingMessage(createdAt)} active />);
    fireEvent.click(screen.getByRole('button', { name: /Thinking\.\.\./ }));

    rerender(
      <MessageThinking
        message={{
          ...createThinkingMessage(createdAt, 'done'),
          content: { content: 'analyzing', status: 'done', duration: 3_000 },
        }}
        active={false}
      />
    );

    // No auto-collapse: what was being read stays where it is, now as a finished record.
    expect(screen.getByText('analyzing')).toBeInTheDocument();
    expect(screen.getByText('Thought complete · 3s')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Thought for 3s' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByText(/Thinking\.\.\./)).not.toBeInTheDocument();
  });

  it('does not present a leftover thinking status as live work', () => {
    vi.setSystemTime(new Date('2026-05-26T09:00:10.000Z'));
    const { container } = render(
      <MessageThinking message={createThinkingMessage(Date.now() - 3_600_000)} active={false} />
    );

    // Cancelled or reloaded: the status never completed, but no spinner, label or running clock.
    expect(screen.getByTestId('thinking-record')).toBeInTheDocument();
    expect(container.querySelector('.arco-spin')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Thinking history' })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByRole('button', { name: 'Thinking history' })).toBeInTheDocument();
    expect(screen.queryByText(/Thinking\.\.\./)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Thinking history' }));
    expect(screen.getByText('analyzing')).toBeInTheDocument();
    expect(screen.queryByText(/Thought complete/)).not.toBeInTheDocument();
  });

  it('lets the list own the disclosure and reports which thought was toggled', () => {
    const onExpandedChange = vi.fn();
    const message = createThinkingMessage(Date.now());
    const { rerender } = render(
      <MessageThinking message={message} active expanded={false} onExpandedChange={onExpandedChange} />
    );

    fireEvent.click(screen.getByRole('button', { name: /Thinking\.\.\./ }));
    expect(onExpandedChange).toHaveBeenCalledWith('thinking-1', true);
    // Controlled: nothing opens until the owner says so — only the running line shows the thought.
    expect(screen.getByTestId('thinking-stream')).toBeInTheDocument();

    rerender(<MessageThinking message={message} active expanded onExpandedChange={onExpandedChange} />);
    expect(screen.getByText('analyzing')).toBeInTheDocument();
    expect(screen.queryByTestId('thinking-stream')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Thinking\.\.\./ }));
    expect(onExpandedChange).toHaveBeenLastCalledWith('thinking-1', false);
  });

  it('lists an unfinished thought in the history without calling it live', () => {
    render(
      <ThoughtHistory
        messages={[
          {
            ...createThinkingMessage(Date.now() - 2_000, 'done'),
            id: 'thought-1',
            content: { content: 'first', status: 'done', duration: 1_000 },
          },
          {
            ...createThinkingMessage(Date.now() - 1_000),
            id: 'thought-2',
            content: { content: 'cut short', status: 'thinking' },
          },
        ]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Thought for 1s' }));

    expect(screen.getByText('cut short')).toBeInTheDocument();
    expect(screen.getAllByText(/Thought complete/)).toHaveLength(1);
    expect(screen.queryByText(/Thinking\.\.\./)).not.toBeInTheDocument();
  });

  it('keeps all completed thought bodies in one disclosure', () => {
    render(
      <ThoughtHistory
        messages={[
          {
            ...createThinkingMessage(Date.now() - 2_000, 'done'),
            id: 'thought-1',
            content: { content: 'first', status: 'done', duration: 1_000 },
          },
          {
            ...createThinkingMessage(Date.now() - 1_000, 'done'),
            id: 'thought-2',
            content: { content: 'second', status: 'done', duration: 500 },
          },
        ]}
      />
    );

    // One line for the whole run, saying how long it took altogether.
    expect(screen.getAllByText('Thought for 1s')).toHaveLength(1);
    expect(screen.queryByText('first')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Thought for 1s' }));

    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
    expect(screen.getAllByText(/Thought complete/)).toHaveLength(2);
  });
});
