/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { IMessageTips } from '@/common/chat/chatLib';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import zhCommon from '@/renderer/services/i18n/locales/zh-CN/common.json';
import zhMu from '@/renderer/services/i18n/locales/zh-CN/mu.json';

// The first message after setup could fail with pi's "No API key found … Use /login … See: …/providers.md". The
// conversation says instead that there is no model yet, and leads to the providers' settings.

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('@renderer/components/chat/CollapsibleContent', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@renderer/components/Markdown', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@renderer/components/base/AskMuButton', () => ({
  default: () => <div data-testid='ask-mu-chip' />,
}));

import MessageTips from '@/renderer/pages/conversation/Messages/components/MessageTips';

afterEach(() => {
  cleanup();
  navigate.mockClear();
});

const PI_WORDS =
  'No API key found for anthropic.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /opt/mu/docs/providers.md';

const tip = (content: IMessageTips['content']): IMessageTips =>
  ({ id: 'tip-1', msg_id: 'tip-1', conversation_id: 'c', type: 'tips', position: 'center', content }) as IMessageTips;

const show = (lng: 'en' | 'zh', message: IMessageTips) => {
  const i18n = createInstance();
  void i18n.init({
    lng,
    initImmediate: false,
    resources: {
      en: { translation: { common: enCommon, mu: enMu } },
      zh: { translation: { common: zhCommon, mu: zhMu } },
    },
    interpolation: { escapeValue: false },
  });
  return render(
    <I18nextProvider i18n={i18n}>
      <MessageTips message={message} />
    </I18nextProvider>
  );
};

describe('a conversation without a model', () => {
  it('says so in the app’s words, names the provider pi named, and opens the providers’ settings', () => {
    show(
      'en',
      tip({
        type: 'error',
        content: 'Agent internal error',
        error: { message: `mu has no model to answer with: ${PI_WORDS}` },
      } as IMessageTips['content'])
    );
    const card = screen.getByTestId('mu-no-model');
    expect(card).toHaveTextContent(enMu.noModel.title);
    expect(card).toHaveTextContent(
      enMu.noModel.body.replace('{{place}}', `${enCommon.settings} › ${enMu.sections.providers}`)
    );
    expect(card).toHaveTextContent('No API key found for anthropic.');
    // Nothing a desktop user cannot act on: no terminal command, no harness doc, no Ask mu chip.
    expect(card).not.toHaveTextContent('/login');
    expect(card).not.toHaveTextContent('providers.md');
    expect(screen.queryByTestId('ask-mu-chip')).toBeNull();
    const open = screen.getByTestId('mu-no-model-open');
    expect(open).toHaveTextContent(enMu.noModel.open.replace('{{page}}', enMu.sections.providers));
    fireEvent.click(open);
    expect(navigate).toHaveBeenCalledWith('/settings/providers');
  });

  it('reads pi’s own words in a conversation stored before the bridge named them, in Chinese too', () => {
    show('zh', tip({ type: 'error', content: `Model request failed: ${PI_WORDS}` } as IMessageTips['content']));
    const card = screen.getByTestId('mu-no-model');
    expect(card).toHaveTextContent(zhMu.noModel.title);
    expect(card).toHaveTextContent(`「${zhCommon.settings} › ${zhMu.sections.providers}」`);
    expect(card).not.toHaveTextContent('/login');
    expect(screen.getByTestId('mu-no-model-open')).toHaveTextContent(`打开${zhMu.sections.providers}`);
  });

  it('leaves any other failed request as it was', () => {
    show('en', tip({ type: 'error', content: 'Model request failed: 429 rate limited' } as IMessageTips['content']));
    expect(screen.queryByTestId('mu-no-model')).toBeNull();
    expect(screen.getByTestId('ask-mu-chip')).toBeInTheDocument();
  });
});
