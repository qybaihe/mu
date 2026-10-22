/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The theme a start applies: with no theme chosen the app follows the system's appearance (a first start on a Mac in
 * Dark comes up dark), and a chosen theme stands against the system.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { configGetMock, whenReadyMock, seedMock } = vi.hoisted(() => ({
  configGetMock: vi.fn(),
  whenReadyMock: vi.fn(),
  seedMock: vi.fn(),
}));

vi.mock('@/common/config/configService', () => ({
  configService: { get: configGetMock, whenReady: whenReadyMock },
}));

vi.mock('@/common', () => ({
  ipcBridge: { theme: { changed: { on: vi.fn(() => vi.fn()) } } },
}));

vi.mock('@/renderer/utils/theme/applyTheme', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/renderer/utils/theme/applyTheme')>();
  return { ...actual, seedElectronTheme: seedMock, setActiveTheme: vi.fn() };
});

vi.mock('@/renderer/utils/theme/systemThemeWatcher', () => ({
  startSystemThemeWatcher: vi.fn(() => vi.fn()),
}));

const systemIsDark = (dark: boolean) => {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: dark,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
};

const chosenTheme = (activeId: string | undefined) =>
  configGetMock.mockImplementation((key: string) => {
    if (key === 'theme.activeId') return activeId;
    if (key === 'theme.userThemes') return [];
    return undefined;
  });

/** Load the hook afresh: the theme is resolved when the module loads, as at a start. */
const startApp = async () => {
  vi.resetModules();
  const { default: useTheme } = await import('@/renderer/hooks/system/useTheme');
  return renderHook(() => useTheme());
};

describe('the theme at start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    whenReadyMock.mockResolvedValue(undefined);
    seedMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
  });

  it('comes up dark on a first start when the system is dark', async () => {
    systemIsDark(true);
    chosenTheme(undefined);

    const { result } = await startApp();

    await waitFor(() => expect(result.current[0]?.appearance).toBe('dark'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('marks 跟随系统 as the choice in effect while none was made', async () => {
    systemIsDark(false);
    chosenTheme(undefined);

    const { result } = await startApp();

    await waitFor(() => expect(result.current[2]).toBe('system'));
  });

  it('tells the window that the theme follows the system, for the next start too', async () => {
    systemIsDark(true);
    chosenTheme(undefined);

    await startApp();

    await waitFor(() => expect(seedMock).toHaveBeenCalledWith(expect.objectContaining({ appearance: 'dark' }), true));
    expect(localStorage.getItem('__mu_theme_follows_system')).toBe('1');
  });

  it('keeps a chosen Light theme when the system is dark', async () => {
    systemIsDark(true);
    chosenTheme('light');

    const { result } = await startApp();

    await waitFor(() => expect(result.current[0]?.appearance).toBe('light'));
    expect(seedMock).toHaveBeenCalledWith(expect.objectContaining({ appearance: 'light' }), false);
    expect(localStorage.getItem('__mu_theme_follows_system')).toBeNull();
  });

  it('follows the system when the settings cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    systemIsDark(true);
    whenReadyMock.mockRejectedValue(new Error('backend down'));

    const { result } = await startApp();

    await waitFor(() => expect(result.current[0]?.appearance).toBe('dark'));
    error.mockRestore();
  });
});
