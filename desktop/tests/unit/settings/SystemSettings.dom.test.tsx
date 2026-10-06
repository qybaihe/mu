/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import SystemSettings from '@/renderer/pages/settings/SystemSettings';
import AboutSettings from '@/renderer/pages/settings/SystemSettings/AboutSettings';
import BrowserSettings from '@/renderer/pages/settings/SystemSettings/BrowserSettings';
import ConversationSettings from '@/renderer/pages/settings/SystemSettings/ConversationSettings';
import DeveloperSettings from '@/renderer/pages/settings/SystemSettings/DeveloperSettings';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/renderer/components/settings/SettingsModal/contents/SystemModalContent', () => ({
  default: () => <div data-testid='system-modal-content'>SystemModalContent</div>,
}));
vi.mock('@/renderer/components/settings/SettingsModal/contents/SystemModalContent/ConversationPreferences', () => ({
  default: () => <div data-testid='conversation-preferences' />,
}));
vi.mock('@/renderer/components/settings/SettingsModal/contents/SystemModalContent/BrowserDataSection', () => ({
  default: () => <div data-testid='browser-data-section' />,
}));
vi.mock('@/renderer/components/settings/SettingsModal/contents/SystemModalContent/DevSettings', () => ({
  default: () => <div data-testid='dev-settings' />,
}));
vi.mock('@/renderer/components/settings/SettingsModal/contents/AboutModalContent', () => ({
  default: () => <div data-testid='about-modal-content'>AboutModalContent</div>,
}));

vi.mock('@/renderer/pages/settings/components/SettingsPageWrapper', () => ({
  default: ({ children, contentClassName }: { children: React.ReactNode; contentClassName?: string }) => (
    <div data-testid='settings-page-wrapper' {...(contentClassName ? { 'data-content-class': contentClassName } : {})}>
      {children}
    </div>
  ),
}));

describe('the pages that were one long system page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Every settings page has the one header: its title, and one line on what the page holds.
  it.each([
    ['system', SystemSettings, 'settings.system', 'settings.systemDescription', 'system-modal-content'],
    [
      'conversations',
      ConversationSettings,
      'settings.conversations',
      'settings.conversationsDescription',
      'conversation-preferences',
    ],
    [
      'in-app browser',
      BrowserSettings,
      'settings.browserData.title',
      'settings.browserData.description',
      'browser-data-section',
    ],
    ['about', AboutSettings, 'settings.about', 'settings.aboutDescription', 'about-modal-content'],
    [
      'developer tools',
      DeveloperSettings,
      'settings.developer.title',
      'settings.developer.description',
      'dev-settings',
    ],
  ])(
    'gives the %s its own page, titled and described, in the page frame with no width of its own',
    (_name, Page, title, description, content) => {
      render(<Page />);
      const wrapper = screen.getByTestId('settings-page-wrapper');
      expect(wrapper).not.toHaveAttribute('data-content-class');
      expect(within(wrapper).getByRole('heading', { name: title })).toBeInTheDocument();
      expect(within(wrapper).getByText(description)).toBeInTheDocument();
      expect(within(wrapper).getByTestId(content)).toBeInTheDocument();
    }
  );

  it('offers to import Claude Code and Codex conversations below the conversation rows, and looks for none until asked', () => {
    render(<ConversationSettings />);
    const row = screen.getByTestId('import-chats');
    expect(within(row).getByText('mu.importChats.title')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'mu.importChats.open' })).toBeInTheDocument();
    expect(screen.queryByText('mu.importChats.dialog.title')).not.toBeInTheDocument();
  });

  it('keeps About and the conversation rows off the system page: they are pages of their own now', () => {
    render(<SystemSettings />);
    expect(screen.getByTestId('system-modal-content')).toBeInTheDocument();
    expect(screen.queryByTestId('about-modal-content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('conversation-preferences')).not.toBeInTheDocument();
  });
});
