/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * AskMuButton — the "Ask mu about this" chip on a conversation's errors. Clicking it must open a new mu conversation
 * on the home page, with no assistant picked and a message quoting the error ready to send.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'conversation.askMu.prompt') {
        return `diagnose:${String(options?.error)}`;
      }
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

const navigateMock = vi.fn();
vi.mock('@/renderer/utils/navigation', () => ({
  globalNavigate: (...args: unknown[]) => navigateMock(...args),
}));

import AskMuButton from '@/renderer/components/base/AskMuButton';

describe('AskMuButton', () => {
  beforeEach(() => {
    navigateMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the Ask mu label', () => {
    render(<AskMuButton errorText='boom' />);
    expect(screen.getByText('conversation.askMu.label')).toBeInTheDocument();
  });

  it('opens a new conversation on the home page with the error in the message', async () => {
    const user = userEvent.setup();
    render(<AskMuButton errorText='  connection reset  ' />);
    await user.click(screen.getByText('conversation.askMu.label'));

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/guid', {
      state: { resetAssistant: true, prefillPrompt: 'diagnose:connection reset', focusPrefill: true },
    });
  });

  it('stops click propagation so the surrounding bubble does not react', async () => {
    const user = userEvent.setup();
    const outerClick = vi.fn();
    render(
      <div onClick={outerClick}>
        <AskMuButton errorText='boom' />
      </div>
    );
    await user.click(screen.getByText('conversation.askMu.label'));
    expect(outerClick).not.toHaveBeenCalled();
  });
});
