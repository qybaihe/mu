/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { Message } from '@arco-design/web-react';
import type { IRuntimeStatusEvent } from '@/common/adapter/ipcBridge';
import {
  setCurrentConversation,
  resetCurrentConversationForTest,
} from '@/renderer/pages/conversation/explorer/currentConversationStore';
import { resetCurrentProjectForTest } from '@/renderer/pages/conversation/explorer/currentProjectStore';

// Mirror the project convention: t() echoes the key so labels/tooltips are assertable.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

// react-router-dom: control location, capture navigate.
const navigate = vi.fn();
let currentPathname = '/guid';
const platformMocks = vi.hoisted(() => ({
  isElectronDesktopMock: vi.fn(() => false),
}));
const shortcutMocks = vi.hoisted(() => ({
  params: undefined as undefined | { toggleSider: () => void },
}));
const runtimeMocks = vi.hoisted(() => ({
  deferredFailure: undefined as undefined | ((event: IRuntimeStatusEvent) => void),
}));
const updateMocks = vi.hoisted(() => ({
  open: undefined as undefined | ((event: { source: 'menu' | 'tray' }) => void),
  run: vi.fn(() => Promise.resolve()),
}));
const menuMocks = vi.hoisted(() => ({
  command: undefined as undefined | ((event: { command: 'newChat' | 'openSettings' }) => void),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: currentPathname, search: '', hash: '' }),
  useNavigationType: () => 'POP',
  Outlet: () => null,
}));

// Hidden devtools easter-egg target (icon) — assert it is independent of navigation.
const openDevTools = vi.fn(() => Promise.resolve());
vi.mock('@/common', () => ({
  ipcBridge: {
    application: {
      openDevTools: { invoke: () => openDevTools() },
      logStream: { on: () => () => {} },
      menuCommand: {
        on: (callback: (event: { command: 'newChat' | 'openSettings' }) => void) => {
          menuMocks.command = callback;
          return () => {
            menuMocks.command = undefined;
          };
        },
      },
    },
    task: { stopAll: { invoke: () => Promise.resolve({ success: false }) } },
    update: {
      open: {
        on: (callback: (event: { source: 'menu' | 'tray' }) => void) => {
          updateMocks.open = callback;
          return () => {
            updateMocks.open = undefined;
          };
        },
      },
      run: { invoke: updateMocks.run },
    },
    runtime: {
      deferredFailure: {
        on: (callback: (event: IRuntimeStatusEvent) => void) => {
          runtimeMocks.deferredFailure = callback;
          return () => {
            runtimeMocks.deferredFailure = undefined;
          };
        },
      },
    },
  },
}));

// Trim Layout's collaborators to keep this a focused brand-behaviour test.
vi.mock('@/renderer/components/layout/Titlebar', () => ({ default: () => null }));
vi.mock('@renderer/hooks/system/useDeepLink', () => ({ useDeepLink: () => {} }));
vi.mock('@renderer/hooks/system/notification/useNotificationClick', () => ({ useNotificationClick: () => {} }));
vi.mock('@renderer/hooks/file/useDirectorySelection', () => ({
  useDirectorySelection: () => ({ contextHolder: null }),
}));
vi.mock('@renderer/utils/ui/siderTooltip', () => ({ cleanupSiderTooltips: () => {} }));
vi.mock('@renderer/hooks/ui/useConversationShortcuts', () => ({
  useConversationShortcuts: (params: { toggleSider: () => void }) => {
    shortcutMocks.params = params;
  },
}));
vi.mock('@renderer/utils/platform', () => ({ isElectronDesktop: platformMocks.isElectronDesktopMock }));
vi.mock('@renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({ closePreview: () => {} }),
  PreviewPanel: () => null,
}));
vi.mock('@renderer/components/layout/WorkPanel', () => ({
  default: ({ isMobile }: { rowWidth: number; isMobile: boolean }) => (
    <aside data-testid='work-panel' data-mobile={isMobile} />
  ),
}));

import Layout from '@renderer/components/layout/Layout';

const renderLayout = () => render(<Layout sider={<div>sider</div>} />);

const missing = (kind: IRuntimeStatusEvent['scope']['kind'], id: string): IRuntimeStatusEvent => ({
  resource: 'node',
  scope: { kind, id },
  phase: 'failed',
  failure_kind: 'bundled_resource_missing',
});

const BACK_KEY = 'common.back';

const setWindowWidth = (width: number) =>
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });

