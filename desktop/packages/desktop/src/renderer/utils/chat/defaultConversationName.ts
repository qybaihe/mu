import deDE from '@/renderer/services/i18n/locales/de-DE/conversation.json';
import enUS from '@/renderer/services/i18n/locales/en-US/conversation.json';
import esES from '@/renderer/services/i18n/locales/es-ES/conversation.json';
import faIR from '@/renderer/services/i18n/locales/fa-IR/conversation.json';
import frFR from '@/renderer/services/i18n/locales/fr-FR/conversation.json';
import jaJP from '@/renderer/services/i18n/locales/ja-JP/conversation.json';
import koKR from '@/renderer/services/i18n/locales/ko-KR/conversation.json';
import ptBR from '@/renderer/services/i18n/locales/pt-BR/conversation.json';
import ruRU from '@/renderer/services/i18n/locales/ru-RU/conversation.json';
import trTR from '@/renderer/services/i18n/locales/tr-TR/conversation.json';
import ukUA from '@/renderer/services/i18n/locales/uk-UA/conversation.json';
import zhCN from '@/renderer/services/i18n/locales/zh-CN/conversation.json';
import zhTW from '@/renderer/services/i18n/locales/zh-TW/conversation.json';

/**
 * A new conversation is stored under the default title of the language active when it was created ("New Chat",
 * "新会话", …). Whether a name is still that default must not depend on the language shown now, or a conversation
 * created before a language switch would never be retitled.
 */
const DEFAULT_NAMES = new Set([
  ...[deDE, enUS, esES, faIR, frFR, jaJP, koKR, ptBR, ruRU, trTR, ukUA, zhCN, zhTW]
    .map((locale) => locale.welcome?.newConversation)
    .filter((name): name is string => typeof name === 'string' && name.trim() !== ''),
  // Earlier English default titles, still stored on conversations created before the wording changed.
  'New Chat',
]);

/** Whether a conversation name is the default title in any of the app's languages. */
export const isDefaultConversationName = (name: string | null | undefined): boolean =>
  typeof name === 'string' && DEFAULT_NAMES.has(name.trim());
