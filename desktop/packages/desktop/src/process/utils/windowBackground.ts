/**
 * The window's own background: what shows before the page paints its first frame and while it reloads. It follows
 * the theme in effect, so a dark app never flashes white. The page says which theme that is (and whether it follows
 * the system's appearance) each time it applies one; the answer is kept for the next start, when the window is
 * created before the page runs. With none kept (a first start), the window follows the system, as the app does until
 * a theme is chosen.
 */

import { BrowserWindow, nativeTheme } from 'electron';
import type { ThemeAppearance, WindowAppearance } from '@/common/theme/types';
import { trackPersistedWrite } from './persistOnQuit';

/** Each appearance's page background (`--bg-1` of the built-in themes). */
export const WINDOW_BACKGROUND: Readonly<Record<ThemeAppearance, string>> = { light: '#ffffff', dark: '#111111' };

let remembered: WindowAppearance | undefined;

/** A saved or sent value, if it is a window appearance. */
export function readWindowAppearance(value: unknown): WindowAppearance | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { appearance, followsSystem } = value as Partial<WindowAppearance>;
  if (appearance !== 'light' && appearance !== 'dark') return undefined;
  return { appearance, followsSystem: followsSystem === true };
}

/** The background for the theme in effect; none known follows the system. */
export function windowBackgroundFor(hint: WindowAppearance | undefined, systemIsDark: boolean): string {
  const appearance: ThemeAppearance = !hint || hint.followsSystem ? (systemIsDark ? 'dark' : 'light') : hint.appearance;
  return WINDOW_BACKGROUND[appearance];
}

/** Restore the kept appearance once at startup, before the first window is created. */
export function initializeWindowAppearance(saved: unknown): void {
  remembered = readWindowAppearance(saved);
}

/** The background a window gets now, at creation too. */
export function windowBackgroundColor(): string {
  return windowBackgroundFor(remembered, nativeTheme.shouldUseDarkColors);
}

function paintWindows(): void {
  const color = windowBackgroundColor();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.setBackgroundColor(color);
  }
}

/**
 * The page applied a theme: repaint the windows' background and keep the appearance for the next start (written only
 * when it changed, and flushed before a quit).
 */
export function setWindowAppearance(value: unknown, persist: (hint: WindowAppearance) => unknown): void {
  const hint = readWindowAppearance(value);
  if (!hint) return;
  const changed = remembered?.appearance !== hint.appearance || remembered?.followsSystem !== hint.followsSystem;
  remembered = hint;
  paintWindows();
  if (!changed) return;
  trackPersistedWrite(
    Promise.resolve()
      .then(() => persist(hint))
      .catch((error: unknown) => console.error('[mu] Failed to keep the window appearance:', error))
  );
}

/**
 * A window that follows the system repaints as soon as the system's appearance changes, before the page's own answer
 * arrives. Returns the unsubscribe function.
 */
export function followSystemAppearance(): () => void {
  const onUpdated = () => {
    if (!remembered || remembered.followsSystem) paintWindows();
  };
  nativeTheme.on('updated', onUpdated);
  return () => {
    nativeTheme.removeListener('updated', onUpdated);
  };
}
