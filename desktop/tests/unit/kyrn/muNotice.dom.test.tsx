import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IMessageAcpToolCall, TMessage } from '@/common/chat/chatLib';
import { MU_NOTICES } from '@/process/agent/kyrn/KyrnAgent';
import MessageMuNotice from '@/renderer/pages/conversation/Messages/acp/MessageMuNotice';
import {
  CHECKPOINT_OFF_KEYS,
  checkpointOffWords,
  FREE_JEV_UNAVAILABLE_KEYS,
  MU_NOTICE_CODES,
  MU_NOTICE_KEYS,
  MU_NOTICE_LINKS,
  muNotice,
} from '@/renderer/pages/conversation/Messages/acp/muNotice';
import { openExternalUrl } from '@/renderer/utils/platform';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import zhMu from '@/renderer/services/i18n/locales/zh-CN/mu.json';

// The mu bridge's notices (a `mu:notice:` tool call with the code in its input) are one line in the reader's language.

vi.mock('@/renderer/utils/platform', () => ({ openExternalUrl: vi.fn(async () => {}) }));

afterEach(() => {
  cleanup();
  vi.mocked(openExternalUrl).mockClear();
});

const LOCALES = join(__dirname, '../../../packages/desktop/src/renderer/services/i18n/locales');

const notice = (update: Record<string, unknown>, id = 'mu:notice:1'): IMessageAcpToolCall =>
  ({
    id,
    msg_id: id,
    conversation_id: 'conversation-1',
    type: 'acp_tool_call',
    position: 'left',
    created_at: 1,
    content: {
      session_id: 'session-1',
      update: { sessionUpdate: 'tool_call', tool_call_id: id, status: 'completed', kind: 'execute', ...update },
    },
  }) as IMessageAcpToolCall;

describe('the bridge’s notices', () => {
  it('reads the code from the call’s input, as the relay passes it on or as the bridge sent it', () => {
    const title = MU_NOTICES.answer_lost;
    expect(muNotice(notice({ title, raw_input: { notice: 'answer_lost' } }))).toEqual({ code: 'answer_lost', title });
    expect(muNotice(notice({ title, rawInput: { notice: 'answer_lost' } }))).toEqual({ code: 'answer_lost', title });
    // A code this build has no words for keeps the bridge's own line.
    expect(muNotice(notice({ title: 'Something new', raw_input: { notice: 'newer' } }))).toEqual({
      title: 'Something new',
    });
    expect(muNotice(notice({ title: 'bash' }, 'bash-1'))).toBeUndefined();
    expect(muNotice({ ...notice({}), type: 'text' } as unknown as TMessage)).toBeUndefined();
  });

  it('has a line in every language for every notice the bridge sends', () => {
    expect([...MU_NOTICE_CODES].toSorted()).toEqual(Object.keys(MU_NOTICES).toSorted());
    const languages = readdirSync(LOCALES).filter((name) => /^[a-z]{2}-[A-Z]{2}$/.test(name));
    expect(languages).toHaveLength(13);
    for (const language of languages) {
      const mu = JSON.parse(readFileSync(join(LOCALES, language, 'mu.json'), 'utf8')) as Record<string, unknown>;
      const sentence = (key: string): unknown =>
        key
          .split('.')
          .slice(1)
          .reduce<unknown>((at, name) => (at as Record<string, unknown> | undefined)?.[name], mu);
      for (const code of MU_NOTICE_CODES)
        expect(sentence(MU_NOTICE_KEYS[code]), `${language} ${code}`).toEqual(expect.any(String));
      for (const key of Object.values(FREE_JEV_UNAVAILABLE_KEYS))
        expect(sentence(key), `${language} ${key}`).toEqual(expect.any(String));
    }
  });

  it('says it in the reader’s language', () => {
    const show = (lng: 'zh' | 'en', message: IMessageAcpToolCall) => {
      const i18n = createInstance();
      void i18n.init({
        lng,
        resources: { zh: { translation: { mu: zhMu } }, en: { translation: { mu: enMu } } },
        interpolation: { escapeValue: false },
      });
      const found = muNotice(message);
      if (!found) throw new Error('not a notice');
      return render(
        <I18nextProvider i18n={i18n}>
          <MessageMuNotice notice={found} />
        </I18nextProvider>
      );
    };
    const lost = notice({ title: MU_NOTICES.answer_lost, raw_input: { notice: 'answer_lost' } });
    const zh = show('zh', lost);
    expect(screen.getByTestId('mu-notice')).toHaveTextContent(zhMu.notices.answerLost);
    zh.unmount();
    const en = show('en', lost);
    expect(screen.getByTestId('mu-notice')).toHaveTextContent(MU_NOTICES.answer_lost);
    en.unmount();
    show('zh', notice({ title: 'Something new', raw_input: { notice: 'newer' } }));
    expect(screen.getByTestId('mu-notice')).toHaveTextContent('Something new');
    expect(screen.queryByTestId('mu-notice-link')).toBeNull();
  });

  it('ends the line about Git for Windows with its download page, opened outside the app', () => {
    const i18n = createInstance();
    void i18n.init({
      lng: 'zh',
      resources: { zh: { translation: { mu: zhMu } } },
      interpolation: { escapeValue: false },
    });
    const found = muNotice(notice({ title: MU_NOTICES.bash_missing, raw_input: { notice: 'bash_missing' } }));
    if (!found) throw new Error('not a notice');
    render(
      <I18nextProvider i18n={i18n}>
        <MessageMuNotice notice={found} />
      </I18nextProvider>
    );
    const link = screen.getByTestId('mu-notice-link');
    expect(screen.getByTestId('mu-notice')).toHaveTextContent(
      `${zhMu.notices.bashMissing} https://git-scm.com/download/win`
    );
    expect(link).toHaveAttribute('href', MU_NOTICE_LINKS.bash_missing);
    fireEvent.click(link);
    expect(openExternalUrl).toHaveBeenCalledWith('https://git-scm.com/download/win');
    // The bridge's own title carries the address too, for a client without these words.
    expect(MU_NOTICES.bash_missing).toContain('https://git-scm.com/download/win');
    expect(enMu.notices.bashMissing).not.toContain('http');
  });
});

