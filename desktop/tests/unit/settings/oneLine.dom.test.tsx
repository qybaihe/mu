/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The sentence under a setting is one line. A long one ran to three lines under a single switch (the board's said what
 * it is, what it costs and when it runs); now the line is cut, the whole sentence is its tooltip, and "Learn more"
 * opens the rest. A sentence that fits has nothing to open.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import OneLine from '@/renderer/components/settings/OneLine';

const LONG =
  'The plain-language board uses it to tell the progress in everyday words. Only you see it, it never enters the ' +
  'conversation, and it is called once each time the board is updated.';

describe('a setting’s sentence on one line', () => {
  afterEach(() => cleanup());

  it('cuts a long sentence, keeps the whole of it as the tooltip, and opens and closes the rest', () => {
    render(<OneLine text={LONG} />);
    const text = screen.getByText(LONG);
    expect(text).toHaveAttribute('title', LONG);
    const more = screen.getByRole('button', { name: 'settings.learnMore' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    expect(screen.getByText(LONG)).not.toHaveAttribute('title');
    const less = screen.getByRole('button', { name: 'settings.showLess' });
    expect(less).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(less);
    expect(screen.getByText(LONG)).toHaveAttribute('title', LONG);
  });

  it('has nothing to open when the sentence fits, and draws nothing for no sentence', () => {
    const { container } = render(<OneLine text='Start mu when the computer starts.' />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    cleanup();
    render(<OneLine text='' />);
    expect(container.textContent).toBe('');
  });
});
