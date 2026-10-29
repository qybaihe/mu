/**
 * The hold on idle sleep while a conversation runs (process/bridge/systemSettingsBridge.ts `holdAwake`): one hold at
 * a time, taken when the window says a run is going, let go when it says none is.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const blocker = vi.hoisted(() => {
  const started = new Set<number>();
  let next = 0;
  return {
    started,
    start: vi.fn((_type: string) => {
      next += 1;
      started.add(next);
      return next;
    }),
    stop: vi.fn((id: number) => {
      started.delete(id);
    }),
    isStarted: (id: number) => started.has(id),
  };
});

vi.mock('@/common/electronSafe', () => ({ electronPowerSaveBlocker: blocker }));
vi.mock('@/common', () => ({ ipcBridge: { systemSettings: {} } }));
vi.mock('@process/services/i18n', () => ({ applyAppLanguage: vi.fn() }));
vi.mock('@process/utils/tray', () => ({
  createOrUpdateTray: vi.fn(),
  destroyTray: vi.fn(),
  setCloseToTrayEnabled: vi.fn(),
}));
vi.mock('@process/utils/closeToTraySetting', () => ({
  readCloseToTraySetting: vi.fn(),
  writeCloseToTraySetting: vi.fn(),
}));

import { holdAwake } from '@process/bridge/systemSettingsBridge';

afterEach(() => {
  holdAwake(false);
  blocker.start.mockClear();
  blocker.stop.mockClear();
});

describe('keeping the computer awake while a conversation runs', () => {
  it('holds off idle sleep once, however often a run is said to go, and lets go when none does', () => {
    holdAwake(true);
    holdAwake(true);
    expect(blocker.start).toHaveBeenCalledTimes(1);
    expect(blocker.start).toHaveBeenCalledWith('prevent-app-suspension');
    expect(blocker.started.size).toBe(1);

    holdAwake(false);
    holdAwake(false);
    expect(blocker.stop).toHaveBeenCalledTimes(1);
    expect(blocker.started.size).toBe(0);
  });

  it('takes a new hold when the old one was let go by someone else', () => {
    holdAwake(true);
    blocker.started.clear();
    holdAwake(true);
    expect(blocker.start).toHaveBeenCalledTimes(2);
  });
});
