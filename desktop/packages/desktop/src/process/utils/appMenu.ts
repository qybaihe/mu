/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { MU_DISPLAY_NAME } from '@/common/kyrn/displayName';
import i18n from '@process/services/i18n';
import { MU_REPO } from '@process/services/update/githubReleases';
import type { MenuItemConstructorOptions } from 'electron';
import { Menu, app, shell } from 'electron';
import { zoomFromMenu, type ZoomShortcutAction } from './zoom';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export const MU_PROJECT_URL = `https://github.com/${MU_REPO}`;

/** What the menu's own items do; every other item is an Electron role. */
export type ApplicationMenuActions = {
  /** 新会话: a new conversation, as the sidebar's button starts one. */
  newChat: () => void;
  /** 设置…: mu's settings. */
  openSettings: () => void;
  /** The update check of 关于 (About); mu updates itself from its GitHub releases in every build. */
  checkForUpdates: () => void;
  openProjectPage: () => void;
  /** The app's own zoom steps, as the keyboard's. */
  zoom: (action: ZoomShortcutAction) => void;
};

export type ApplicationMenuOptions = {
  platform?: NodeJS.Platform;
  /** A build run from its sources: the View menu adds reloading and the developer tools. */
  development: boolean;
  actions: ApplicationMenuActions;
};

const separator: MenuItemConstructorOptions = { type: 'separator' };

/**
 * The application menu template. On a Mac: the app menu (about, updates, settings, services, hide, quit), File (a new
 * conversation, close the window), Edit, View (zoom, full screen; reload and the developer tools only in a build run
 * from its sources), Window and Help (the project's page). Windows and Linux get File (with the settings and quit),
 * Edit, View and Help (with the update check).
 *
 * Every visible item carries its own label: Electron's role defaults follow the operating system's language, not the
 * app's. A label keeps the role's behaviour (and its accelerator).
 */
export function buildApplicationMenuTemplate(
  t: Translate,
  { platform = process.platform, development, actions }: ApplicationMenuOptions
): MenuItemConstructorOptions[] {
  const isMac = platform === 'darwin';
  const name = MU_DISPLAY_NAME;
  const checkForUpdates: MenuItemConstructorOptions = {
    label: t('common.menu.checkForUpdates'),
    click: () => actions.checkForUpdates(),
  };
  const settings: MenuItemConstructorOptions = {
    label: t('common.menu.settings'),
    accelerator: 'CmdOrCtrl+,',
    click: () => actions.openSettings(),
  };
  const quit: MenuItemConstructorOptions = { role: 'quit', label: t('common.menu.quit', { name }) };
  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      // macOS always titles this menu with the bundle name; the label only matters elsewhere.
      label: app.name,
      submenu: [
        { role: 'about', label: t('common.menu.about', { name }) },
        checkForUpdates,
        separator,
        settings,
        separator,
        { role: 'services', label: t('common.menu.services') },
        separator,
        { role: 'hide', label: t('common.menu.hide', { name }) },
        { role: 'hideOthers', label: t('common.menu.hideOthers') },
        { role: 'unhide', label: t('common.menu.unhide') },
        separator,
        quit,
      ],
    });
  }

  template.push({
    label: t('common.menu.file'),
    submenu: [
      { label: t('common.menu.newChat'), accelerator: 'CmdOrCtrl+N', click: () => actions.newChat() },
      ...(isMac ? [] : [separator, settings]),
      separator,
      { role: 'close', label: t('common.menu.closeWindow') },
      ...(isMac ? [] : [quit]),
    ],
  });

  template.push({
    label: t('common.menu.edit'),
    submenu: [
      { role: 'undo', label: t('common.menu.undo') },
      { role: 'redo', label: t('common.menu.redo') },
      separator,
      { role: 'cut', label: t('common.menu.cut') },
      { role: 'copy', label: t('common.menu.copy') },
      { role: 'paste', label: t('common.menu.paste') },
      ...(isMac
        ? ([
            { role: 'pasteAndMatchStyle', label: t('common.menu.pasteAndMatchStyle') },
            { role: 'delete', label: t('common.menu.delete') },
            { role: 'selectAll', label: t('common.menu.selectAll') },
          ] as MenuItemConstructorOptions[])
        : ([
            { role: 'delete', label: t('common.menu.delete') },
            separator,
            { role: 'selectAll', label: t('common.menu.selectAll') },
          ] as MenuItemConstructorOptions[])),
    ],
  });

  template.push({
    label: t('common.menu.view'),
    submenu: [
      ...(development
        ? ([
            { role: 'reload', label: t('common.menu.reload') },
            { role: 'forceReload', label: t('common.menu.forceReload') },
            { role: 'toggleDevTools', label: t('common.menu.toggleDevTools') },
            separator,
          ] as MenuItemConstructorOptions[])
        : []),
      // The keys themselves are handled before the page sees them (zoom.ts); these accelerators show them here.
      { label: t('common.menu.resetZoom'), accelerator: 'CmdOrCtrl+0', click: () => actions.zoom('resetZoom') },
      { label: t('common.menu.zoomIn'), accelerator: 'CmdOrCtrl+Plus', click: () => actions.zoom('zoomIn') },
      { label: t('common.menu.zoomOut'), accelerator: 'CmdOrCtrl+-', click: () => actions.zoom('zoomOut') },
      separator,
      { role: 'togglefullscreen', label: t('common.menu.toggleFullScreen') },
    ],
  });

  if (isMac) {
    template.push({
      label: t('common.menu.window'),
      // The window role makes it the Window menu, which macOS completes with the list of open windows.
      role: 'window',
      submenu: [
        { role: 'minimize', label: t('common.menu.minimize') },
        { role: 'zoom', label: t('common.menu.zoomWindow') },
        separator,
        { role: 'front', label: t('common.menu.bringAllToFront') },
      ],
    });
  }

  template.push({
    label: t('common.menu.help'),
    // The help role keeps the macOS search field in this menu.
    role: 'help',
    submenu: [
      { label: t('common.menu.projectPage', { name }), click: () => actions.openProjectPage() },
      ...(isMac ? [] : [separator, checkForUpdates]),
    ],
  });

  return template;
}

/** Shows the main window, creating it when there is none; the app's entry sets it once. */
let revealMainWindow: () => void = () => {};

export function setApplicationMenuWindow(reveal: () => void): void {
  revealMainWindow = reveal;
}

const applicationMenuActions: ApplicationMenuActions = {
  newChat: () => {
    revealMainWindow();
    ipcBridge.application.menuCommand.emit({ command: 'newChat' });
  },
  openSettings: () => {
    revealMainWindow();
    ipcBridge.application.menuCommand.emit({ command: 'openSettings' });
  },
  checkForUpdates: () => {
    revealMainWindow();
    // The update row of 关于 (About) shows the check and its answer.
    ipcBridge.update.open.emit({ source: 'menu' });
  },
  openProjectPage: () => {
    void shell.openExternal(MU_PROJECT_URL).catch((error: unknown) => {
      console.error('[mu] Failed to open the project page:', error);
    });
  },
  zoom: zoomFromMenu,
};

/** Build and install the application menu in the current app language; called again on every language switch. */
export function setupApplicationMenu(): void {
  const t: Translate = (key, options) => i18n.t(key, options);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildApplicationMenuTemplate(t, { development: !app.isPackaged, actions: applicationMenuActions })
    )
  );
}
