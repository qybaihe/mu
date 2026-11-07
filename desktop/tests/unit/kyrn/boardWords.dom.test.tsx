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
import {
  HELPER_FAILURES,
  labeledTitles,
  NOTE_NUMBERS,
  NOTE_SENTENCES,
  noteWords,
  withLabels,
} from '@/renderer/pages/conversation/KyrnPanel/Board/noteWords';
import { boardWords, codedLine } from '@/renderer/pages/conversation/KyrnPanel/Board/wording';

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

/** The app's 13 languages, each with its own translator over its common.json. */
async function allLocales() {
  const root = path.resolve(__dirname, '../../..');
  const { supportedLanguages } = JSON.parse(
    readFileSync(path.join(root, 'packages/desktop/src/common/config/i18n-config.json'), 'utf8')
  ) as { supportedLanguages: string[] };
  expect(supportedLanguages).toHaveLength(13);
  return Promise.all(
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
}

/** One rules line of the account, for the sentence-level checks. */
const ruleLine = (code: string, params: Record<string, string | number>, who?: string): BoardNote => ({
  id: '1:1',
  sequence: 1,
  at: 1,
  text: 'the harness’s own sentence',
  by: 'rules',
  code,
  params,
  failed: false,
  restored: false,
  ...(who ? { who } : {}),
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
    expect(none).toEqual({
      now: update.now,
      progress: update.progress,
      confirm: ['It waits.'],
      headline: '',
      blocked: '',
      next: '',
    });
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
    for (const { language, local } of await allLocales()) {
      for (const [code, names] of NOTE_SENTENCES) {
        // One, a few, many: every plural form a language has.
        for (const count of [1, 3, 5, 21]) {
          const params = Object.fromEntries(names.map((name) => [name, NOTE_NUMBERS.has(name) ? count : `<${name}>`]));
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

describe('board v2’s fixed sentences', () => {
  const zh = (line: BoardNote) => noteWords(line, i18n.t, (key) => i18n.exists(key));

  it('words a long run, a helper back or failed, and a mixed return in the app’s language', () => {
    expect(zh(ruleLine('still_running', { what: 'npm test', minutes: 3 }))).toBe('还在跑 npm test，3 分钟了');
    expect(zh(ruleLine('still_running', { who: 'fixer', what: 'npx vitest', minutes: 6 }, 'fixer'))).toBe(
      'fixer 跑 npx vitest 6 分钟没动静'
    );
    expect(zh(ruleLine('helper_done', { name: 'scout', summary: 'backoff() reads the clock twice' }))).toBe(
      'scout 回来了：backoff() reads the clock twice'
    );
    expect(zh(ruleLine('helper_failed', { name: 'fixer', reason: 'timed_out' }))).toBe('fixer 超时了');
    expect(zh(ruleLine('helper_failed', { name: 'fixer', reason: 'failed', detail: 'ENOENT: no such file' }))).toBe(
      'fixer 出错了：ENOENT: no such file'
    );
    expect(zh(ruleLine('helper_failed', { name: 'fixer', reason: 'stopped' }))).toBe('fixer 被停了');
    // A reason this build does not know keeps the harness's sentence.
    expect(zh(ruleLine('helper_failed', { name: 'fixer', reason: 'vanished' }))).toBeUndefined();
    expect(zh(ruleLine('helpers_back', { count: 2, failed: 1 }))).toBe('回来了 2 个，1 个出错');
    // None failed (or an older harness that does not say): the line as it always was.
    expect(zh(ruleLine('helpers_back', { count: 2, failed: 0 }))).toBe('2 个助手回来了');
    expect(zh(ruleLine('helpers_back', { count: 2 }))).toBe('2 个助手回来了');
  });

  it('shows the new lines in the account, with the helper’s chip only where the sentence does not name it', () => {
    const note = (fields: Record<string, unknown>) =>
      event('board.note', { kind: 'helpers', by: 'rules', failed: false, text: 'the harness’s sentence', ...fields });
    show([
      note({
        sequence: 1,
        at: 1_000,
        who: 'scout',
        code: 'helper_done',
        params: { name: 'scout', summary: 'found it' },
      }),
      note({ sequence: 2, at: 2_000, who: 'docs', by: 'model', text: 'The README is out of date.' }),
      note({ sequence: 3, at: 3_000, who: 'fixer', code: 'still_running', params: { what: 'npm test', minutes: 4 } }),
    ]);
    const rows = screen.getAllByTestId('mu-board-note');
    expect(rows.map((row) => row.lastElementChild?.textContent)).toEqual([
      'fixer还在跑 npm test，4 分钟了',
      'docsThe README is out of date.',
      'scout 回来了：found it',
    ]);
    expect(screen.getAllByTestId('mu-board-note-who').map((chip) => chip.textContent)).toEqual(['fixer', 'docs']);
  });

  it('words a rules headline and blocked line from their codes, on any board, and keeps the model’s words', () => {
    show([
      event('board.update', {
        progress: '',
        now: 'Working on it.',
        confirm: [],
        phase: 'blocked',
        needsUser: false,
        done: 0,
        total: 0,
        by: 'model',
        ended: false,
        headline: 'Running npm test, 3 min in',
        headlineCode: 'still_running',
        headlineParams: { what: 'npm test', minutes: 3 },
        blocked: 'Waiting for you to allow: npm publish',
        blockedCode: 'waiting_permission',
        blockedParams: { what: 'npm publish' },
        next: 'It said it will publish once you allow it.',
      }),
    ]);
    expect(screen.getByTestId('mu-board-headline')).toHaveTextContent('还在跑 npm test，3 分钟了');
    expect(screen.getByTestId('mu-board-blocked')).toHaveTextContent('卡住了在等你允许：npm publish');
    expect(screen.getByTestId('mu-board-next')).toHaveTextContent('接下来It said it will publish once you allow it.');
    expect(screen.getByTestId('mu-board-state')).toHaveTextContent('在等别的');
  });

  it('calls a helper by its label in the sentences that name it, and leaves every other name as it is', () => {
    const audit = 'audit timing in src/retry.ts';
    const rewrite = 'rewrite retry.test.ts with fake timers';
    const labels = new Map([
      [audit, '查计时'],
      [rewrite, '改测试'],
    ]);
    const labelOf = (who: string) => labels.get(who);
    const t = i18n.t;
    const has = (key: string) => i18n.exists(key);
    // The line's own label, then the board's.
    const back = { ...ruleLine('helper_done', { name: audit, summary: 'found it' }, audit), label: '查计时' };
    expect(noteWords(back, t, has)).toBe('查计时 回来了：found it');
    expect(noteWords(ruleLine('helper_done', { name: audit, summary: 'found it' }, audit), t, has, labelOf)).toBe(
      '查计时 回来了：found it'
    );
    expect(
      noteWords(ruleLine('still_running', { who: rewrite, what: 'npx vitest', minutes: 6 }, rewrite), t, has, labelOf)
    ).toBe('改测试 跑 npx vitest 6 分钟没动静');
    expect(noteWords(ruleLine('helper_failed', { name: rewrite, reason: 'timed_out' }, rewrite), t, has, labelOf)).toBe(
      '改测试 超时了'
    );
    // A name that is not the line's helper keeps its own words; so does a line without a label anywhere.
    expect(noteWords(ruleLine('helper_done', { name: audit, summary: 'x' }, 'docs'), t, has, labelOf)).toBe(
      `${audit} 回来了：x`
    );
    expect(noteWords(ruleLine('helper_done', { name: 'scout', summary: 'x' }, 'scout'), t, has, labelOf)).toBe(
      'scout 回来了：x'
    );
    // A rules headline names its helper by `who`: the label the board has for it.
    expect(
      codedLine({ code: 'still_running', params: { who: rewrite, what: 'npx vitest', minutes: 6 } }, t, has, labelOf)
    ).toBe('改测试 跑 npx vitest 6 分钟没动静');
    expect(withLabels({ who: rewrite, what: rewrite, minutes: 6 }, labelOf)).toEqual({
      who: '改测试',
      what: rewrite,
      minutes: 6,
    });
    const params = { what: 'npm test' };
    expect(withLabels(params, labelOf)).toBe(params);
    expect(withLabels(undefined, labelOf)).toBeUndefined();
  });

  it('calls each helper a helpers_sent line lists by its label, listed the way the app’s language lists names', () => {
    const audit = 'audit timing in src/retry.ts';
    const rewrite = 'rewrite retry.test.ts with fake timers';
    const commaName = 'read a, b and c';
    const labels = new Map([
      [audit, '查计时'],
      [rewrite, '改测试'],
      [commaName, '读三个'],
    ]);
    const labelOf = (who: string) => labels.get(who);
    const has = (key: string) => i18n.exists(key);
    const sent = (titles: string, count = 2) => ruleLine('helpers_sent', { count, titles });
    expect(noteWords(sent(`${audit}, ${rewrite}`), i18n.t, has, labelOf)).toBe('派出 2 个助手：查计时、改测试');
    expect(noteWords(sent(`${audit}, ${rewrite}`), i18n.getFixedT('en-US'), has, labelOf)).toBe(
      'Started 2 subagents: 查计时, 改测试'
    );
    // A name without a label stays, and so does the harness's ", "; without labels the line is as the harness listed it.
    expect(noteWords(sent(`${audit}, scout`), i18n.t, has, labelOf)).toBe('派出 2 个助手：查计时, scout');
    expect(noteWords(sent(`${audit}, ${rewrite}`), i18n.t, has)).toBe(`派出 2 个助手：${audit}, ${rewrite}`);
    // One helper whose name holds ", " is still found by its whole name.
    expect(noteWords(sent(commaName, 1), i18n.t, has, labelOf)).toBe('派出 1 个助手：读三个');
    expect(labeledTitles('scout, docs', labelOf, '、')).toBe('scout, docs');
    expect(labeledTitles(`${rewrite}, ${audit}`, labelOf, '、')).toBe('改测试、查计时');
  });

  it('words a rules headline about a helper with the label the board’s helpers give it', () => {
    const rewrite = 'rewrite retry.test.ts with fake timers';
    const read = toBoardUpdate(
      event('board.update', {
        progress: '',
        now: 'n',
        confirm: [],
        phase: 'blocked',
        needsUser: false,
        done: 0,
        total: 0,
        by: 'model',
        ended: false,
        headline: `${rewrite} 跑 npx vitest 6 分钟没动静`,
        headlineCode: 'still_running',
        headlineParams: { who: rewrite, what: 'npx vitest', minutes: 6 },
        agents: [{ who: rewrite, label: '改测试', state: 'stuck', doing: '没输出' }],
      })
    );
    const words = boardWords(
      read as NonNullable<typeof read>,
      i18n.t,
      (key) => i18n.exists(key),
      (value) => String(value)
    );
    expect(words.headline).toBe('改测试 跑 npx vitest 6 分钟没动静');
    // Without a label for it: the name.
    const bare = { ...(read as NonNullable<typeof read>), agents: [] };
    expect(boardWords(bare, i18n.t, (key) => i18n.exists(key), String).headline).toBe(
      `${rewrite} 跑 npx vitest 6 分钟没动静`
    );
  });

  it('words each headline code, and keeps the harness’s sentence for one it does not know', () => {
    const t = i18n.t;
    const has = (key: string) => i18n.exists(key);
    expect(codedLine({ code: 'now_checking' }, t, has)).toBe('正在跑测试或检查，看改得对不对。');
    expect(codedLine({ code: 'now_blocked' }, t, has)).toBe('在等命令、助手或网络那边出结果。');
    expect(codedLine({ code: 'helpers_working', params: { count: 3 } }, t, has)).toBe('3 个助手在干活');
    expect(codedLine({ code: 'waiting_permission', params: { what: 'rm -rf dist' } }, t, has)).toBe(
      '在等你允许：rm -rf dist'
    );
    expect(codedLine({ code: 'now_dancing' }, t, has)).toBeUndefined();
    expect(codedLine({ code: 'helpers_working', params: { count: 'three' } }, t, has)).toBeUndefined();
    expect(codedLine(undefined, t, has)).toBeUndefined();
  });

  it('has every board v2 sentence in all 13 languages, filled with what it names', async () => {
    // `#` stands for the minutes, written in the language's own digits.
    const lines: Array<[string, BoardNote, string[]]> = [
      ['still_running', ruleLine('still_running', { what: '<what>', minutes: 7 }), ['<what>', '#']],
      [
        'still_running who',
        ruleLine('still_running', { who: '<who>', what: '<what>', minutes: 7 }),
        ['<who>', '<what>', '#'],
      ],
      ['helper_done', ruleLine('helper_done', { name: '<name>', summary: '<summary>' }), ['<name>', '<summary>']],
      ...HELPER_FAILURES.map((reason): [string, BoardNote, string[]] => [
        `helper_failed ${reason}`,
        ruleLine('helper_failed', { name: '<name>', reason, detail: '<detail>' }),
        ['<name>', '<detail>'],
      ]),
    ];
    for (const { language, local } of await allLocales()) {
      const has = (key: string) => local.exists(key);
      for (const [title, line, values] of lines) {
        const said = noteWords(line, local.t, has);
        expect(said, `${language} ${title}`).toBeDefined();
        expect(said, `${language} ${title}`).not.toContain('{{');
        for (const value of values)
          expect(said, `${language} ${title}`).toContain(value === '#' ? formatNumber(7, language) : value);
      }
      for (const count of [1, 3, 5, 21]) {
        const back = noteWords(ruleLine('helpers_back', { count, failed: 1 }), local.t, has);
        expect(back, `${language} helpers_back failed ${count}`).toContain(formatNumber(count, language));
        expect(back, `${language} helpers_back failed ${count}`).not.toContain('{{');
        const working = codedLine({ code: 'helpers_working', params: { count } }, local.t, has);
        expect(working, `${language} helpers_working ${count}`).toContain(formatNumber(count, language));
      }
      expect(codedLine({ code: 'waiting_permission', params: { what: '<what>' } }, local.t, has)).toContain('<what>');
      for (const key of [
        'phases.blocked',
        'codes.now.blocked',
        'blocked',
        'next',
        'agents',
        'updatedNow',
        'stripHint',
        'agentStates.working',
        'agentStates.waiting',
        'agentStates.stuck',
      ])
        expect(has(`common.kyrn.boardView.${key}`), `${language} ${key}`).toBe(true);
      expect(local.t('common.kyrn.boardView.updated', { ago: '<ago>' }), language).toContain('<ago>');
      expect(local.t('common.kyrn.boardView.blockedLine', { text: '<text>' }), language).toContain('<text>');
      expect(local.t('common.kyrn.boardView.stripOpen', { headline: '<h>' }), language).toContain('<h>');
    }
  });
});
