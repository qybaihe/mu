import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { IMessageAcpToolCall } from '@/common/chat/chatLib';
import MessageTeachingCard from '@/renderer/pages/conversation/Messages/acp/MessageTeachingCard';
import { teachingCard } from '@/renderer/pages/conversation/Messages/acp/teachingCard';
import zhMu from '@/renderer/services/i18n/locales/zh-CN/mu.json';
import zhCommon from '@/renderer/services/i18n/locales/zh-CN/common.json';

// The teaching card of a turn (`turn.teaching`): a tool call the bridge wrote with a `mu:teaching:` id, folded to one
// row that opens to the writer's why and the options that were ruled out.

afterEach(cleanup);

let created = 0;
const card = (rawInput: Record<string, unknown>, id = `mu:teaching:${++created}`): IMessageAcpToolCall =>
  ({
    id,
    msg_id: id,
    conversation_id: 'conversation-1',
    type: 'acp_tool_call',
    position: 'left',
    created_at: ++created,
    content: {
      session_id: 'session-1',
      update: { sessionUpdate: 'tool_call', tool_call_id: id, status: 'completed', kind: 'execute', rawInput },
    },
  }) as IMessageAcpToolCall;

const INPUT = {
  teaching: 'arch_weighing',
  why: 'The cache invalidates on the store’s writes: two owners would race.',
  ruledOut: ['Inside the store', 'Per-caller caches', 'A third one too many'],
  turn: 'runtime-1:3',
};

const show = (input: Record<string, unknown>) => {
  const i18n = createInstance();
  void i18n.init({
    lng: 'zh',
    resources: {
      zh: { translation: { common: zhCommon, mu: zhMu } },
    },
    interpolation: { escapeValue: false },
  });
  const read = teachingCard(card(input));
  if (!read) throw new Error('not a teaching card');
  return render(
    <I18nextProvider i18n={i18n}>
      <MessageTeachingCard card={read} />
    </I18nextProvider>
  );
};

describe('reading the card from the message', () => {
  it('takes the card the bridge wrote, at most two ruled-out options, and the turn it belongs to', () => {
    expect(teachingCard(card(INPUT))).toEqual({
      kind: 'arch_weighing',
      why: INPUT.why,
      ruledOut: ['Inside the store', 'Per-caller caches'],
      turn: 'runtime-1:3',
    });
  });

  it('shows nothing for another message, an unknown kind, or a card without a why', () => {
    const plain: IMessageAcpToolCall = { ...card(INPUT), type: 'text' } as unknown as IMessageAcpToolCall;
    expect(teachingCard(plain)).toBeUndefined();
    expect(teachingCard(card({ ...INPUT, teaching: 'routine' }))).toBeUndefined();
    expect(teachingCard(card({ ...INPUT, why: '  ' }))).toBeUndefined();
  });
});

describe('the card in the conversation', () => {
  it('is folded to one row by default: the why and the ruled-out options are one click away', () => {
    show(INPUT);
    const row = screen.getByTestId('mu-teaching-card');
    expect(row).toHaveAttribute('data-open', 'false');
    expect(row).toHaveTextContent(zhMu.teaching.folded.arch_weighing);
    expect(row).toHaveTextContent(zhMu.teaching.open);
    expect(screen.queryByTestId('mu-teaching-why')).not.toBeInTheDocument();
    expect(row).not.toHaveTextContent(INPUT.why);
  });

  it('opens on click to the writer’s why and the ruled-out options, and closes again', () => {
    show(INPUT);
    fireEvent.click(screen.getByTestId('mu-teaching-fold'));
    const open = screen.getByTestId('mu-teaching-card');
    expect(open).toHaveAttribute('data-open', 'true');
    expect(screen.getByTestId('mu-teaching-why')).toHaveTextContent(INPUT.why);
    expect(screen.getByTestId('mu-teaching-why')).toHaveTextContent('Inside the store');
    expect(screen.getByTestId('mu-teaching-why')).toHaveTextContent(zhMu.teaching.ruledOut.trim());
    // A third option never made it in: the reader keeps at most two.
    expect(screen.getByTestId('mu-teaching-why')).not.toHaveTextContent('A third one too many');
    fireEvent.click(screen.getByTestId('mu-teaching-fold'));
    expect(screen.getByTestId('mu-teaching-card')).toHaveAttribute('data-open', 'false');
    expect(screen.queryByTestId('mu-teaching-why')).not.toBeInTheDocument();
  });

  it('opens without ruled-out options too: the why stands alone', () => {
    const { ruledOut: _ruled, ...bare } = INPUT;
    show({ ...bare, ruledOut: [] });
    fireEvent.click(screen.getByTestId('mu-teaching-fold'));
    expect(screen.getByTestId('mu-teaching-why')).toHaveTextContent(bare.why);
    expect(screen.getByTestId('mu-teaching-why')).not.toHaveTextContent(zhMu.teaching.ruledOut.trim());
  });
});
