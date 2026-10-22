/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { configService } from '@/common/config/configService';
import { ipcBridge } from '@/common';
import { resolveActiveTheme } from '@/common/theme/resolveTheme';
import { applyTheme, seedElectronTheme, setActiveTheme } from '@/renderer/utils/theme/applyTheme';
import { getSystemPrefersDark } from '@/renderer/utils/theme/systemAppearance';
import { startSystemThemeWatcher } from '@/renderer/utils/theme/systemThemeWatcher';
import { BUILTIN_THEMES } from '@renderer/theme/builtinThemes';
import { followsSystemTheme, SYSTEM_THEME_ID } from '@/common/theme/constants';
import type { Theme } from '@/common/theme/types';
import { useCallback, useEffect, useState } from 'react';

/** The last applied appearance, for index.html's first paint before the app runs. */
const APPEARANCE_CACHE_KEY = '__mu_theme';
/** Set while the theme follows the system: the first paint then asks the system instead of the cached appearance. */
const FOLLOWS_SYSTEM_CACHE_KEY = '__mu_theme_follows_system';

function cacheAppearance(theme: Theme, followsSystem: boolean): void {
  try {
    localStorage.setItem(APPEARANCE_CACHE_KEY, theme.appearance);
    if (followsSystem) localStorage.setItem(FOLLOWS_SYSTEM_CACHE_KEY, '1');
    else localStorage.removeItem(FOLLOWS_SYSTEM_CACHE_KEY);
  } catch {
    /* noop */
  }
}

/** The chosen theme's id; with none chosen yet, the theme follows the system. */
function getPersistedActiveId(): string {
  return (configService.get('theme.activeId') as string) || SYSTEM_THEME_ID;
}

const followsSystemNow = (): boolean => followsSystemTheme(configService.get('theme.activeId') as string | undefined);

async function initActiveTheme(): Promise<Theme> {
  try {
    await configService.whenReady();
    const activeId = getPersistedActiveId();
    const userThemes = (configService.get('theme.userThemes') as Theme[]) ?? [];
    const resolved = resolveActiveTheme(activeId, [...BUILTIN_THEMES, ...userThemes], getSystemPrefersDark());
    applyTheme(resolved);
    cacheAppearance(resolved, followsSystemTheme(activeId));
    // Seed the main-process relay so other surfaces (the markdown shadow DOM) can pull it.
    void seedElectronTheme(resolved, followsSystemTheme(activeId)).catch(() => {});
    return resolved;
  } catch (e) {
    console.error('init theme failed', e);
    // Settings unreadable: follow the system, as with no theme chosen.
    const fallback = resolveActiveTheme(SYSTEM_THEME_ID, BUILTIN_THEMES, getSystemPrefersDark());
    applyTheme(fallback);
    return fallback;
  }
}

let initialPromise: Promise<Theme> | null = null;
if (typeof window !== 'undefined') initialPromise = initActiveTheme();

/**
 * Returns [resolvedActiveTheme, selectThemeById, rawActiveId]. `rawActiveId` may be the
 * `system` sentinel while the resolved theme is the Light/Dark builtin — the gallery
 * highlights cards by `rawActiveId`. With no theme chosen yet it is `system` too: the app
 * follows the system's appearance until the person picks a theme.
 */
const useTheme = (): [Theme | null, (activeId: string) => Promise<void>, string | null] => {
  const [active, setActive] = useState<Theme | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    initialPromise
      ?.then((t) => {
        if (mounted) {
          setActive(t);
          setActiveId(getPersistedActiveId());
        }
      })
      .catch((e) => console.error('init theme failed', e));
    const off = ipcBridge.theme.changed.on((t: Theme) => {
      applyTheme(t);
      if (mounted) {
        setActive((prev) => (prev?.id === t.id ? prev : t));
        // Config was persisted before the broadcast.
        setActiveId(getPersistedActiveId());
      }
      cacheAppearance(t, followsSystemNow());
    });
    // The system's appearance changed while the theme follows it (in WebUI too, where no broadcast comes back).
    const offSystemWatch = startSystemThemeWatcher((t) => {
      if (mounted) setActive((prev) => (prev?.id === t.id ? prev : t));
      cacheAppearance(t, true);
    });
    return () => {
      mounted = false;
      off?.();
      offSystemWatch();
    };
  }, []);

  const select = useCallback(async (selectedId: string) => {
    const resolved = await setActiveTheme(selectedId);
    setActive(resolved);
    setActiveId(selectedId);
    cacheAppearance(resolved, followsSystemTheme(selectedId));
  }, []);

  return [active, select, activeId];
};

export default useTheme;
