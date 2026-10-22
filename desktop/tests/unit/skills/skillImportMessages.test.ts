import { describe, expect, it } from 'vitest';
import { createInstance, type TFunction } from 'i18next';
import enSettings from '@/renderer/services/i18n/locales/en-US/settings.json';
import zhSettings from '@/renderer/services/i18n/locales/zh-CN/settings.json';
import { buildSkillImportNotice, formatSkillSize } from '@/renderer/pages/settings/SkillsSettings/skillImportMessages';

const translator = (language: 'en-US' | 'zh-CN', settings: Record<string, unknown>): TFunction => {
  const i18n = createInstance();
  void i18n.init({
    lng: language,
    initImmediate: false,
    resources: { [language]: { translation: { settings } } },
    interpolation: { escapeValue: false },
  });
  return i18n.t;
};

const en = translator('en-US', enSettings);
const zh = translator('zh-CN', zhSettings);

const invalidZip = { source_name: 'broken.zip', code: 'SKILL_IMPORT_INVALID_ZIP' };
const noSkill = { source_name: 'empty', code: 'SKILL_IMPORT_NO_SKILL_FOUND' };

describe('buildSkillImportNotice', () => {
  it('counts imported skills with the right plural and lists the names in the app language', () => {
    expect(buildSkillImportNotice({ skill_names: ['alpha'] }, en, 'en-US').message).toBe('Imported 1 skill: alpha');
    expect(buildSkillImportNotice({ skill_names: ['alpha', 'beta', 'gamma'] }, en, 'en-US').message).toBe(
      'Imported 3 skills: alpha, beta, and gamma'
    );
    expect(buildSkillImportNotice({ skill_names: ['alpha', 'beta'] }, zh, 'zh-CN').message).toBe(
      '已导入 2 个技能：alpha 和 beta'
    );
  });

  it('words partial and total failures in the app language, one item per failed source', () => {
    const partial = buildSkillImportNotice({ skill_names: ['alpha'], failed: [invalidZip] }, en, 'en-US');
    expect(partial.type).toBe('warning');
    expect(partial.message).toBe(
      'Imported 1 skill, 1 failed: broken.zip: The selected zip archive is not a valid skill package'
    );

    const failed = buildSkillImportNotice({ failed: [invalidZip, noSkill] }, en, 'en-US');
    expect(failed.type).toBe('error');
    expect(failed.message).toBe(
      "Couldn't import 2 skills: broken.zip: The selected zip archive is not a valid skill package; empty: No valid skill was found in the selected path"
    );

    expect(buildSkillImportNotice({ failed: [invalidZip] }, zh, 'zh-CN').message).toBe(
      '1 个技能导入失败：broken.zip：所选 zip 不是有效的技能包'
    );
  });

  it('puts a size detail in the brackets of the app language', () => {
    const tooLarge = {
      source_name: 'big',
      code: 'SKILL_IMPORT_TOTAL_TOO_LARGE',
      actual_bytes: 12 * 1024 * 1024,
      limit_bytes: 10 * 1024 * 1024,
    };
    expect(buildSkillImportNotice({ failed: [tooLarge] }, zh, 'zh-CN').message).toContain(
      '（总大小为 12 MB，限制为 10 MB）'
    );
  });
});

describe('formatSkillSize', () => {
  it('formats the number in the app language', () => {
    expect(formatSkillSize(512, 'en-US')).toBe('512 B');
    expect(formatSkillSize(1536, 'en-US')).toBe('1.5 KB');
    expect(formatSkillSize(1.5 * 1024 * 1024, 'de-DE')).toBe('1,5 MB');
    expect(formatSkillSize(12.4 * 1024 * 1024, 'en-US')).toBe('12 MB');
    expect(formatSkillSize(undefined, 'en-US')).toBeNull();
  });
});
