import type { MenuItemConstructorOptions } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  Menu: { buildFromTemplate: vi.fn((template: unknown) => ({ template })), setApplicationMenu: vi.fn() },
  app: { name: 'mu', isPackaged: true, on: vi.fn() },
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
  BrowserWindow: { getAllWindows: () => [] },
}));

const bridge = vi.hoisted(() => ({
  menuCommand: vi.fn(),
  updateOpen: vi.fn(),
}));

vi.mock('electron', () => electron);

vi.mock('@/common', () => ({
  ipcBridge: {
    application: { menuCommand: { emit: bridge.menuCommand } },
    update: { open: { emit: bridge.updateOpen } },
  },
}));

import {
  MU_PROJECT_URL,
  buildApplicationMenuTemplate,
  setApplicationMenuWindow,
  setupApplicationMenu,
  type ApplicationMenuActions,
} from '@/process/utils/appMenu';
import i18n, { changeLanguage } from '@/process/services/i18n';

const fakeT = (key: string, options?: Record<string, unknown>) =>
  options?.name ? `${key}(${String(options.name)})` : key;

const fakeActions = (): ApplicationMenuActions => ({
  newChat: vi.fn(),
  openSettings: vi.fn(),
  checkForUpdates: vi.fn(),
  openProjectPage: vi.fn(),
  zoom: vi.fn(),
});

const mac = (development = false, actions = fakeActions()) =>
  buildApplicationMenuTemplate(fakeT, { platform: 'darwin', development, actions });

const windows = (actions = fakeActions()) =>
  buildApplicationMenuTemplate(fakeT, { platform: 'win32', development: false, actions });

const visibleItems = (template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
  template.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? visibleItems(item.submenu as MenuItemConstructorOptions[]) : []),
  ]);

