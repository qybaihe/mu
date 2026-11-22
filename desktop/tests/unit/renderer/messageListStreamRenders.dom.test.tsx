/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What a streamed chunk costs the transcript. A reply arrives a few characters at a time; if every chunk redraws
 * every row, a long conversation gets slower the longer it runs. These are the two numbers that matter: how often a
 * row that did not change is redrawn while another row streams, and how many redraws a burst of chunks costs.
 */

import React, { type PropsWithChildren } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMessageAcpToolCall, IMessageText, IMessageThinking, TMessage } from '@/common/chat/chatLib';
import {
  MessageListLoadingProvider,
  MessageListProvider,
  MessagePaginationProvider,
  useUpdateMessageList,
} from '@/renderer/pages/conversation/Messages/hooks';
import MessageList from '@/renderer/pages/conversation/Messages/MessageList';

const renders = { tools: 0, text: 0, thinking: 0 };

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US' },
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ key: 'location-key', state: {} }),
}));

vi.mock('@/renderer/hooks/context/ConversationContext', () => ({
  useConversationContextSafe: () => ({ conversation_id: 'conversation-1', type: 'acp' }),
}));

vi.mock('@/renderer/pages/conversation/runtime/useConversationRuntimeView', () => ({
  useConversationRuntimeView: () => ({ isProcessing: true, hydrated: true }),
}));

vi.mock('@/renderer/pages/conversation/Messages/artifacts', () => ({
  useConversationArtifacts: () => [],
}));

vi.mock('@/renderer/pages/conversation/Messages/components/MessageText', () => ({
  default: ({ message }: { message: IMessageText }) => {
    // Only the row that is streaming is counted; the reader's own message is a row like any other.
    if (message.id === 'reply-1') renders.text += 1;
    return <div data-testid={message.id === 'reply-1' ? 'text-row' : 'other-row'}>{message.content.content}</div>;
  },
}));

vi.mock('@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary', () => ({
  default: React.memo(({ messages }: { messages: TMessage[] }) => {
    renders.tools += 1;
    return <div data-testid='tool-row'>{messages.length}</div>;
  }),
}));

vi.mock('@/renderer/pages/conversation/Messages/components/MessageThinking', () => ({
  __esModule: true,
  default: () => <div>thinking</div>,
  ThoughtHistory: React.memo(({ messages }: { messages: IMessageThinking[] }) => {
    renders.thinking += 1;
    return <div data-testid='thinking-row'>{messages.length}</div>;
  }),
}));

vi.mock('@/renderer/pages/conversation/Messages/components/MessageTips', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageToolCall', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageToolGroup', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageAgentStatus', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/components/MessagePermission', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/acp/MessageAcpPermission', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/acp/MessageAcpToolCall', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/acp/MessageAcpTerminalOutput', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/MessageQuestion', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageCronTrigger', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageSkillSuggest', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/components/SelectionReplyButton', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/anchorRail', () => ({ MessageAnchorRail: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/MessageFileChanges', () => ({
  __esModule: true,
  default: () => null,
  parseDiff: vi.fn(),
}));
vi.mock('@arco-design/web-react', () => ({
  Image: { PreviewGroup: ({ children }: PropsWithChildren) => <>{children}</> },
  Dropdown: ({ children, droplist }: { children?: React.ReactNode; droplist?: React.ReactNode }) => (
    <>
      {children}
      {droplist}
    </>
  ),
  Menu: (() => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- the vi.mock factory must stay self-contained (hoisting forbids outer refs)
    const MenuMock = ({ children }: PropsWithChildren) => <>{children}</>;
    MenuMock.Item = ({ children }: PropsWithChildren) => <>{children}</>;
    return MenuMock;
  })(),
  Message: { success: () => {}, error: () => {} },
}));
vi.mock('@icon-park/react', () => ({ Down: () => <span>down</span> }));

const text = (id: string, position: 'left' | 'right', content: string, created_at: number): IMessageText => ({
  id,
  msg_id: id,
  conversation_id: 'conversation-1',
  type: 'text',
  position,
  created_at,
  content: { content },
});

