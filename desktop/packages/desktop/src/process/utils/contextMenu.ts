/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The native right-click menu for selected text and editable fields. Electron shows none
 * unless the main process builds one from the `context-menu` event's params (#447).
 */
import { Menu } from 'electron';
import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions } from 'electron';
import i18n from '../services/i18n';

/** The parts of a context-menu event the template branches on. */
export type ContextMenuState = Pick<ContextMenuParams, 'isEditable' | 'selectionText'> & {
  editFlags: Pick<ContextMenuParams['editFlags'], 'canCut' | 'canCopy' | 'canPaste' | 'canSelectAll'>;
};

/**
 * The items a right-click shows, or undefined when none apply (nothing selected outside an
 * editable field). Labels go through i18n so the menu follows the app's language, like the
 * application menu; the role keeps Electron's behaviour and accelerator.
 *
 * `selectAll` is offered inside editable fields only: there Chromium scopes it to the focused
 * field. On the main document it would select the whole app shell (conversation Markdown sits in
 * a ShadowView, so it also drops that selection), so read-only selections offer `copy` only.
 */
export const buildContextMenuTemplate = (params: ContextMenuState): MenuItemConstructorOptions[] | undefined => {
  // Spaces and blank lines selected in an editable field are still a selection; outside one,
  // a whitespace-only selection is nothing to copy.
  const hasSelection = params.isEditable ? params.selectionText.length > 0 : params.selectionText.trim().length > 0;
  const item = (role: 'cut' | 'copy' | 'paste' | 'selectAll', key: string): MenuItemConstructorOptions => ({
    role,
    label: i18n.t(key),
  });
  if (params.isEditable) {
    return [
      ...(hasSelection && params.editFlags.canCut ? [item('cut', 'common.menu.cut')] : []),
      ...(hasSelection && params.editFlags.canCopy ? [item('copy', 'common.menu.copy')] : []),
      ...(params.editFlags.canPaste ? [item('paste', 'common.menu.paste')] : []),
      ...(params.editFlags.canSelectAll ? [item('selectAll', 'common.menu.selectAll')] : []),
    ];
  }
  return hasSelection && params.editFlags.canCopy ? [item('copy', 'common.menu.copy')] : undefined;
};

/** Give a window's contents the native right-click menu. */
export const registerContextMenu = (win: BrowserWindow): void => {
  win.webContents.on('context-menu', (_event, params) => {
    const template = buildContextMenuTemplate(params);
    // Name the window: the focused one can be null or another window when the right-click
    // lands on an unfocused window.
    if (template && template.length > 0 && !win.isDestroyed()) Menu.buildFromTemplate(template).popup({ window: win });
  });
};
