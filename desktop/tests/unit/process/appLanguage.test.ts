import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appLanguageFilePath, resolveStartupLanguage, writeAppLanguageFile } from '@/process/services/i18n/appLanguage';

describe('writeAppLanguageFile', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mu-app-language-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('creates ~/.mu and writes the language code and a newline', async () => {
    await writeAppLanguageFile('en-US', home);

    expect(readFileSync(join(home, '.mu', 'app-language'), 'utf8')).toBe('en-US\n');
    expect(appLanguageFilePath(home)).toBe(join(home, '.mu', 'app-language'));
  });

  it('writes the normalized code and replaces the previous language', async () => {
    await writeAppLanguageFile('zh-CN', home);
    await writeAppLanguageFile('zh_TW', home);

    expect(readFileSync(join(home, '.mu', 'app-language'), 'utf8')).toBe('zh-TW\n');
    // The temporary file of the atomic write never stays behind.
    expect(readdirSync(join(home, '.mu'))).toEqual(['app-language']);
  });

  it('writes into ~/.kyrn on a machine whose home has not moved yet', async () => {
    mkdirSync(join(home, '.kyrn'));

    await writeAppLanguageFile('fr-FR', home);

    expect(readFileSync(join(home, '.kyrn', 'app-language'), 'utf8')).toBe('fr-FR\n');
    expect(existsSync(join(home, '.mu'))).toBe(false);
  });

  it('logs and returns instead of throwing when the file cannot be written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A file where the mu home directory should be: mkdir and the write both fail.
    writeFileSync(join(home, '.mu'), 'not a directory');

    await expect(writeAppLanguageFile('en-US', home)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

const unreachable = async (): Promise<string | undefined> => {
  throw new Error('offline');
};

describe('resolveStartupLanguage', () => {
  it('starts in the saved app language', async () => {
    const language = await resolveStartupLanguage({
      readSaved: async () => 'zh-TW',
      readLocalHint: async () => 'de-DE',
      systemLocale: () => 'en-US',
    });
    expect(language).toBe('zh-TW');
  });

  it('follows the system language when no language is saved, like the renderer', async () => {
    const readLocalHint = vi.fn(async () => 'de-DE');
    const language = await resolveStartupLanguage({
      readSaved: async () => undefined,
      readLocalHint,
      systemLocale: () => 'ja',
    });
    expect(language).toBe('ja-JP');
    expect(readLocalHint).not.toHaveBeenCalled();
  });

  it('uses the local hint when the backend cannot be reached', async () => {
    const language = await resolveStartupLanguage({
      readSaved: async () => {
        throw new Error('ECONNREFUSED');
      },
      readLocalHint: async () => 'ko-KR',
      systemLocale: () => 'en-US',
    });
    expect(language).toBe('ko-KR');
  });

  it('falls back to the system language, then English', async () => {
    await expect(
      resolveStartupLanguage({
        readSaved: unreachable,
        readLocalHint: async () => undefined,
        systemLocale: () => 'zh-HK',
      })
    ).resolves.toBe('zh-TW');
    await expect(
      resolveStartupLanguage({ readSaved: unreachable, readLocalHint: unreachable, systemLocale: () => undefined })
    ).resolves.toBe('en-US');
  });
});
