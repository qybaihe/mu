/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * System Notification Module
 *
 * Provides showNotification() for direct use in main process,
 * and registers an IPC provider so renderer can invoke it cross-process.
 */

import { getPlatformServices } from '@/common/platform';
import { ipcBridge } from '@/common';
import { electronApp, electronNotification } from '@/common/electronSafe';
import { ProcessConfig } from '@process/utils/initStorage';
import type { BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';

// Main window reference, used to gate on focus and to focus + navigate on click.
let mainWindowRef: BrowserWindow | null = null;

export const setNotificationMainWindow = (win: BrowserWindow): void => {
  mainWindowRef = win;
};

/**
 * Get app icon path for notifications
 */
const getNotificationIcon = (): string | undefined => {
  try {
    const resourcesPath = getPlatformServices().paths.isPackaged()
      ? process.resourcesPath
      : path.join(process.cwd(), 'resources');
    const iconPath = path.join(resourcesPath, 'app.png');
    if (fs.existsSync(iconPath)) {
      return iconPath;
    }
  } catch {
    // Ignore icon error, notification will still show
  }
  return undefined;
};

/**
 * Show a system notification.
 * Can be called directly from main process or via IPC from renderer.
 *
 * Skips when `system.notificationEnabled` is off, or when the main window is
 * already focused (no nagging). When a real Electron notification is available,
 * clicking it focuses the main window and emits `notification.clicked` so the
 * renderer can navigate to the originating conversation.
 *
 * In non-Electron mode this falls back to the platform service, which is a no-op.
 */
export async function showNotification({
  title,
  body,
  conversation_id,
  native,
}: {
  title: string;
  body: string;
  conversation_id?: string;
  native?: boolean;
}): Promise<void> {
  // Check if notification is enabled
  const notificationEnabled = await ProcessConfig.get('system.notificationEnabled');
  if (notificationEnabled === false) {
    console.log('[Notification] Skipped: notifications are disabled in settings');
    return;
  }

  // Do not notify while the user is already looking at the app.
  if (mainWindowRef && !mainWindowRef.isDestroyed() && mainWindowRef.isFocused()) {
    console.log('[Notification] Skipped: main window is focused');
    return;
  }

  const iconPath = getNotificationIcon();

  // Prefer a real Electron notification so the click can focus + navigate.
  if (electronNotification) {
    try {
      // The app's own chime is on (attentionSound.ts): the notification is silent, so the person hears one sound.
      const silent = (await ProcessConfig.get('system.completionSound')) === true;
      const notification = new electronNotification({
        title,
        body,
        ...(iconPath ? { icon: iconPath } : {}),
        ...(silent ? { silent: true } : {}),
      });
      notification.on('click', () => {
        const win = mainWindowRef;
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        }
        ipcBridge.notification.clicked.emit({ conversation_id, ...(native ? { native } : {}) });
      });
      notification.show();
      console.log(`[Notification] show() called (isSupported=${electronNotification.isSupported()})`);
    } catch (error) {
      console.error('[Notification] Error creating notification:', error);
    }
    return;
  }

  // Non-Electron fallback (no-op in node mode).
  try {
    getPlatformServices().notification.send({ title, body, icon: iconPath });
  } catch (error) {
    console.error('[Notification] Error creating notification:', error);
  }
}

/**
 * The number on the app's icon: the Dock on macOS, the launcher on Linux (Unity and those that follow it); 0 takes it
 * away. Windows has no such number, so nothing shows there. A count that is not a whole number of at least 0 is 0.
 */
export function setAppBadge(count: unknown): void {
  const shown = typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (process.platform === 'win32' || !electronApp) return;
  try {
    electronApp.setBadgeCount(shown);
  } catch (error) {
    console.warn('[Notification] Could not set the badge:', error);
  }
}

/**
 * Register IPC provider so renderer can trigger notifications cross-process.
 */
export function initNotificationBridge(): void {
  ipcBridge.notification.show.provider(async (options) => {
    await showNotification(options);
  });
  ipcBridge.notification.badge.provider(async ({ count }) => {
    setAppBadge(count);
  });
}
