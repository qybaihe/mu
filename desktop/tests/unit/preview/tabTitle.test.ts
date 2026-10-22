import { beforeAll, describe, expect, it } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import enPreview from '@/renderer/services/i18n/locales/en-US/preview.json';
import zhPreview from '@/renderer/services/i18n/locales/zh-CN/preview.json';
import { fallbackTabTitle, previewTabDisplayTitle } from '@/renderer/pages/conversation/Preview/context/tabTitle';

let i18n: I18n;
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({
    lng: 'en-US',
    resources: { 'en-US': { translation: { preview: enPreview } }, 'zh-CN': { translation: { preview: zhPreview } } },
    interpolation: { escapeValue: false },
  });
});

const shown = (title: string, content_type: Parameters<typeof fallbackTabTitle>[0]) =>
  previewTabDisplayTitle({ title, content_type }, i18n.t.bind(i18n));

describe('the title stored for a tab without a name', () => {
  it('is a fixed sentinel per type, never a translated word', () => {
    expect(fallbackTabTitle('image')).toBe('Image');
    expect(fallbackTabTitle('diff')).toBe('Diff');
    expect(fallbackTabTitle('markdown')).toBe('Markdown');
    expect(fallbackTabTitle('code')).toBe('Code');
    expect(fallbackTabTitle('code', 'typescript')).toBe('typescript');
    expect(fallbackTabTitle('pdf')).toBe('Preview');
  });
});

describe('the title the tab strip shows', () => {
  it('shows the reader’s word for a sentinel, and follows a language switch', async () => {
    await i18n.changeLanguage('en-US');
    expect(shown('Image', 'image')).toBe('Image');

    await i18n.changeLanguage('zh-CN');
    expect(shown('Image', 'image')).toBe('图片');
    expect(shown('Code', 'code')).toBe('代码');
    expect(shown('Preview', 'pdf')).toBe('预览');
    expect(shown('Diff', 'diff')).toBe('差异');
    expect(shown('Markdown', 'markdown')).toBe('Markdown');
  });

  it('leaves a real name alone, even one that looks like another type’s sentinel', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(shown('Example Domain', 'markdown')).toBe('Example Domain');
    expect(shown('report.pdf', 'pdf')).toBe('report.pdf');
    expect(shown('typescript', 'code')).toBe('typescript');
    // "Image" is only a sentinel on an image tab.
    expect(shown('Image', 'code')).toBe('Image');
  });
});
