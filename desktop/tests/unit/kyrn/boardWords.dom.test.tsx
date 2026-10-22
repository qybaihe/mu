import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { Activity } from '@/common/kyrn/types';
import { formatNumber } from '@/renderer/services/i18n/format';
import en from '@/renderer/services/i18n/locales/en-US/common.json';
import zhCN from '@/renderer/services/i18n/locales/zh-CN/common.json';
import zhTW from '@/renderer/services/i18n/locales/zh-TW/common.json';
import Board from '@/renderer/pages/conversation/KyrnPanel/Board';
import { toBoardUpdate, type BoardNote } from '@/renderer/pages/conversation/KyrnPanel/Board/board';
import { NOTE_SENTENCES, noteWords } from '@/renderer/pages/conversation/KyrnPanel/Board/noteWords';
import { boardWords } from '@/renderer/pages/conversation/KyrnPanel/Board/wording';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'zh-CN',
    fallbackLng: 'en-US',
    resources: {
      'en-US': { translation: { common: en } },
      'zh-CN': { translation: { common: zhCN } },
      'zh-TW': { translation: { common: zhTW } },
    },
    interpolation: { escapeValue: false },
  });
});
afterEach(cleanup);

let next = 0;
const event = (kind: string, payload: Record<string, unknown>): Activity => ({
  id: `e${++next}`,
  at: next,
  kind,
  payload,
});
/**
 * A fixed board as the harness writes it when the model did not answer: in English, because the person typed
 * English, though the app is in Chinese.
 */
const fixed = (payload: Record<string, unknown> = {}) =>
  event('board.update', {
    progress: '3 of 5 things on the checklist are done.',
    now: 'Running the tests or checks to see whether the change works. (On: tests for the login page)',
    confirm: [],
    confirmCodes: [],
    phase: 'checking',
    focusText: 'tests for the login page',
    needsUser: false,
    done: 3,
    total: 5,
    by: 'rules',
    ended: false,
    ...payload,
  });

const show = (events: Activity[]) =>
  render(
    <I18nextProvider i18n={i18n}>
      <Board events={[event('board.switched', { on: true, cwd: '/work/app' }), ...events]} conversationId='conv' />
    </I18nextProvider>
  );

describe('a fixed board in the app’s language', () => {
  it('is rebuilt from its facts: how far, what now and the item’s own words, what waits on you', () => {
    show([
      fixed({
        needsUser: true,
        confirm: ['It waits for your reply.', 'Keep the old API?'],
        confirmCodes: ['waiting_reply', null],
      }),
    ]);
    expect(screen.getByTestId('mu-board-now')).toHaveTextContent(
      '正在跑测试或检查，看改得对不对。（在做：tests for the login page）'
    );
    expect(screen.getByTestId('mu-board-progress')).toHaveTextContent('清单上 5 件事，做完了 3 件。');
    // The agent's own question is its words and stays.
    expect(screen.getAllByTestId('mu-board-confirm-text').map((item) => item.textContent)).toEqual([
      '它在等你回复。',
      'Keep the old API?',
    ]);
  });

  it('says none yet and all done, in each language', async () => {
    show([fixed({ done: 0, total: 0, phase: undefined, focusText: undefined })]);
    expect(screen.getByTestId('mu-board-progress')).toHaveTextContent('还没有列出要做完的事。');
    expect(screen.getByTestId('mu-board-now')).toHaveTextContent('正在干活。');
    cleanup();
    await i18n.changeLanguage('en-US');
    try {
      show([fixed({ done: 1, total: 1 })]);
      expect(screen.getByTestId('mu-board-progress')).toHaveTextContent('The only checklist item is done.');
      cleanup();
      show([fixed({ done: 4, total: 4 })]);
      expect(screen.getByTestId('mu-board-progress')).toHaveTextContent('All 4 checklist items are done.');
    } finally {
      await i18n.changeLanguage('zh-CN');
    }
  });

  it('leaves a board the model wrote, and one from a harness that sends no codes, as they were written', () => {
    show([fixed({ by: 'model', now: 'Writing the login tests', progress: 'Half way there.' })]);
    expect(screen.getByTestId('mu-board-now')).toHaveTextContent('Writing the login tests');
    cleanup();
    // An older harness: no codes, so its sentence (which may name the item) is kept whole.
    show([fixed({ confirmCodes: undefined, focusText: undefined })]);
    expect(screen.getByTestId('mu-board-now')).toHaveTextContent('(On: tests for the login page)');
    expect(screen.getByTestId('mu-board-progress')).toHaveTextContent('3 of 5 things on the checklist are done.');
  });

  it('says how a run that ended ended, with no stage under it that reads as still going on', () => {
    show([fixed({ ended: true, phase: 'wrapping_up', focusText: undefined, done: 5, total: 5 })]);
    expect(screen.getByTestId('mu-board-state')).toHaveAttribute('data-state', 'done');
    expect(screen.queryByTestId('mu-board-now')).toBeNull();
    expect(screen.getByTestId('mu-board-progress')).toHaveTextContent('清单上的 5 件事都做完了。');
    cleanup();
    // Stopped in the middle of a stage, from a harness that sends no codes too.
    show([fixed({ ended: true, confirmCodes: undefined })]);
    expect(screen.getByTestId('mu-board-state')).toHaveAttribute('data-state', 'stopped');
    expect(screen.queryByTestId('mu-board-now')).toBeNull();
    cleanup();
    // The model's summing up at the end is its own words.
    show([fixed({ ended: true, by: 'model', now: 'All five are in; the login tests pass.' })]);
    expect(screen.getByTestId('mu-board-now')).toHaveTextContent('All five are in; the login tests pass.');
  });
});

