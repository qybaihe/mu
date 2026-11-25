import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => {
  const popup = vi.fn();
  return {
    popup,
    Menu: { buildFromTemplate: vi.fn((template: unknown) => ({ template, popup })) },
  };
});

vi.mock('electron', () => ({ Menu: electron.Menu }));

vi.mock('@/process/services/i18n', () => ({
  default: { t: (key: string) => key },
}));

import { buildContextMenuTemplate, registerContextMenu } from '@/process/utils/contextMenu';

const flags = (
  over: Partial<{ canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean }> = {}
) => ({
  canCut: true,
  canCopy: true,
  canPaste: true,
  canSelectAll: true,
  ...over,
});

const editable = (selectionText = '', editFlags = flags()) => ({ isEditable: true, selectionText, editFlags });
const selection = (text = 'some text', editFlags = flags()) => ({ isEditable: false, selectionText: text, editFlags });

const roles = (template: { role?: string }[] | undefined) => template?.map((item) => item.role);
const labels = (template: { label?: string }[] | undefined) => template?.map((item) => item.label);

describe('buildContextMenuTemplate', () => {
  it('an editable field with a selection offers cut, copy, paste and select all', () => {
    const template = buildContextMenuTemplate(editable('picked'));
    expect(roles(template)).toEqual(['cut', 'copy', 'paste', 'selectAll']);
    expect(labels(template)).toEqual([
      'common.menu.cut',
      'common.menu.copy',
      'common.menu.paste',
      'common.menu.selectAll',
    ]);
  });

  it('an editable field with nothing selected offers only paste and select all', () => {
    expect(roles(buildContextMenuTemplate(editable('')))).toEqual(['paste', 'selectAll']);
  });

  it('keeps cut and copy for a whitespace selection in an editable field', () => {
    expect(roles(buildContextMenuTemplate(editable('  ')))).toEqual(['cut', 'copy', 'paste', 'selectAll']);
  });

  it('drops the items the edit flags forbid', () => {
    const template = buildContextMenuTemplate(editable('picked', flags({ canCut: false, canSelectAll: false })));
    expect(roles(template)).toEqual(['copy', 'paste']);
  });

  it('selected text outside an editable field offers copy only, whatever the edit flags', () => {
    expect(roles(buildContextMenuTemplate(selection()))).toEqual(['copy']);
    expect(roles(buildContextMenuTemplate(selection('x', flags({ canCopy: false }))))).toBeUndefined();
  });

  it('nothing to copy outside an editable field shows no menu', () => {
    expect(buildContextMenuTemplate(selection(''))).toBeUndefined();
    expect(buildContextMenuTemplate(selection('  '))).toBeUndefined();
  });
});

describe('registerContextMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** A window whose contents are right-clicked, already registered. */
  const window = (isDestroyed = false) => {
    const webContents = new EventEmitter();
    const win = { webContents, isDestroyed: () => isDestroyed } as unknown as BrowserWindow;
    registerContextMenu(win);
    return win;
  };

  it('pops up the menu for a right-click with a selection, in the window that was right-clicked', () => {
    const win = window();
    win.webContents.emit('context-menu', null, selection('picked'));
    expect(electron.Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(electron.popup).toHaveBeenCalledTimes(1);
    expect(electron.popup).toHaveBeenCalledWith({ window: win });
  });

  it('shows nothing once the window is destroyed', () => {
    window(true).webContents.emit('context-menu', null, selection('picked'));
    expect(electron.popup).not.toHaveBeenCalled();
  });

  it('shows nothing for a right-click with no selection and no editable field', () => {
    window().webContents.emit('context-menu', null, { isEditable: false, selectionText: '', editFlags: flags() });
    expect(electron.Menu.buildFromTemplate).not.toHaveBeenCalled();
    expect(electron.popup).not.toHaveBeenCalled();
  });
});
