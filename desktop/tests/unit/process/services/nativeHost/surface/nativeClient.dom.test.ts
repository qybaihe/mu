import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeBridge } from '@/common/kyrn/nativeBridge';
import { bridgeClient } from '@/renderer/pages/native/utils/nativeClient';

/** Whether the native host is on, as the window asks for it over the app's IPC. */

const asDesktop = (on: boolean) => {
  const scope = window as { electronAPI?: unknown };
  if (on) scope.electronAPI = {};
  else delete scope.electronAPI;
};

describe('bridgeClient.enabled', () => {
  afterEach(() => {
    asDesktop(false);
    vi.restoreAllMocks();
  });

  it('asks the main process in the desktop app, and takes its answer', async () => {
    asDesktop(true);
    const invoke = vi.spyOn(nativeBridge.enabled, 'invoke').mockResolvedValue(true);
    await expect(bridgeClient.enabled()).resolves.toBe(true);
    invoke.mockResolvedValue(false);
    await expect(bridgeClient.enabled()).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('is off for a browser on the WebUI, without asking', async () => {
    asDesktop(false);
    const invoke = vi.spyOn(nativeBridge.enabled, 'invoke').mockResolvedValue(true);
    await expect(bridgeClient.enabled()).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