/** The window resized to `width`, as Electron reports it to the page. */
const resizeTo = (width: number) =>
  act(() => {
    setWindowWidth(width);
    window.dispatchEvent(new Event('resize'));
  });

describe('Layout sider brand Home button', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
    navigate.mockClear();
    openDevTools.mockClear();
    platformMocks.isElectronDesktopMock.mockReturnValue(false);
    shortcutMocks.params = undefined;
    sessionStorage.clear();
    localStorage.clear();
    resetCurrentProjectForTest();
    resetCurrentConversationForTest();
    currentPathname = '/guid';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('navigates to the recorded last non-settings path when clicked in a settings route', () => {
    currentPathname = '/settings/about';
    sessionStorage.setItem('mu:last-non-settings-path', '/conversation/abc');
    renderLayout();

    fireEvent.click(screen.getByLabelText(BACK_KEY));
    expect(navigate).toHaveBeenCalledWith('/conversation/abc');
  });

  it('falls back to /guid in a settings route when no path is recorded', () => {
    currentPathname = '/settings/system';
    renderLayout();

    fireEvent.click(screen.getByLabelText(BACK_KEY));
    expect(navigate).toHaveBeenCalledWith('/guid');
  });

  it('falls back to /guid when the recorded path is itself a settings path', () => {
    currentPathname = '/settings/about';
    sessionStorage.setItem('mu:last-non-settings-path', '/settings/system');
    renderLayout();

    fireEvent.click(screen.getByLabelText(BACK_KEY));
    expect(navigate).toHaveBeenCalledWith('/guid');
  });

  it('activates via keyboard (Enter and Space) in a settings route', () => {
    currentPathname = '/settings/about';
    sessionStorage.setItem('mu:last-non-settings-path', '/conversation/abc');
    renderLayout();

    const brand = screen.getByLabelText(BACK_KEY);
    fireEvent.keyDown(brand, { key: 'Enter' });
    fireEvent.keyDown(brand, { key: ' ' });
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledWith('/conversation/abc');
  });

  it('ignores non-activation keys in a settings route', () => {
    currentPathname = '/settings/about';
    sessionStorage.setItem('mu:last-non-settings-path', '/conversation/abc');
    renderLayout();

    const brand = screen.getByLabelText(BACK_KEY);
    fireEvent.keyDown(brand, { key: 'Tab' });
    fireEvent.keyDown(brand, { key: 'a' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('renders the wordmark as a non-actionable element in a non-settings route', () => {
    currentPathname = '/guid';
    renderLayout();

    // No actionable role/label in chat routes.
    expect(screen.queryByLabelText(BACK_KEY)).toBeNull();
    const wordmark = screen.getByText('mu');
    fireEvent.click(wordmark);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not navigate when the wordmark is clicked in a non-settings route', () => {
    currentPathname = '/conversation/xyz';
    renderLayout();

    fireEvent.click(screen.getByText('mu'));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('puts the work panel beside the content on a conversation page, and nowhere else', () => {
    currentPathname = '/conversation/conv-1';
    setCurrentConversation('conv-1');
    const { container, unmount } = renderLayout();
    const panel = screen.getByTestId('work-panel');
    // A sibling of the route content in the one measured row: switching conversations never remounts it.
    expect(panel.parentElement).toBe(container.querySelector('.layout-content')?.parentElement);
    act(() => setCurrentConversation('conv-2'));
    expect(screen.getByTestId('work-panel')).toBe(panel);
    unmount();

    currentPathname = '/guid';
    renderLayout();
    expect(screen.queryByTestId('work-panel')).not.toBeInTheDocument();
  });

  it('provides common shortcuts with a functional sider toggle', () => {
    currentPathname = '/conversation/xyz';
    const { container } = renderLayout();
    const sider = container.querySelector('.layout-sider');

    expect(shortcutMocks.params?.toggleSider).toEqual(expect.any(Function));
    expect(sider).not.toHaveClass('collapsed');

    act(() => shortcutMocks.params?.toggleSider());
    expect(sider).toHaveClass('collapsed');

    act(() => shortcutMocks.params?.toggleSider());
    expect(sider).not.toHaveClass('collapsed');
  });

  it('collapses to a narrow rail on a desktop that keeps the mark, not to nothing', () => {
    currentPathname = '/conversation/xyz';
    const { container } = renderLayout();
    const sider = container.querySelector('.layout-sider') as HTMLElement;

    act(() => shortcutMocks.params?.toggleSider());
    expect(sider).toHaveClass('collapsed');
    expect(sider.style.width).toBe('56px');
    expect(screen.getByTestId('sider-brand-mark')).toBeVisible();
    // The sidebar's own content is still there, as a rail.
    expect(screen.getByText('sider')).toBeInTheDocument();
  });

  it('clicking the logo icon counts toward the devtools easter-egg and never navigates', () => {
    currentPathname = '/settings/about';
    sessionStorage.setItem('mu:last-non-settings-path', '/conversation/abc');
    renderLayout();

    // The icon is the div wrapping the mu mark, separate from the wordmark.
    const icon = screen.getByTestId('sider-brand-mark');
    expect(icon.querySelector('svg')).toBeTruthy();
    for (let i = 0; i < 4; i++) fireEvent.click(icon);
    expect(openDevTools).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('says once, in a toast, that something outside a conversation needed the Node.js runtime put off at start', () => {
    const info = vi.spyOn(Message, 'info').mockImplementation(() => () => {});
    renderLayout();

    act(() => {
      // A conversation says so above its own composer; the backend's own check at start waits for nothing.
      runtimeMocks.deferredFailure?.(missing('conversation', 'layout-conv'));
      runtimeMocks.deferredFailure?.(missing('custom_agent', 'startup'));
    });
    expect(info).not.toHaveBeenCalled();

    act(() => {
      runtimeMocks.deferredFailure?.(missing('mcp', 'layout-fetch'));
      runtimeMocks.deferredFailure?.(missing('custom_agent', 'layout-writer'));
    });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('common.nodeRuntime.toolNote');
  });

  it('opens 关于 and checks there when the menu or the tray asks to check for updates', () => {
    platformMocks.isElectronDesktopMock.mockReturnValue(true);
    renderLayout();

    act(() => updateMocks.open?.({ source: 'tray' }));

    expect(navigate).toHaveBeenCalledWith('/settings/about');
    expect(updateMocks.run).toHaveBeenCalledWith({ action: 'check' });
  });

  it('listens for no update requests outside the desktop app', () => {
    renderLayout();
    expect(updateMocks.open).toBeUndefined();
    expect(menuMocks.command).toBeUndefined();
  });

  it('starts a new conversation and opens the settings when the application menu asks', () => {
    platformMocks.isElectronDesktopMock.mockReturnValue(true);
    currentPathname = '/conversation/abc';
    renderLayout();

    act(() => menuMocks.command?.({ command: 'newChat' }));
    expect(navigate).toHaveBeenCalledWith('/guid', { state: { resetAssistant: true } });

    act(() => menuMocks.command?.({ command: 'openSettings' }));
    expect(navigate).toHaveBeenLastCalledWith('/settings/providers');
  });

  it('stays on the settings page shown when the menu asks for the settings there', () => {
    platformMocks.isElectronDesktopMock.mockReturnValue(true);
    currentPathname = '/settings/about';
    renderLayout();

    act(() => menuMocks.command?.({ command: 'openSettings' }));

    expect(navigate).not.toHaveBeenCalled();
  });

  describe('in a desktop window resized narrow and wide again', () => {
    beforeEach(() => {
      platformMocks.isElectronDesktopMock.mockReturnValue(true);
      currentPathname = '/guid';
      setWindowWidth(1400);
    });

    afterEach(() => {
      setWindowWidth(1024);
    });

    it('folds the sidebar to its rail, keeps the desktop layout, and opens the sidebar again (N13)', () => {
      const { container } = renderLayout();
      const sider = container.querySelector('.layout-sider') as HTMLElement;
      expect(sider).not.toHaveClass('collapsed');

      resizeTo(500);
      expect(sider).toHaveClass('collapsed');
      expect(sider.style.width).toBe('56px');
      // No phone layout in a desktop window, however narrow: no sheet, no scrim, no phone styles.
      expect(document.documentElement).not.toHaveAttribute('data-phone-layout');

      resizeTo(1400);
      expect(sider).not.toHaveClass('collapsed');
    });

    it('keeps a sidebar the person folded folded, however wide the window gets', () => {
      const { container } = renderLayout();
      const sider = container.querySelector('.layout-sider') as HTMLElement;

      act(() => shortcutMocks.params?.toggleSider());
      resizeTo(500);
      resizeTo(1400);

      expect(sider).toHaveClass('collapsed');
    });
  });
});
