import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { muHome } from '@process/agent/kyrn/naming';
import { DEFAULT_LANGUAGE, normalizeLanguageCode, type SupportedLanguage } from '@/common/config/i18n';

/**
 * The file in the mu home that tells the harness which language the app shows: one language code
 * (`en-US`, `zh-TW`, …) and a newline. The harness runs as its own process and has no other way to learn it.
 */
export const APP_LANGUAGE_FILE = 'app-language';

export function appLanguageFilePath(home?: string): string {
  return join(muHome(home), APP_LANGUAGE_FILE);
}

/**
 * Write the app language for the harness. Atomic (a temporary file renamed over the old one), so the harness never
 * reads half a line; skipped when the file already says the same. Never throws: a failure is logged, and the
 * harness keeps whatever it read before.
 *
 * @param home the user's home directory; tests pass a temporary one
 */
export async function writeAppLanguageFile(language: string, home?: string): Promise<void> {
  const content = `${normalizeLanguageCode(language)}\n`;
  try {
    const dir = muHome(home);
    const target = join(dir, APP_LANGUAGE_FILE);
    const current = await readFile(target, 'utf8').catch((): null => null);
    if (current === content) return;
    await mkdir(dir, { recursive: true });
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temp, content, 'utf8');
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  } catch (error) {
    console.warn('[i18n] Could not write the app language for the mu harness:', error);
  }
}

export type StartupLanguageSources = {
  /** The language saved in the app settings (the backend), or undefined when none is saved. Throws when unreachable. */
  readSaved: () => Promise<string | undefined>;
  /** The language the main process last applied, kept in its own config file; read only when the backend is unreachable. */
  readLocalHint: () => Promise<string | undefined>;
  /** The operating system's language, as Electron reports it. */
  systemLocale: () => string | undefined;
};

/**
 * The language the main process starts in, chosen the way the renderer chooses its own: the saved setting, else the
 * system language. When the backend cannot be reached the renderer falls back to the language main injected at
 * startup, which is the local hint here.
 */
export async function resolveStartupLanguage(sources: StartupLanguageSources): Promise<SupportedLanguage> {
  try {
    const saved = await sources.readSaved();
    if (saved) return normalizeLanguageCode(saved);
  } catch {
    const hint = await sources.readLocalHint().catch((): undefined => undefined);
    if (hint) return normalizeLanguageCode(hint);
  }
  return normalizeLanguageCode(sources.systemLocale() || DEFAULT_LANGUAGE);
}
