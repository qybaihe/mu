/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 系统设置桥接模块
 * System Settings Bridge Module
 *
 * 负责���理系统级设置的读写操作（如关闭到托盘）
 * Handles read/write operations for system-level settings (e.g. close to tray)
 */

import { ipcBridge } from '@/common';
import { electronPowerSaveBlocker } from '@/common/electronSafe';
import { exec } from 'node:child_process';
import { applyAppLanguage } from '@process/services/i18n';
import { createOrUpdateTray, destroyTray, setCloseToTrayEnabled } from '@process/utils/tray';
import { readCloseToTraySetting, writeCloseToTraySetting } from '@process/utils/closeToTraySetting';

/** The one hold on idle sleep the app keeps while a conversation runs; null while it may sleep. */
let awakeHold: number | null = null;

/**
 * While a conversation runs and the person has not turned it off, the computer does not go to sleep when idle
 * (`prevent-app-suspension`: the display may still turn off). The window says when that starts and ends.
 */
export function holdAwake(on: boolean): void {
  const blocker = electronPowerSaveBlocker;
  if (!blocker) return;
  if (on && (awakeHold === null || !blocker.isStarted(awakeHold))) awakeHold = blocker.start('prevent-app-suspension');
  else if (!on && awakeHold !== null) {
    if (blocker.isStarted(awakeHold)) blocker.stop(awakeHold);
    awakeHold = null;
  }
}

export function initSystemSettingsBridge(): void {
  // Voice input is delegated to whatever external command the person configured (Settings → System): the app itself
  // only fires it and reports the exit status. A typical command synthesizes the IME's voice hotkey so the dictation
  // text lands in the focused input (e.g. WeType's right-Ctrl hands-free key on Windows).
  ipcBridge.systemSettings.runVoiceCommand.provider(async ({ command }) => {
    try {
      await new Promise<void>((resolve, reject) => {
        exec(command, { timeout: 60_000, windowsHide: true }, (error) => (error ? reject(error) : resolve()));
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcBridge.systemSettings.keepAwakeWhileRunning.provider(async ({ on }) => holdAwake(on === true));

  ipcBridge.systemSettings.getCloseToTray.provider(async () => readCloseToTraySetting());

  ipcBridge.systemSettings.setCloseToTray.provider(async ({ enabled }) => {
    await writeCloseToTraySetting(enabled);
    setCloseToTrayEnabled(enabled);
    if (enabled) {
      createOrUpdateTray();
    } else {
      destroyTray();
    }
  });

  // The renderer changed the app language: switch the main process's own texts. applyAppLanguage rebuilds the
  // application menu and the tray once i18next is in the new language (see onAppLanguageApplied in index.ts).
  ipcBridge.systemSettings.syncMainLanguage.provider(async ({ language }) => {
    try {
      await applyAppLanguage(language);
    } catch (error) {
      console.error('[SystemSettings] Main process could not switch language:', error);
    }
  });
}
