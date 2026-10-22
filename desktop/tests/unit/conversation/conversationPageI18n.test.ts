import { beforeAll, describe, expect, it } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import enConversation from '@/renderer/services/i18n/locales/en-US/conversation.json';
import zhConversation from '@/renderer/services/i18n/locales/zh-CN/conversation.json';
import twConversation from '@/renderer/services/i18n/locales/zh-TW/conversation.json';
import enPreview from '@/renderer/services/i18n/locales/en-US/preview.json';
import zhPreview from '@/renderer/services/i18n/locales/zh-CN/preview.json';
import twPreview from '@/renderer/services/i18n/locales/zh-TW/preview.json';
import { permissionKey } from '@/renderer/pages/conversation/Preview/browser/muBrowser/format';

/**
 * The language files behind the conversation page's counts and the browser step bar: English says "1 topic", not
 * "1 topics", and every key the code builds at runtime exists in the three languages the app is written in.
 */
let i18n: I18n;
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({
    lng: 'en-US',
    resources: {
      'en-US': { translation: { conversation: enConversation, preview: enPreview } },
      'zh-CN': { translation: { conversation: zhConversation, preview: zhPreview } },
      'zh-TW': { translation: { conversation: twConversation, preview: twPreview } },
    },
    interpolation: { escapeValue: false },
    // A missing key must not be hidden behind the English one.
    fallbackLng: false,
  });
});

describe('counted sentences on the conversation page', () => {
  it('uses the singular for one in English', async () => {
    await i18n.changeLanguage('en-US');
    expect(i18n.t('conversation.history.batchArchiveSuccess', { count: 1 })).toBe('Archived 1 conversation');
    expect(i18n.t('conversation.history.batchArchiveSuccess', { count: 3 })).toBe('Archived 3 conversations');
    expect(i18n.t('conversation.history.batchArchiveConfirm', { count: 1 })).toMatch(
      /^Archive 1 selected conversation\?/
    );
    expect(i18n.t('conversation.history.archiveProjectConfirm', { name: 'mu', count: 1 })).toContain(
      'Its 1 conversation will'
    );
    expect(i18n.t('conversation.history.archiveProjectConfirm', { name: 'mu', count: 2 })).toContain(
      'Its 2 conversations will'
    );
    expect(i18n.t('conversation.explorer.imported', { count: 1 })).toBe('Imported 1 file');
    expect(i18n.t('conversation.explorer.scm.actions.confirmDiscardUntracked', { count: 1 })).toBe(
      '1 new file will be moved to the trash.'
    );
    expect(i18n.t('conversation.explorer.scm.actions.confirmDiscardTracked', { count: 1 })).toContain('1 file will');
  });

  it('says the same thing in Chinese whatever the count', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(i18n.t('conversation.history.batchArchiveSuccess', { count: 1 })).toBe('已归档 1 个话题');
    expect(i18n.t('conversation.explorer.imported', { count: 2 })).toBe('已导入 2 个文件');
    await i18n.changeLanguage('zh-TW');
    expect(i18n.t('conversation.explorer.imported', { count: 1 })).toBe('已匯入 1 個檔案');
  });
});

describe('words the sidebar and the minimap show', () => {
  it('labels minimap questions and answers in each language', async () => {
    const labels = async (language: string) => {
      await i18n.changeLanguage(language);
      return [i18n.t('conversation.minimap.questionLabel'), i18n.t('conversation.minimap.answerLabel')];
    };
    expect(await labels('en-US')).toEqual(['Q:', 'A:']);
    expect(await labels('zh-CN')).toEqual(['问：', '答：']);
    expect(await labels('zh-TW')).toEqual(['問：', '答：']);
  });

  it('has no English left in the Traditional Chinese sidebar', async () => {
    await i18n.changeLanguage('zh-TW');
    const keys = [
      'batchManage',
      'batchModeExit',
      'selectAll',
      'batchDelete',
      'batchNoSelection',
      'export',
      'pin',
      'unpin',
      'pinFailed',
      'pinnedSection',
    ];
    for (const key of keys) {
      expect(i18n.t(`conversation.history.${key}`), key).not.toMatch(/[A-Za-z]{3,}/);
    }
    expect(i18n.t('conversation.history.selectedCount', { count: 2 })).toBe('已選 2 項');
    expect(i18n.t('conversation.history.batchDeleteSuccess', { count: 1 })).toBe('已刪除 1 個話題');
  });
});

describe('keys the browser step bar builds at runtime', () => {
  const permissionIds = [
    'geolocation',
    'media',
    'notifications',
    'clipboard-read',
    'clipboard-sanitized-write',
    'display-capture',
    'midi',
    'midiSysex',
    'fullscreen',
    'pointerLock',
    'hid',
    'serial',
    'usb',
    'storage-access',
    'top-level-storage-access',
    'openExternal',
    'mediaKeySystem',
    'window-management',
  ];
  const detachCauses = ['tab_closed', 'connection', 'devtools', 'crashed'];

  it.each(['en-US', 'zh-CN', 'zh-TW'])('exist in %s', async (language) => {
    await i18n.changeLanguage(language);
    for (const id of permissionIds) {
      const key = permissionKey(id);
      expect(key, id).toBeDefined();
      expect(i18n.exists(key as string), `${language} ${key}`).toBe(true);
    }
    for (const cause of detachCauses) {
      expect(i18n.exists(`preview.muBrowser.detachReason.${cause}`), `${language} ${cause}`).toBe(true);
    }
  });
});
