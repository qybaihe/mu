import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import enMessages from '@/renderer/services/i18n/locales/en-US/messages.json';
import type { MessageAnchorItem } from '@/renderer/pages/conversation/Messages/anchorRail/anchors';
import MessageAnchorRail from '@/renderer/pages/conversation/Messages/anchorRail/MessageAnchorRail';

const anchors: MessageAnchorItem[] = [1, 2, 3].map((index) => ({
  index,
  question: `Question ${index}`,
  answer: `Answer ${index}`,
  messageId: `m${index}`,
}));
vi.mock('@/renderer/pages/conversation/Messages/hooks', () => ({
  useMessageList: () => [],
  useMessageListRun: () => ({ conversationId: 'c1' }),
}));
vi.mock('@/renderer/pages/conversation/Messages/anchorRail/useConversationAnchors', () => ({
  useConversationAnchors: () => anchors,
}));
vi.mock('@/renderer/hooks/context/ConversationContext', () => ({ useConversationContextSafe: () => undefined }));

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en-US',
    resources: { 'en-US': { translation: { messages: enMessages } } },
    interpolation: { escapeValue: false },
  });
});
afterEach(cleanup);

describe('the message anchor rail', () => {
  it('says on its card which message a tick is and that a click jumps there', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <MessageAnchorRail />
      </I18nextProvider>
    );
    expect(screen.queryByTestId('message-anchor-preview')).toBeNull();
    fireEvent.focus(screen.getAllByTestId('message-anchor-tick')[1]);
    const card = screen.getByTestId('message-anchor-preview');
    expect(card).toHaveTextContent('Question 2');
    expect(screen.getByTestId('message-anchor-hint')).toHaveTextContent('Message 2 of 3 · click to jump here');
  });
});
