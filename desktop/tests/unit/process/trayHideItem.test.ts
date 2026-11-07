import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { name: 'mu', isPackaged: true, on: vi.fn() },
}));

vi.mock('@/common', () => ({ ipcBridge: {} }));

import i18n, { changeLanguage } from '@/process/services/i18n';
import { hideItemLabelKey } from '@/process/utils/tray';

describe('the tray menu item that hides the window', () => {
  beforeAll(async () => {
    await changeLanguage('en-US');
  });

  afterAll(async () => {
    await changeLanguage('en-US');
  });

  it('says Hide mu on a Mac, as Mac apps do', () => {
    expect(i18n.t(hideItemLabelKey('darwin'))).toBe('Hide mu');
  });

  it('names the tray on Windows and Linux', () => {
    expect(i18n.t(hideItemLabelKey('win32'))).toBe('Minimize to tray');
    expect(i18n.t(hideItemLabelKey('linux'))).toBe('Minimize to tray');
  });

  it('says menu bar in the app language too', async () => {
    await changeLanguage('zh-CN');

    expect(i18n.t(hideItemLabelKey('darwin'))).toBe('隐藏到菜单栏');
  });
});
