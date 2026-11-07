import { beforeAll, describe, expect, it } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import { html } from 'diff2html';
import zhPreview from '@/renderer/services/i18n/locales/zh-CN/preview.json';
import enPreview from '@/renderer/services/i18n/locales/en-US/preview.json';
import { diff2htmlTemplates } from '@/renderer/components/media/diff2htmlTemplates';

let i18n: I18n;
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({
    lng: 'zh-CN',
    resources: { 'zh-CN': { translation: { preview: zhPreview } }, 'en-US': { translation: { preview: enPreview } } },
    interpolation: { escapeValue: false },
  });
});

const changed = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-const a = 1;',
  '+const a = 2;',
  '',
].join('\n');

const added = [
  'diff --git a/new.ts b/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.ts',
  '@@ -0,0 +1 @@',
  '+x',
  '',
].join('\n');

const render = (diff: string) =>
  html(diff, {
    drawFileList: false,
    renderNothingWhenEmpty: false,
    rawTemplates: diff2htmlTemplates(i18n.t.bind(i18n)),
  });

describe('diff2html in the reader’s language', () => {
  it('tags each file in the reader’s words, with diff2html’s own classes kept', async () => {
    await i18n.changeLanguage('zh-CN');
    const out = render(changed);
    expect(out).toContain('<span class="d2h-tag d2h-changed d2h-changed-tag">已修改</span>');
    expect(out).not.toContain('CHANGED');
    expect(render(added)).toContain('d2h-added-tag">新增</span>');
  });

  it('follows a language switch when the templates are built again', async () => {
    await i18n.changeLanguage('en-US');
    expect(render(changed)).toContain('d2h-changed-tag">Changed</span>');
  });

  it('keeps markup and mustache out of a translation', () => {
    const templates = diff2htmlTemplates(((key: string) =>
      key === 'preview.diffTag.changed' ? '<b>{{x}}</b>' : key) as never);
    expect(templates['tag-file-changed']).toContain('&lt;b&gt;&#123;&#123;x&#125;&#125;&lt;/b&gt;');
    expect(templates['generic-empty-diff']).toContain('{{CSSLineClass.INFO}}');
  });
});