const tool = (id: string, created_at: number): IMessageAcpToolCall =>
  ({
    id,
    msg_id: id,
    conversation_id: 'conversation-1',
    type: 'acp_tool_call',
    position: 'left',
    created_at,
    content: {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        tool_call_id: id,
        status: 'completed',
        title: 'bash',
        kind: 'execute',
      },
    },
  }) as IMessageAcpToolCall;

const thought = (id: string, created_at: number): IMessageThinking => ({
  id,
  msg_id: id,
  conversation_id: 'conversation-1',
  type: 'thinking',
  position: 'left',
  created_at,
  content: { content: 'weighing the options', status: 'done', duration: 2_000 },
});

let replaceMessages: (messages: TMessage[]) => void = () => {};
function ListDriver(): null {
  const updateMessages = useUpdateMessageList();
  replaceMessages = (messages) => updateMessages(messages);
  return null;
}

function Wrapper({ children, messages }: PropsWithChildren<{ messages: TMessage[] }>): JSX.Element {
  return (
    <MessageListLoadingProvider value={false}>
      <MessagePaginationProvider
        value={{ hasMoreBefore: false, hasMoreAfter: false, isLoadingBefore: false, isLoadingAnchor: false }}
      >
        <MessageListProvider value={messages}>{children}</MessageListProvider>
      </MessagePaginationProvider>
    </MessageListLoadingProvider>
  );
}

/**
 * A turn that already ran two tools and thought once, and is now streaming its reply. The rows behind the reply are
 * the same objects on every chunk, exactly as the store hands them over: only the streamed row is replaced.
 */
const settledRows: TMessage[] = [
  text('user-1', 'right', 'go', 1),
  tool('tool-1', 2),
  tool('tool-2', 3),
  thought('thought-1', 4),
];
const turn = (reply: string): TMessage[] => [...settledRows, text('reply-1', 'left', reply, 5)];

const CHUNKS = 200;
const chunk = (index: number): string => 'word '.repeat(index + 1);

describe('what a streamed chunk redraws', () => {
  beforeEach(() => {
    renders.tools = 0;
    renders.text = 0;
    renders.thinking = 0;
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(0), 16)
    );
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => window.clearTimeout(handle));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('leaves the rows that did not change alone while a reply streams', () => {
    render(
      <Wrapper messages={turn(chunk(0))}>
        <MessageList />
        <ListDriver />
      </Wrapper>
    );
    expect(screen.getByTestId('tool-row')).toBeInTheDocument();
    expect(screen.getByTestId('thinking-row')).toBeInTheDocument();

    const settled = { tools: renders.tools, thinking: renders.thinking };
    for (let index = 1; index < CHUNKS; index++) {
      act(() => {
        replaceMessages(turn(chunk(index)));
        vi.advanceTimersByTime(20);
      });
    }

    // eslint-disable-next-line no-console
    console.log(
      `[render-count] ${CHUNKS} chunks, one frame apart → tools ${renders.tools - settled.tools}, ` +
        `thinking ${renders.thinking - settled.thinking}, streaming row ${renders.text}`
    );
    expect(renders.tools - settled.tools).toBe(0);
    expect(renders.thinking - settled.thinking).toBe(0);
    expect(screen.getByTestId('text-row')).toHaveTextContent('word');
  });

  it('draws once for a burst of chunks that arrive inside one frame', () => {
    render(
      <Wrapper messages={turn(chunk(0))}>
        <MessageList />
        <ListDriver />
      </Wrapper>
    );

    const before = renders.text;
    // Each chunk is its own delivery, as it is off the wire — but all of them land inside one frame.
    for (let index = 1; index < CHUNKS; index++) {
      act(() => {
        replaceMessages(turn(chunk(index)));
      });
    }
    act(() => {
      vi.advanceTimersByTime(20);
    });

    // eslint-disable-next-line no-console
    console.log(`[render-count] ${CHUNKS} chunks in one frame → streaming row ${renders.text - before}`);
    expect(renders.text - before).toBe(1);
    expect(screen.getByTestId('text-row')).toHaveTextContent('word word');
  });
});
