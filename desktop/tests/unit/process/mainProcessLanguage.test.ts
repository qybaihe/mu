import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  return {
    store,
    processConfig: {
      get: vi.fn(async (key: string) => store.get(key)),
      set: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
    },
    writeAppLanguageFile: vi.fn(async (_language: string) => {}),
    httpRequest: vi.fn(),
  };
});

vi.mock('@process/utils/initStorage', () => ({ ProcessConfig: mocks.processConfig }));

vi.mock('@/process/services/i18n/appLanguage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/process/services/i18n/appLanguage')>()),
  writeAppLanguageFile: mocks.writeAppLanguageFile,
}));

vi.mock('@/common/adapter/httpBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/common/adapter/httpBridge')>()),
  httpRequest: mocks.httpRequest,
}));

import i18n, {
  applyAppLanguage,
  applyStartupAppLanguage,
  loadStartupLanguage,
  onAppLanguageApplied,
  translatorFor,
} from '@/process/services/i18n';
import { BackendHttpError } from '@/common/adapter/httpBridge';

describe('main-process app language', () => {
  beforeEach(() => {
    mocks.store.clear();
    mocks.processConfig.set.mockClear();
    mocks.writeAppLanguageFile.mockClear();
    mocks.httpRequest.mockReset();
  });

  it('switches the main-process texts before the listeners rebuild the menus', async () => {
    const seen: Array<{ language: string; edit: string }> = [];
    const off = onAppLanguageApplied((language) => {
      seen.push({ language, edit: i18n.t('common.menu.edit') });
    });

    await expect(applyAppLanguage('zh')).resolves.toBe('zh-CN');
    off();

    expect(seen).toEqual([{ language: 'zh-CN', edit: '编辑' }]);
    expect(i18n.language).toBe('zh-CN');
  });

  it('remembers the language as the startup hint and tells the harness', async () => {
    await applyAppLanguage('zh_TW');

    expect(mocks.processConfig.set).toHaveBeenCalledWith('language', 'zh-TW');
    expect(mocks.writeAppLanguageFile).toHaveBeenCalledWith('zh-TW');
  });

  it('applies quick successive switches in the order asked', async () => {
    const order: string[] = [];
    const off = onAppLanguageApplied((language) => order.push(language));

    await Promise.all([applyAppLanguage('ja-JP'), applyAppLanguage('en-US')]);
    off();

    expect(order).toEqual(['ja-JP', 'en-US']);
    expect(i18n.language).toBe('en-US');
    expect(i18n.t('common.menu.checkForUpdates')).toBe('Check for updates…');
  });

  it('keeps going when a listener throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    const offBad = onAppLanguageApplied(() => {
      throw new Error('menu failed');
    });
    const offGood = onAppLanguageApplied(after);

    await applyAppLanguage('de-DE');
    offBad();
    offGood();

    expect(after).toHaveBeenCalledWith('de-DE');
    error.mockRestore();
  });

  it('starts in the language the renderer saved in the backend', async () => {
    mocks.httpRequest.mockResolvedValue({ language: 'fr-FR' });
    await expect(loadStartupLanguage('en-US')).resolves.toBe('fr-FR');
    expect(mocks.httpRequest).toHaveBeenCalledWith('GET', '/api/settings/client?keys=language', undefined, {
      silentStatuses: [404],
    });
  });

  it('follows the system language when nothing is saved', async () => {
    mocks.store.set('language', 'de-DE');
    mocks.httpRequest.mockRejectedValue(
      new BackendHttpError({ method: 'GET', path: '/api/settings/client', status: 404, body: '' })
    );
    await expect(loadStartupLanguage('es')).resolves.toBe('es-ES');
  });

  it('applies the startup language', async () => {
    mocks.httpRequest.mockResolvedValue({ language: 'pt-BR' });
    await expect(applyStartupAppLanguage('en-US')).resolves.toBe('pt-BR');
    expect(i18n.language).toBe('pt-BR');
  });

  it('lets a switch made while the startup language was being read win', async () => {
    let answer!: (value: unknown) => void;
    mocks.httpRequest.mockReturnValue(new Promise((resolve) => (answer = resolve)));

    const startup = applyStartupAppLanguage('en-US');
    await applyAppLanguage('fr-FR');
    answer({ language: 'ru-RU' });

    await expect(startup).resolves.toBeUndefined();
    expect(i18n.language).toBe('fr-FR');
  });

  it('gives texts in another language without switching the app', async () => {
    await applyAppLanguage('en-US');
    const t = await translatorFor('zh');

    expect(t('common.nodeRuntime.download')).toBe('下载');
    expect(i18n.language).toBe('en-US');
    expect(i18n.t('common.nodeRuntime.download')).toBe('Download');
  });

  it('uses the language it applied last time when the backend is unreachable', async () => {
    mocks.store.set('language', 'ko-KR');
    mocks.httpRequest.mockRejectedValue(new TypeError('fetch failed'));
    await expect(loadStartupLanguage('en-US')).resolves.toBe('ko-KR');
  });
});
