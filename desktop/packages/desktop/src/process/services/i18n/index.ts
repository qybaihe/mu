/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import i18n, { type TFunction } from 'i18next';
import { MU_NAME_POST_PROCESSOR, muNamePostProcessor } from '@/common/kyrn/displayName';
import { httpRequest, isBackendHttpError } from '@/common/adapter/httpBridge';
import { ProcessConfig } from '@process/utils/initStorage';
import {
  DEFAULT_LANGUAGE,
  normalizeLanguageCode,
  mergeWithFallback,
  ensureAndSwitch,
  type LocaleData,
  type SupportedLanguage,
} from '@/common/config/i18n';
import { resolveStartupLanguage, writeAppLanguageFile } from './appLanguage';

// Static imports – Vite bundles these into the main-process output so they
// work correctly in both development and production (no fs.readFile needed).
import enUS from '@renderer/services/i18n/locales/en-US/index';
import zhCN from '@renderer/services/i18n/locales/zh-CN/index';
import jaJP from '@renderer/services/i18n/locales/ja-JP/index';
import zhTW from '@renderer/services/i18n/locales/zh-TW/index';
import koKR from '@renderer/services/i18n/locales/ko-KR/index';
import trTR from '@renderer/services/i18n/locales/tr-TR/index';
import ruRU from '@renderer/services/i18n/locales/ru-RU/index';
import ukUA from '@renderer/services/i18n/locales/uk-UA/index';
import ptBR from '@renderer/services/i18n/locales/pt-BR/index';
import deDE from '@renderer/services/i18n/locales/de-DE/index';
import esES from '@renderer/services/i18n/locales/es-ES/index';
import frFR from '@renderer/services/i18n/locales/fr-FR/index';
import faIR from '@renderer/services/i18n/locales/fa-IR/index';

// All locale data keyed by language code.
// NOTE: When adding a new language, add a static import above and an entry here.
// These MUST be static imports (not dynamic) because the main process is bundled
// by Vite and the JSON files won't exist on disk in production.
const localeData: LocaleData = {
  'en-US': enUS,
  'zh-CN': zhCN,
  'ja-JP': jaJP,
  'zh-TW': zhTW,
  'ko-KR': koKR,
  'tr-TR': trTR,
  'ru-RU': ruRU,
  'uk-UA': ukUA,
  'pt-BR': ptBR,
  'de-DE': deDE,
  'es-ES': esES,
  'fr-FR': frFR,
  'fa-IR': faIR,
};

const fallbackData = localeData[DEFAULT_LANGUAGE] ?? {};

function getLocaleModules(locale: string): Record<string, unknown> {
  const data = localeData[locale];
  if (!data) return fallbackData;
  if (locale === DEFAULT_LANGUAGE) return data;
  return mergeWithFallback(fallbackData, data);
}

/** Resolves when i18n is fully initialized with the user's language */
export const i18nReady = (async (): Promise<void> => {
  await i18n.use(muNamePostProcessor).init({
    resources: {
      [DEFAULT_LANGUAGE]: { translation: getLocaleModules(DEFAULT_LANGUAGE) },
    },
    fallbackLng: DEFAULT_LANGUAGE,
    debug: false,
    interpolation: { escapeValue: false },
    // Tray and dialog strings may name the upstream product: shown as mu (see common/kyrn/displayName.ts).
    postProcess: [MU_NAME_POST_PROCESSOR],
  });

  const language = await ProcessConfig.get('language');
  if (language) {
    await ensureAndSwitch(i18n, language, getLocaleModules);
  }
})().catch((error) => {
  console.error('[Main Process] Failed to initialize i18n:', error);
});

/**
 * The texts in `language`, without switching the main process to it: for what shows before the app language is
 * known, such as the first-start questions asked before the backend (which stores it) runs.
 */
