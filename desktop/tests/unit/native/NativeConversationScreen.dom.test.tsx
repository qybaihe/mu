/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The native screen gives its transcript the conversation context: a markdown image in a reply resolves its relative
 * path against the conversation's workspace, read with useConversationContextSafe (LocalImageView). Before the fix
 * only the send box had a provider of its own, so the transcript saw no workspace and a relative image fell back to a
 * broken <img>.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { useConversationContextSafe } from '@/renderer/hooks/context/ConversationContext';
import NativeConversationScreen from '@/renderer/pages/native/components/NativeConversationScreen';

const { stableT } = vi.hoisted(() => ({
  stableT: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: stableT }),
}));

vi.mock('@arco-design/web-react', () => {
  const Button = ({ children }: React.PropsWithChildren) => <button type='button'>{children}</button>;
  return { Button, Message: { error: vi.fn() } };
});

vi.mock('@icon-park/react', () => ({ Attention: () => <svg /> }));

// The transcript is a probe: it reports the conversation context it was drawn with.
vi.mock('@/renderer/pages/conversation/Messages/MessageList', () => ({
  default: () => {
    const context = useConversationContextSafe();
    return (
      <div
        data-testid='transcript'
        data-workspace={context?.workspace ?? ''}
        data-conversation-id={context?.conversation_id ?? ''}
      />
    );
  },
}));

vi.mock('@/renderer/pages/native/components/NativeHeader', () => ({ default: () => <div /> }));
vi.mock('@/renderer/pages/native/components/NativeComposer', () => ({ default: () => <div /> }));
vi.mock('@/renderer/pages/conversation/Preview/browser/muBrowser/MuBrowserHost', () => ({ default: () => <div /> }));
vi.mock('@/renderer/pages/native/hooks/useNativePanel', () => ({ useNativePanel: vi.fn() }));
vi.mock('@/renderer/pages/native/hooks/useNativeAttention', () => ({ clearNativeUnread: vi.fn() }));
vi.mock('@/renderer/pages/native/utils/toMessages', () => ({ createMessageMapper: () => () => [] }));
vi.mock('@/renderer/pages/native/utils/forkPoint', () => ({
  forkableIds: () => undefined,
  rewindPoints: () => new Map<number, number>(),
  forkPoint: () => undefined,
}));
vi.mock('@/renderer/pages/native/utils/statusRow', () => ({ isWorking: () => false }));

const CWD = 'E:\\mu\\research';

const conversation = {
  id: 'c1',
  loading: false,
  conversation: { cwd: CWD, key: 'k' },
  host: {},
  view: { dialogs: [], messages: [] },
  seq: 0,
  epoch: 1,
  waiting: [],
  closed: new Set<string>(),
  settings: {},
  request: async () => ({ ok: true }),
  retry: vi.fn(),
  rename: vi.fn(),
};

vi.mock('@/renderer/pages/native/hooks/useNativeConversation', () => ({
  useNativeConversation: () => conversation,
}));

describe('NativeConversationScreen', () => {
  // https://github.com/qybaihe/mu/issues/416
  it('gives the transcript the conversation workspace', () => {
    render(
      <MemoryRouter>
        <NativeConversationScreen id='c1' />
      </MemoryRouter>
    );
    const transcript = screen.getByTestId('transcript');
    expect(transcript).toHaveAttribute('data-workspace', CWD);
    expect(transcript).toHaveAttribute('data-conversation-id', 'c1');
  });
});