const submenuOf = (template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions[] =>
  (template.find((item) => item.label === label)?.submenu as MenuItemConstructorOptions[] | undefined) ?? [];

const itemLabelled = (template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions | undefined =>
  visibleItems(template).find((item) => item.label === label);

const click = (item: MenuItemConstructorOptions | undefined) =>
  (item?.click as (() => void) | undefined)?.call(undefined);

describe('the macOS application menu', () => {
  it('has the standard menus in the standard order', () => {
    expect(mac().map((item) => item.label)).toEqual([
      'mu',
      'common.menu.file',
      'common.menu.edit',
      'common.menu.view',
      'common.menu.window',
      'common.menu.help',
    ]);
  });

  it('gives every visible item a label from the app language', () => {
    const unlabeled = visibleItems(mac(true)).filter((item) => item.type !== 'separator' && !item.label);

    expect(unlabeled).toEqual([]);
  });

  it('keeps the app menu to about, updates, settings, services, hide and quit', () => {
    const appMenu = submenuOf(mac(), 'mu').filter((item) => item.type !== 'separator');

    expect(appMenu.map((item) => item.role ?? item.label)).toEqual([
      'about',
      'common.menu.checkForUpdates',
      'common.menu.settings',
      'services',
      'hide',
      'hideOthers',
      'unhide',
      'quit',
    ]);
  });

  it("opens mu's settings with ⌘,", () => {
    const actions = fakeActions();
    const settings = itemLabelled(mac(false, actions), 'common.menu.settings');

    click(settings);

    expect(settings?.accelerator).toBe('CmdOrCtrl+,');
    expect(actions.openSettings).toHaveBeenCalledTimes(1);
  });

  it('starts a new conversation with ⌘N and closes the window with ⌘W', () => {
    const actions = fakeActions();
    const file = submenuOf(mac(false, actions), 'common.menu.file');
    const newChat = file.find((item) => item.label === 'common.menu.newChat');

    click(newChat);

    expect(newChat?.accelerator).toBe('CmdOrCtrl+N');
    expect(actions.newChat).toHaveBeenCalledTimes(1);
    expect(file.map((item) => item.role).filter(Boolean)).toEqual(['close']);
  });

  it('has a Window menu that minimizes, zooms and brings all windows to the front', () => {
    const windowMenu = mac().find((item) => item.label === 'common.menu.window');
    const roles = ((windowMenu?.submenu ?? []) as MenuItemConstructorOptions[])
      .map((item) => item.role)
      .filter(Boolean);

    expect(windowMenu?.role).toBe('window');
    expect(roles).toEqual(['minimize', 'zoom', 'front']);
  });

  it('opens the project page from Help, and checks for updates only in the app menu', () => {
    const actions = fakeActions();
    const help = submenuOf(mac(false, actions), 'common.menu.help');

    click(help.find((item) => item.label === 'common.menu.projectPage(mu)'));

    expect(actions.openProjectPage).toHaveBeenCalledTimes(1);
    expect(help.some((item) => item.label === 'common.menu.checkForUpdates')).toBe(false);
  });
});

describe('the View menu', () => {
  it('shows no reload and no developer tools in an installed build', () => {
    const roles = submenuOf(mac(false), 'common.menu.view').map((item) => item.role);

    expect(roles).not.toContain('reload');
    expect(roles).not.toContain('forceReload');
    expect(roles).not.toContain('toggleDevTools');
  });

  it('adds reload and the developer tools in a build run from its sources', () => {
    const roles = submenuOf(mac(true), 'common.menu.view').map((item) => item.role);

    expect(roles).toEqual(expect.arrayContaining(['reload', 'forceReload', 'toggleDevTools']));
  });

  it("zooms on the app's own scale, as the keyboard does", () => {
    const actions = fakeActions();
    const template = mac(false, actions);

    click(itemLabelled(template, 'common.menu.zoomIn'));
    click(itemLabelled(template, 'common.menu.zoomOut'));
    click(itemLabelled(template, 'common.menu.resetZoom'));

    expect(vi.mocked(actions.zoom).mock.calls.map(([action]) => action)).toEqual(['zoomIn', 'zoomOut', 'resetZoom']);
  });

  it("uses none of Chromium's zoom roles, which would bypass the app's scale", () => {
    const roles = visibleItems(mac(true)).map((item) => item.role);

    expect(roles).not.toContain('zoomIn');
    expect(roles).not.toContain('zoomOut');
    expect(roles).not.toContain('resetZoom');
  });
});

describe('the Windows and Linux menu', () => {
  it('gives every visible item a label', () => {
    const unlabeled = visibleItems(windows()).filter((item) => item.type !== 'separator' && !item.label);

    expect(unlabeled).toEqual([]);
  });

  it('has File, Edit, View and Help, with the settings and quit in File', () => {
    const template = windows();
    const file = submenuOf(template, 'common.menu.file');

    expect(template.map((item) => item.label)).toEqual([
      'common.menu.file',
      'common.menu.edit',
      'common.menu.view',
      'common.menu.help',
    ]);
    expect(file.map((item) => item.role ?? item.label).filter(Boolean)).toEqual([
      'common.menu.newChat',
      'common.menu.settings',
      'close',
      'quit',
    ]);
  });

  it('checks for updates from Help', () => {
    const actions = fakeActions();
    const help = submenuOf(windows(actions), 'common.menu.help');

    click(help.find((item) => item.label === 'common.menu.checkForUpdates'));

    expect(actions.checkForUpdates).toHaveBeenCalledTimes(1);
  });
});

describe('the installed menu', () => {
  const installed = () => electron.Menu.buildFromTemplate.mock.calls.at(-1)?.[0] as MenuItemConstructorOptions[];

  beforeEach(() => {
    bridge.menuCommand.mockClear();
    bridge.updateOpen.mockClear();
  });

  it('is built in the main-process language', async () => {
    await changeLanguage('zh-CN');
    setupApplicationMenu();

    expect(installed().map((item) => item.label)).toContain('编辑');
    expect(electron.Menu.setApplicationMenu).toHaveBeenCalled();
    await changeLanguage('en-US');
    expect(i18n.t('common.menu.edit')).toBe('Edit');
  });

  it('brings the window forward and asks the page for a new conversation', () => {
    const reveal = vi.fn();
    setApplicationMenuWindow(reveal);
    setupApplicationMenu();

    click(itemLabelled(installed(), i18n.t('common.menu.newChat')));

    expect(reveal).toHaveBeenCalledTimes(1);
    expect(bridge.menuCommand).toHaveBeenCalledWith({ command: 'newChat' });
  });

  it('brings the window forward and asks the page for the settings', () => {
    const reveal = vi.fn();
    setApplicationMenuWindow(reveal);
    setupApplicationMenu();

    click(itemLabelled(installed(), i18n.t('common.menu.settings')));

    expect(reveal).toHaveBeenCalledTimes(1);
    expect(bridge.menuCommand).toHaveBeenCalledWith({ command: 'openSettings' });
  });

  it("opens mu's GitHub page", () => {
    setupApplicationMenu();

    click(itemLabelled(installed(), i18n.t('common.menu.projectPage', { name: 'mu' })));

    expect(electron.shell.openExternal).toHaveBeenCalledWith(MU_PROJECT_URL);
    expect(MU_PROJECT_URL).toBe('https://github.com/qybaihe/mu');
  });

  it('logs a project page that cannot be opened', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    electron.shell.openExternal.mockImplementationOnce(() => Promise.reject(new Error('no browser')));
    setupApplicationMenu();

    click(itemLabelled(installed(), i18n.t('common.menu.projectPage', { name: 'mu' })));

    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    error.mockRestore();
  });
});