describe('reading a fixed board’s codes', () => {
  it('keeps each code with its line through the filtering, and says when the harness sent codes at all', () => {
    const update = toBoardUpdate(
      fixed({
        confirm: ['', 'Keep the old API?', 'It waits for your reply.'],
        confirmCodes: ['waiting_reply', null, 'waiting_reply'],
      })
    );
    expect(update).toMatchObject({
      confirm: ['Keep the old API?', 'It waits for your reply.'],
      confirmCodes: [null, 'waiting_reply'],
      focusText: 'tests for the login page',
    });
    expect(toBoardUpdate(fixed({ confirmCodes: [] }))?.confirmCodes).toEqual([]);
    expect(toBoardUpdate(fixed({ confirmCodes: undefined }))?.confirmCodes).toBeUndefined();
    expect(toBoardUpdate(fixed({ confirm: ['x'], confirmCodes: ['Waiting Reply!'] }))?.confirmCodes).toEqual([null]);
  });

  it('keeps the harness’s sentence for a part it has no wording for', () => {
    const update = toBoardUpdate(fixed({ needsUser: true, confirm: ['It waits.'], confirmCodes: ['waiting_reply'] }))!;
    const none = boardWords(
      update,
      (key) => key,
      () => false,
      String
    );
    expect(none).toEqual({ now: update.now, progress: update.progress, confirm: ['It waits.'] });
    // The stage has a sentence but the item cannot be named: the harness's sentence, which names it, stays.
    const noFocus = boardWords(
      update,
      (key) => `[${key}]`,
      (key) => !key.endsWith('.focus'),
      String
    );
    expect(noFocus.now).toBe(update.now);
  });
});

describe('a fixed line of the account in the app’s language', () => {
  const note = (fields: Record<string, unknown>) =>
    event('board.note', { kind: 'step', by: 'rules', failed: false, ...fields });

  it('is worded again in Chinese when the harness wrote it in English', () => {
    show([
      note({
        sequence: 1,
        at: 1_000,
        text: 'A check failed: npm test',
        code: 'check_failed',
        params: { command: 'npm test' },
      }),
      note({ sequence: 2, at: 2_000, text: 'Looked at 1 file or place', code: 'looked', params: { count: 1 } }),
      note({ sequence: 3, at: 3_000, by: 'model', text: 'The login test fails: the cookie expires too soon.' }),
    ]);
    expect(screen.getByTestId('mu-board-account')).toHaveTextContent('它做了什么');
    expect(screen.getAllByTestId('mu-board-note').map((row) => row.lastElementChild?.textContent)).toEqual([
      'The login test fails: the cookie expires too soon.',
      '看了 1 个文件或地方',
      '检查没通过：npm test',
    ]);
  });

  it('has every fixed line in all 13 languages, each filled with what it names, at any count', async () => {
    const root = path.resolve(__dirname, '../../..');
    const { supportedLanguages } = JSON.parse(
      readFileSync(path.join(root, 'packages/desktop/src/common/config/i18n-config.json'), 'utf8')
    ) as { supportedLanguages: string[] };
    expect(supportedLanguages).toHaveLength(13);
    const locales = await Promise.all(
      supportedLanguages.map(async (language) => {
        const common = JSON.parse(
          readFileSync(
            path.join(root, 'packages/desktop/src/renderer/services/i18n/locales', language, 'common.json'),
            'utf8'
          )
        ) as Record<string, unknown>;
        const local = createInstance();
        await local.init({
          lng: language,
          resources: { [language]: { translation: { common } } },
          interpolation: { escapeValue: false },
        });
        return { language, local };
      })
    );
    for (const { language, local } of locales) {
      for (const [code, names] of NOTE_SENTENCES) {
        // One, a few, many: every plural form a language has.
        for (const count of [1, 3, 5, 21]) {
          const params = Object.fromEntries(
            names.map((name) => [name, name === 'count' || name === 'round' ? count : `<${name}>`])
          );
          const line: BoardNote = {
            id: '1:1',
            sequence: 1,
            at: 1,
            text: '',
            by: 'rules',
            code,
            params,
            failed: false,
            restored: false,
          };
          const said = noteWords(line, local.t, (key) => local.exists(key));
          expect(said, `${language} ${code}`).toBeDefined();
          expect(said, `${language} ${code}`).not.toContain('{{');
          for (const name of names) {
            const value = params[name];
            expect(said, `${language} ${code} ${name}`).toContain(
              typeof value === 'number' ? formatNumber(value, language) : value
            );
          }
        }
      }
    }
  });
});
