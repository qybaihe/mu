import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createInstance, type TFunction } from 'i18next';
import { MU_COMMAND_WORDS, commandDescription } from '@/renderer/utils/chat/muCommands';

const LOCALES = path.resolve(__dirname, '../../../../packages/desktop/src/renderer/services/i18n/locales');
const languages = readdirSync(LOCALES).filter((name) => /^[a-z]{2}-[A-Z]{2}$/.test(name));
const muTexts = (language: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(LOCALES, language, 'mu.json'), 'utf8')) as Record<string, unknown>;

const translator = (language: string): TFunction => {
  const i18n = createInstance();
  void i18n.init({
    lng: language,
    initImmediate: false,
    resources: { [language]: { translation: { mu: muTexts(language) } } },
    interpolation: { escapeValue: false },
  });
  return i18n.t;
};

const [englishBoard, chineseBoard] = MU_COMMAND_WORDS.get('board') ?? [];

describe("mu's slash commands in the reader's language", () => {
  it('has a line for every one of mu’s commands in all 13 languages, and none for a command mu does not have', () => {
    expect(languages).toHaveLength(13);
    for (const language of languages) {
      const lines = muTexts(language).commands as Record<string, string>;
      expect(Object.keys(lines).toSorted(), language).toEqual([...MU_COMMAND_WORDS.keys()].toSorted());
      for (const [name, line] of Object.entries(lines)) expect(line.trim(), `${language} ${name}`).not.toBe('');
    }
  });

  it('shows an English reader mu’s English words, and a Chinese reader mu’s Chinese words', () => {
    const english = translator('en-US');
    const chinese = translator('zh-CN');
    for (const [name, words] of MU_COMMAND_WORDS) {
      expect(commandDescription({ name, description: words[0] }, english)).toBe(words[0]);
      if (words[1]) expect(commandDescription({ name, description: words[1] }, chinese)).toBe(words[1]);
    }
  });

  it('turns mu’s English or Chinese into the reader’s language, whichever mu started in', () => {
    const japanese = translator('ja-JP');
    const german = translator('de-DE');
    const line = (muTexts('ja-JP').commands as Record<string, string>).board;
    expect(commandDescription({ name: 'board', description: englishBoard }, japanese)).toBe(line);
    expect(commandDescription({ name: 'board', description: chineseBoard }, japanese)).toBe(line);
    // The app was switched to English after mu started in Chinese.
    expect(commandDescription({ name: 'board', description: chineseBoard }, translator('en-US'))).toBe(englishBoard);
    expect(
      commandDescription({ name: 'import-chat', description: MU_COMMAND_WORDS.get('import-chat')![0] }, german)
    ).toBe((muTexts('de-DE').commands as Record<string, string>)['import-chat']);
  });

  it('leaves another agent’s command of the same name, a template or skill, and reworded text as they came', () => {
    const japanese = translator('ja-JP');
    const claudeReview = 'Review a pull request';
    expect(commandDescription({ name: 'review', description: claudeReview }, japanese)).toBe(claudeReview);
    expect(commandDescription({ name: 'skill:pdf', description: 'Read and fill PDF forms' }, japanese)).toBe(
      'Read and fill PDF forms'
    );
    const reworded = `${englishBoard} (new)`;
    expect(commandDescription({ name: 'board', description: reworded }, japanese)).toBe(reworded);
  });
});