const showNotice = (lng: 'zh' | 'en', message: IMessageAcpToolCall) => {
  const i18n = createInstance();
  void i18n.init({
    lng,
    resources: { zh: { translation: { mu: zhMu } }, en: { translation: { mu: enMu } } },
    interpolation: { escapeValue: false },
  });
  const found = muNotice(message);
  if (!found) throw new Error('not a notice');
  return render(
    <I18nextProvider i18n={i18n}>
      <MessageMuNotice notice={found} />
    </I18nextProvider>
  );
};

/** mu's own line for a session without checkpoints, already in the app's language: the bridge's title. */
const MU_WORDS = 'mu: checkpoints are off, because this folder has more than 5000 files to snapshot.';
const checkpoint = (input: Record<string, unknown>) =>
  notice({ title: MU_WORDS, raw_input: { notice: 'checkpoint_off', ...input } });

/** The `{{names}}` a sentence fills in. */
const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).toSorted();

describe('checkpoints that are off', () => {
  it('reads mu’s reason and the numbers it names, as the bridge sent them or as the relay passed them on', () => {
    expect(muNotice(checkpoint({ code: 'too_many_files', params: { limit: 5000, folder: '/Users/x' } }))).toEqual({
      code: 'checkpoint_off',
      title: MU_WORDS,
      reason: 'too_many_files',
      params: { limit: 5000 },
    });
    expect(muNotice(checkpoint({ code: 'too_many_bytes', params: { limit_mb: 512 } }))).toMatchObject({
      params: { limitMb: 512 },
    });
    expect(muNotice(checkpoint({ code: 'xcode_license', params: {} }))).toMatchObject({
      reason: 'xcode_license',
      params: {},
    });
  });

  it('words a reason it knows, with its numbers, and leaves the rest to mu’s own line', () => {
    const words = (input: Record<string, unknown>) => checkpointOffWords(muNotice(checkpoint(input))!);
    expect(words({ code: 'too_slow', params: { seconds: 5 } })).toEqual({
      key: 'mu.notices.checkpointOffWhy.tooSlow',
      values: { seconds: 5 },
    });
    expect(words({ code: 'developer_tools_missing', params: {} })).toEqual({
      key: 'mu.notices.checkpointOffWhy.developerToolsMissing',
      values: {},
    });
    // Its number did not come, or a newer mu has a reason this build has no words for.
    expect(words({ code: 'too_many_files', params: {} })).toBeUndefined();
    expect(words({ code: 'disk_full', params: {} })).toBeUndefined();
  });

  it('has the sentence for every reason in every language, naming the same numbers', () => {
    const languages = readdirSync(LOCALES).filter((name) => /^[a-z]{2}-[A-Z]{2}$/.test(name));
    for (const key of Object.values(CHECKPOINT_OFF_KEYS)) {
      const [, , , name] = key.split('.');
      const english = (enMu.notices.checkpointOffWhy as Record<string, string>)[name];
      expect(english, key).toEqual(expect.any(String));
      for (const language of languages) {
        const mu = JSON.parse(readFileSync(join(LOCALES, language, 'mu.json'), 'utf8')) as {
          notices: { checkpointOffWhy: Record<string, string> };
        };
        const sentence = mu.notices.checkpointOffWhy[name];
        expect(sentence, `${language} ${key}`).toEqual(expect.any(String));
        expect(placeholders(sentence), `${language} ${key}`).toEqual(placeholders(english));
      }
    }
  });

  it('says why in the reader’s language, numbers written their way, and mu’s own line for a reason it does not know', () => {
    const files = showNotice('zh', checkpoint({ code: 'too_many_files', params: { limit: 5000 } }));
    expect(screen.getByTestId('mu-notice')).toHaveTextContent(
      zhMu.notices.checkpointOffWhy.tooManyFiles.replace('{{limit}}', '5,000')
    );
    expect(screen.getByTestId('mu-notice')).toHaveAttribute('data-code', 'checkpoint_off');
    files.unmount();
    const license = showNotice('en', checkpoint({ code: 'xcode_license', params: {} }));
    expect(screen.getByTestId('mu-notice')).toHaveTextContent(enMu.notices.checkpointOffWhy.xcodeLicense);
    license.unmount();
    const unknown = showNotice('en', checkpoint({ code: 'disk_full', params: {} }));
    expect(screen.getByTestId('mu-notice')).toHaveTextContent(MU_WORDS);
    unknown.unmount();
    // No words of mu's at all: the plain sentence.
    showNotice('zh', notice({ title: '', raw_input: { notice: 'checkpoint_off', code: 'disk_full' } }));
    expect(screen.getByTestId('mu-notice')).toHaveTextContent(zhMu.notices.checkpointOff);
  });
});

