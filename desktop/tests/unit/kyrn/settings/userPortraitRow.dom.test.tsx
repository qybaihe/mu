/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import UserPortraitRow from '@/renderer/pages/settings/KyrnSettings/sections/UserPortraitRow';

/**
 * The settings entry of the user portrait: the row on the team details page
 * that reads `_shared/USER.md` into a modal text area and saves it whole
 * through the supervisor bridge. The main process's watch-and-rebuild lives
 * behind the bridge; here only the read-fail and save paths are the
 * component's own.
 */

const portrait = vi.hoisted(() => ({ text: '# 用户画像\n\n- 称呼：老林\n', fail: false, saved: '' }));
vi.mock('@/common/chat/team/supervisor/supervisorBridge', () => ({
  supervisorBridge: {
    userPortrait: {
      invoke: vi.fn(async () => (portrait.fail ? { ok: false } : { ok: true, data: { portrait: portrait.text } })),
    },
    saveUserPortrait: {
      invoke: vi.fn(async ({ content }: { content: string }) => {
        portrait.saved = content;
        return { ok: true };
      }),
    },
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
// Arco's Message renders into document.body through a legacy ReactDOM call that
// breaks under React 19 in jsdom; the component only shows it, the tests do not need it.
vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return { ...actual, Message: { ...actual.Message, success: () => {}, error: () => {} } };
});
vi.mock('@/renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({ theme: 'light' }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

afterEach(() => {
  cleanup();
  portrait.fail = false;
  portrait.saved = '';
});

const edit = () => screen.getByTestId('mu-user-portrait-edit');

describe('UserPortraitRow', () => {
  it('loads the portrait into the modal and saves the edited text whole', async () => {
    render(<UserPortraitRow />);
    fireEvent.click(edit());
    const area = await screen.findByTestId('mu-user-portrait-modal');
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('# 用户画像\n\n- 称呼：老林\n'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '# 用户画像\n\n- 称呼：老板\n' } });
    fireEvent.click(screen.getByTestId('mu-user-portrait-save'));
    await waitFor(() => expect(portrait.saved).toBe('# 用户画像\n\n- 称呼：老板\n'));
    expect(area).toBeTruthy();
  });

  it('still opens on a failed read: an empty editor beats a dead end', async () => {
    portrait.fail = true;
    render(<UserPortraitRow />);
    fireEvent.click(edit());
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));
  });
});
