import { SUPPORTED_LANGUAGES, normalizeLanguageCode } from '@/common/config/i18n';

/** Every app language under its own name, as the language list shows it. */
export const LANGUAGE_NATIVE_NAMES: Readonly<Record<string, string>> = {
  'de-DE': 'Deutsch',
  'en-US': 'English',
  'es-ES': 'Español',
  'fa-IR': 'فارسی',
  'fr-FR': 'Français',
  'ja-JP': '日本語',
  'ko-KR': '한국어',
  'pt-BR': 'Português (BR)',
  'ru-RU': 'Русский',
  'tr-TR': 'Türkçe',
  'uk-UA': 'Українська',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
};

export const nativeLanguageName = (language: string): string => LANGUAGE_NATIVE_NAMES[language] ?? language;

/**
 * The order of the language list: the language in use first, then the others by their own names. One fixed collation,
 * so the list reads the same whatever language it is shown in: the Latin names from Deutsch to Türkçe, then the
 * Cyrillic, Arabic, Korean and Chinese-character ones.
 */
export const languageListOrder = (current: string): string[] => {
  const inUse = normalizeLanguageCode(current);
  const collator = new Intl.Collator('en', { sensitivity: 'base' });
  const others = SUPPORTED_LANGUAGES.filter((language) => language !== inUse).toSorted((a, b) =>
    collator.compare(nativeLanguageName(a), nativeLanguageName(b))
  );
  return [inUse, ...others];
};