describe('the free Jev', () => {
  it('says the free Jev answers, and why it stopped, in the reader’s language', () => {
    const free = showNotice('zh', notice({ title: 'mu: no key', raw_input: { notice: 'free_jev', params: {} } }));
    expect(screen.getByTestId('mu-notice')).toHaveTextContent(zhMu.notices.freeJev);
    expect(screen.getByTestId('mu-notice')).toHaveAttribute('data-code', 'free_jev');
    free.unmount();
    const stopped = (code?: string) =>
      notice({ title: 'mu: it stopped', raw_input: { notice: 'free_jev_unavailable', ...(code ? { code } : {}) } });
    expect(muNotice(stopped('gone'))).toEqual({
      code: 'free_jev_unavailable',
      title: 'mu: it stopped',
      reason: 'gone',
    });
    const gone = showNotice('en', stopped('gone'));
    expect(screen.getByTestId('mu-notice')).toHaveTextContent(enMu.notices.freeJevUnavailable.gone);
    gone.unmount();
    const paid = showNotice('zh', stopped('paid'));
    expect(screen.getByTestId('mu-notice')).toHaveTextContent(zhMu.notices.freeJevUnavailable.paid);
    paid.unmount();
    // A reason this build has no words for is said in mu's own.
    showNotice('en', stopped('newer'));
    expect(screen.getByTestId('mu-notice')).toHaveTextContent('mu: it stopped');
  });
});

describe('a stopped reply, and what mu notified', () => {
  it('ends a stopped reply with a line that says so', () => {
    showNotice('zh', notice({ title: MU_NOTICES.stopped, raw_input: { notice: 'stopped' } }));
    expect(screen.getByTestId('mu-notice')).toHaveTextContent(zhMu.notices.stopped);
    expect(screen.getByTestId('mu-notice')).toHaveAttribute('data-code', 'stopped');
  });

  it('shows what mu notified as mu wrote it, with its level, and no reply text', () => {
    expect(muNotice(notice({ title: 'Permissions: full access', raw_input: { level: 'info' } }))).toEqual({
      title: 'Permissions: full access',
      level: 'info',
    });
    // A level this build does not know is no level.
    expect(muNotice(notice({ title: 'x', raw_input: { level: 'debug' } }))).toEqual({ title: 'x' });
    showNotice(
      'en',
      notice({ title: 'mu could not save a checkpoint.\nIt goes on without one.', raw_input: { level: 'warning' } })
    );
    const line = screen.getByTestId('mu-notice');
    expect(line).toHaveAttribute('data-level', 'warning');
    expect(line).toHaveAttribute('data-code', '');
    expect(line.textContent).toBe('mu could not save a checkpoint.\nIt goes on without one.');
  });
});
