/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The sidebar is three ways in and two things in the footer. Anything that used to have a row of
 * its own — assistants, the team section, signing out — is gone from here; the settings hold it.
 * Search is the command palette, which the sidebar keeps mounted on every page.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.fn();
const setTheme = vi.fn();
const toggleCommandPalette = vi.fn();
let pathname = '/guid';
let theme = 'light';
let nativeOn = false;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useLocation: () => ({ pathname, search: '', hash: '' }),
}));

vi.mock('@renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  usePreviewContext: () => ({ closePreview: () => {}, clearPreviewForScope: () => {} }),
}));
vi.mock('@renderer/utils/ui/siderTooltip', () => ({
  cleanupSiderTooltips: () => {},
  getSiderTooltipProps: () => ({ disabled: true }),
}));
vi.mock('@renderer/utils/ui/focus', () => ({ blurActiveElement: () => {} }));
vi.mock('@renderer/hooks/context/LayoutContext', () => ({ useLayoutContext: () => ({ isMobile: false }) }));
vi.mock('@renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({ theme, setTheme }),
}));
vi.mock('@renderer/pages/conversation/GroupedHistory', () => ({
  default: ({ hideEmptyState }: { hideEmptyState?: boolean }) => (
    <div data-testid='history' data-hide-empty={String(hideEmptyState === true)} />
  ),
}));
vi.mock('@renderer/pages/native/components/NativeSiderGroup', () => ({ default: () => null }));
vi.mock('@renderer/pages/native/hooks/useNativeConversations', () => ({ useNativeEnabled: () => nativeOn }));
vi.mock('@renderer/components/layout/Sider/CommandPalette', () => ({
  default: () => <div data-testid='command-palette-host' />,
  toggleCommandPalette: () => toggleCommandPalette(),
}));
import Sider from '@renderer/components/layout/Sider';

const renderSider = () => render(<Sider />);

describe('sidebar entries', () => {
  beforeEach(() => {
    navigate.mockClear();
    setTheme.mockClear();
    toggleCommandPalette.mockClear();
    pathname = '/guid';
    theme = 'light';
    nativeOn = false;
  });

  afterEach(() => cleanup());

  it('offers three ways in and nothing else above the conversations', () => {
    renderSider();
    expect(screen.getByText('conversation.welcome.newConversation')).toBeInTheDocument();
    expect(screen.getByTestId('sider-search')).toBeInTheDocument();
    expect(screen.getByText('cron.scheduledTasks')).toBeInTheDocument();
    // What left the sidebar: assistants, the team section, signing out.
    expect(screen.queryByText('settings.assistants')).not.toBeInTheDocument();
    expect(screen.queryByText('team.title')).not.toBeInTheDocument();
    expect(screen.queryByText('settings.googleLogout')).not.toBeInTheDocument();
  });

  it('collapsed on the desktop, is a rail of its ways in and its footer, without the conversations', () => {
    render(<Sider collapsed />);
    for (const id of ['sider-new-chat', 'sider-search', 'sider-scheduled', 'sider-settings', 'theme-toggle'])
      expect(screen.getByTestId(id)).toBeInTheDocument();
    // Each icon keeps a name for whoever cannot see its tooltip.
    expect(screen.getByTestId('sider-new-chat')).toHaveAttribute('aria-label', 'conversation.welcome.newConversation');
    expect(screen.getByTestId('sider-settings')).toHaveAttribute('aria-label', 'common.settings');
    expect(screen.queryByTestId('history')).not.toBeInTheDocument();
  });

  it('leaves the history list its placeholder, unless the native host is on and its group speaks for the list', async () => {
    renderSider();
    expect(await screen.findByTestId('history')).toHaveAttribute('data-hide-empty', 'false');
    cleanup();
    nativeOn = true;
    renderSider();
    expect(await screen.findByTestId('history')).toHaveAttribute('data-hide-empty', 'true');
  });

  it('keeps search in the sidebar on the desktop, not only on a phone', () => {
    renderSider();
    expect(screen.getByTestId('sider-search')).toBeInTheDocument();
  });

  it('has a footer of exactly two things: the settings and the theme', () => {
    renderSider();
    expect(screen.getByTestId('sider-settings')).toHaveTextContent('common.settings');
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
  });

  it('opens the settings on the providers, the first page of the models group', () => {
    renderSider();
    fireEvent.click(screen.getByTestId('sider-settings'));
    expect(navigate).toHaveBeenCalledWith('/settings/providers');
  });

  it('turns the footer button into a way back out while in the settings', () => {
    pathname = '/settings/judges';
    renderSider();
    expect(screen.getByTestId('sider-settings')).toHaveTextContent('common.back');
    // A plain row with its icon: filled, it would look like a second selected page beside the settings rail's.
    expect(screen.getByTestId('sider-settings').className.split(/\s+/)).not.toContain('bg-fill-2');
    // The conversations give way to the settings navigation, which loads on its own.
    expect(screen.queryByTestId('history')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('sider-settings'));
    expect(navigate).toHaveBeenCalledWith('/guid');
  });

  it('switches the theme from the footer wherever you are', () => {
    renderSider();
    fireEvent.click(screen.getByTestId('theme-toggle'));
    expect(setTheme).toHaveBeenCalledWith('dark');
  });

  it('goes to the scheduled tasks from the third row', () => {
    renderSider();
    fireEvent.click(screen.getByText('cron.scheduledTasks'));
    expect(navigate).toHaveBeenCalledWith('/scheduled');
  });

  it('opens the command palette from the search row', () => {
    renderSider();
    fireEvent.click(screen.getByTestId('sider-search'));
    expect(toggleCommandPalette).toHaveBeenCalledTimes(1);
  });

  it('shows the palette shortcut next to the search row', () => {
    renderSider();
    expect(screen.getByTestId('sider-search')).toHaveTextContent(/(⌘|Ctrl\+)K/);
  });

  it('reaches every row with Tab, in the order they are shown, search included', async () => {
    const user = userEvent.setup();
    renderSider();
    /** Press Tab once and say which row has the focus now. */
    const tab = async () => {
      await user.tab();
      return document.activeElement?.getAttribute('data-testid');
    };

    expect(await tab()).toBe('sider-new-chat');
    expect(await tab()).toBe('sider-batch-mode');
    expect(await tab()).toBe('sider-search');
    expect(await tab()).toBe('sider-scheduled');
    expect(await tab()).toBe('sider-settings');
    expect(await tab()).toBe('theme-toggle');
  });

  it('presses a row with Enter or Space, as a click would, and ignores other keys', () => {
    renderSider();
    const search = screen.getByTestId('sider-search');
    expect(search).toHaveAttribute('role', 'button');

    fireEvent.keyDown(search, { key: 'Enter' });
    expect(toggleCommandPalette).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(search, { key: ' ' });
    expect(toggleCommandPalette).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(search, { key: 'a' });
    expect(toggleCommandPalette).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(screen.getByTestId('sider-scheduled'), { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith('/scheduled');
    fireEvent.keyDown(screen.getByTestId('theme-toggle'), { key: ' ' });
    expect(setTheme).toHaveBeenCalledWith('dark');
  });

  it('keeps the palette mounted in the settings, where the search row gives way', () => {
    pathname = '/settings/kernel';
    renderSider();
    expect(screen.queryByTestId('sider-search')).not.toBeInTheDocument();
    expect(screen.getByTestId('command-palette-host')).toBeInTheDocument();
  });
});