export async function translatorFor(language: string): Promise<TFunction> {
  await i18nReady;
  const normalized = normalizeLanguageCode(language);
  if (!i18n.hasResourceBundle(normalized, 'translation')) {
    i18n.addResourceBundle(normalized, 'translation', getLocaleModules(normalized), true, true);
  }
  return i18n.getFixedT(normalized);
}

/**
 * Change language
 */
export async function changeLanguage(language: string): Promise<void> {
  await i18nReady;
  await ensureAndSwitch(i18n, language, getLocaleModules);
}

type AppLanguageListener = (language: SupportedLanguage) => void;
const appLanguageListeners = new Set<AppLanguageListener>();

/**
 * Run `listener` after every {@link applyAppLanguage}, once the main-process texts are in the new language: the
 * places that keep built text (application menu, tray menu) rebuild here. Returns the unsubscribe function.
 */
export function onAppLanguageApplied(listener: AppLanguageListener): () => void {
  appLanguageListeners.add(listener);
  return () => {
    appLanguageListeners.delete(listener);
  };
}

let applyQueue: Promise<unknown> = Promise.resolve();
let applyRequests = 0;

/**
 * Make the main process follow the app language: switch its i18next, remember the language as the startup hint
 * (the legacy config key the renderer is also handed as its first-paint hint), tell the harness through
 * `~/.mu/app-language`, then let the listeners rebuild what they show.
 */
export function applyAppLanguage(language: string): Promise<SupportedLanguage> {
  // One at a time, in the order asked: two quick switches must not finish the wrong way round.
  applyRequests += 1;
  const run = applyQueue.then(() => applyAppLanguageNow(language));
  applyQueue = run.catch((): undefined => undefined);
  return run;
}

async function applyAppLanguageNow(language: string): Promise<SupportedLanguage> {
  const normalized = normalizeLanguageCode(language);
  await changeLanguage(normalized);
  try {
    if ((await ProcessConfig.get('language')) !== normalized) {
      await ProcessConfig.set('language', normalized);
    }
  } catch (error) {
    console.warn('[i18n] Could not remember the app language:', error);
  }
  await writeAppLanguageFile(normalized);
  for (const listener of appLanguageListeners) {
    try {
      listener(normalized);
    } catch (error) {
      console.error('[i18n] App language listener failed:', error);
    }
  }
  return normalized;
}

/** The saved app language from the backend's client settings (where the renderer saves it). */
async function readSavedAppLanguage(): Promise<string | undefined> {
  try {
    const settings = await httpRequest<Record<string, unknown> | undefined>(
      'GET',
      '/api/settings/client?keys=language',
      undefined,
      { silentStatuses: [404] }
    );
    const value = settings?.language;
    return typeof value === 'string' && value.trim() ? value : undefined;
  } catch (error) {
    if (isBackendHttpError(error) && error.status === 404) return undefined;
    throw error;
  }
}

/**
 * The language the main process starts in: the saved one, else the system language (see resolveStartupLanguage).
 *
 * @param systemLocale Electron's `app.getLocale()`, the value the renderer sees as `navigator.language`
 */
export function loadStartupLanguage(systemLocale: string | undefined): Promise<SupportedLanguage> {
  return resolveStartupLanguage({
    readSaved: readSavedAppLanguage,
    readLocalHint: async () => (await ProcessConfig.get('language')) || undefined,
    systemLocale: () => systemLocale,
  });
}

/**
 * Start in the saved app language ({@link loadStartupLanguage}), unless the renderer already switched the language
 * while it was being read: that switch is newer and wins. Resolves to the language applied, or undefined.
 */
export async function applyStartupAppLanguage(
  systemLocale: string | undefined
): Promise<SupportedLanguage | undefined> {
  const requestsBefore = applyRequests;
  const language = await loadStartupLanguage(systemLocale);
  if (applyRequests !== requestsBefore) return undefined;
  return applyAppLanguage(language);
}

export { normalizeLanguageCode };
export default i18n;
