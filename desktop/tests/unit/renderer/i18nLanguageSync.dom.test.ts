import { beforeEach, describe, expect, it, vi } from 'vitest';

type LanguageChangedHandler = (event: { language: string }) => Promise<void> | void;

const mocks = vi.hoisted(() => ({
  languageChangedHandler: null as LanguageChangedHandler | null,
  syncMainLanguage: vi.fn(async (_params: { language: string }) => {}),
  changeLanguage: vi.fn(async (_params: { language: string }) => {}),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    systemSettings: {
      languageChanged: {
        on: (handler: LanguageChangedHandler) => {
          mocks.languageChangedHandler = handler;
          return () => {};
        },
      },
      syncMainLanguage: { invoke: mocks.syncMainLanguage },
      changeLanguage: { invoke: mocks.changeLanguage },
    },
  },
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    // Never ready: the test drives every switch itself, the saved-language startup path stays out of the way.
    whenReady: () => new Promise(() => {}),
    get: () => undefined,
    set: vi.fn(async () => {}),
  },
}));

import i18n from '@/renderer/services/i18n';

const broadcast = async (language: string) => {
  expect(mocks.languageChangedHandler).not.toBeNull();
  await mocks.languageChangedHandler?.({ language });
};

describe('renderer i18n: a language change made elsewhere', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
    mocks.syncMainLanguage.mockClear();
    mocks.changeLanguage.mockClear();
  });

  it('switches this window and tells the main process, so menus, tray and the harness follow', async () => {
    await broadcast('zh-TW');

    expect(i18n.language).toBe('zh-TW');
    expect(mocks.syncMainLanguage).toHaveBeenCalledTimes(1);
    expect(mocks.syncMainLanguage).toHaveBeenCalledWith({ language: 'zh-TW' });
    // Only the main process is told: the change was already saved where it was made.
    expect(mocks.changeLanguage).not.toHaveBeenCalled();
  });

  it('passes the normalized language on', async () => {
    await broadcast('zh');

    expect(mocks.syncMainLanguage).toHaveBeenCalledWith({ language: i18n.language });
  });

  it('does nothing for the language already shown, so the echo of its own change does not loop', async () => {
    await broadcast('en-US');

    expect(mocks.syncMainLanguage).not.toHaveBeenCalled();
  });

  it('keeps the switch when the main process cannot be told', async () => {
    mocks.syncMainLanguage.mockRejectedValueOnce(new Error('no main process'));

    await broadcast('ja-JP');

    expect(i18n.language).toBe('ja-JP');
  });
});
