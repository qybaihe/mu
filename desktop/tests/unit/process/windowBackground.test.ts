import { beforeEach, describe, expect, it, vi } from 'vitest';

type WindowStub = { isDestroyed: () => boolean; setBackgroundColor: ReturnType<typeof vi.fn> };

const electron = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>();
  return {
    windows: [] as WindowStub[],
    nativeTheme: {
      shouldUseDarkColors: false,
      on: (event: string, listener: () => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(listener);
      },
      removeListener: (event: string, listener: () => void) => listeners.get(event)?.delete(listener),
      emit: (event: string) => listeners.get(event)?.forEach((listener) => listener()),
    },
  };
});

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserWindow: { getAllWindows: () => electron.windows },
  nativeTheme: electron.nativeTheme,
}));

import {
  WINDOW_BACKGROUND,
  followSystemAppearance,
  initializeWindowAppearance,
  readWindowAppearance,
  setWindowAppearance,
  windowBackgroundColor,
  windowBackgroundFor,
} from '@/process/utils/windowBackground';

const addWindow = (destroyed = false): WindowStub => {
  const win = { isDestroyed: () => destroyed, setBackgroundColor: vi.fn() };
  electron.windows.push(win);
  return win;
};

describe('windowBackgroundFor', () => {
  it('follows a dark system when no theme was ever applied (a first start)', () => {
    expect(windowBackgroundFor(undefined, true)).toBe(WINDOW_BACKGROUND.dark);
  });

  it('follows the system for a theme that follows it, whatever it was last time', () => {
    expect(windowBackgroundFor({ appearance: 'light', followsSystem: true }, true)).toBe(WINDOW_BACKGROUND.dark);
    expect(windowBackgroundFor({ appearance: 'dark', followsSystem: true }, false)).toBe(WINDOW_BACKGROUND.light);
  });

  it('keeps a chosen theme against the system', () => {
    expect(windowBackgroundFor({ appearance: 'light', followsSystem: false }, true)).toBe(WINDOW_BACKGROUND.light);
    expect(windowBackgroundFor({ appearance: 'dark', followsSystem: false }, false)).toBe(WINDOW_BACKGROUND.dark);
  });
});

describe('readWindowAppearance', () => {
  it('reads a kept appearance', () => {
    expect(readWindowAppearance({ appearance: 'dark', followsSystem: true })).toEqual({
      appearance: 'dark',
      followsSystem: true,
    });
  });

  it('refuses what is not one, so a damaged config falls back to the system', () => {
    expect(readWindowAppearance(undefined)).toBeUndefined();
    expect(readWindowAppearance('dark')).toBeUndefined();
    expect(readWindowAppearance({ appearance: 'sepia', followsSystem: false })).toBeUndefined();
  });
});

describe('the window background at runtime', () => {
  beforeEach(() => {
    electron.windows.length = 0;
    electron.nativeTheme.shouldUseDarkColors = false;
    initializeWindowAppearance(undefined);
  });

  it('creates the window in the kept appearance', () => {
    initializeWindowAppearance({ appearance: 'dark', followsSystem: false });

    expect(windowBackgroundColor()).toBe(WINDOW_BACKGROUND.dark);
  });

  it('creates the first window dark when the system is dark and nothing is kept', () => {
    electron.nativeTheme.shouldUseDarkColors = true;

    expect(windowBackgroundColor()).toBe(WINDOW_BACKGROUND.dark);
  });

  it('repaints every open window when the page applies a theme', () => {
    const open = addWindow();
    const closed = addWindow(true);

    setWindowAppearance({ appearance: 'dark', followsSystem: false }, vi.fn());

    expect(open.setBackgroundColor).toHaveBeenCalledWith(WINDOW_BACKGROUND.dark);
    expect(closed.setBackgroundColor).not.toHaveBeenCalled();
  });

  it('keeps the applied appearance for the next start', async () => {
    const persist = vi.fn();

    setWindowAppearance({ appearance: 'dark', followsSystem: false }, persist);

    await vi.waitFor(() => expect(persist).toHaveBeenCalledWith({ appearance: 'dark', followsSystem: false }));
  });

  it('writes the kept appearance only when it changed', async () => {
    const persist = vi.fn();

    setWindowAppearance({ appearance: 'dark', followsSystem: true }, persist);
    setWindowAppearance({ appearance: 'dark', followsSystem: true }, persist);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('ignores a malformed message', () => {
    const win = addWindow();
    const persist = vi.fn();

    setWindowAppearance({ appearance: 'purple' }, persist);

    expect(win.setBackgroundColor).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('logs a failed write instead of throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const persist = vi.fn(() => {
      throw new Error('disk full');
    });

    expect(() => setWindowAppearance({ appearance: 'light', followsSystem: false }, persist)).not.toThrow();
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    error.mockRestore();
  });
});

describe('followSystemAppearance', () => {
  beforeEach(() => {
    electron.windows.length = 0;
    electron.nativeTheme.shouldUseDarkColors = false;
    initializeWindowAppearance(undefined);
  });

  it('repaints a window that follows the system as soon as the system turns dark', () => {
    const win = addWindow();
    initializeWindowAppearance({ appearance: 'light', followsSystem: true });
    const stop = followSystemAppearance();

    electron.nativeTheme.shouldUseDarkColors = true;
    electron.nativeTheme.emit('updated');

    expect(win.setBackgroundColor).toHaveBeenLastCalledWith(WINDOW_BACKGROUND.dark);
    stop();
  });

  it('leaves a chosen theme alone', () => {
    const win = addWindow();
    initializeWindowAppearance({ appearance: 'light', followsSystem: false });
    const stop = followSystemAppearance();

    electron.nativeTheme.shouldUseDarkColors = true;
    electron.nativeTheme.emit('updated');

    expect(win.setBackgroundColor).not.toHaveBeenCalled();
    stop();
  });

  it('stops after unsubscribe', () => {
    const win = addWindow();
    const stop = followSystemAppearance();
    stop();

    electron.nativeTheme.emit('updated');

    expect(win.setBackgroundColor).not.toHaveBeenCalled();
  });
});
