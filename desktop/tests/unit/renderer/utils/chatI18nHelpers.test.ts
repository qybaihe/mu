/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createInstance, type TFunction } from 'i18next';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import zhMu from '@/renderer/services/i18n/locales/zh-CN/mu.json';
import twMu from '@/renderer/services/i18n/locales/zh-TW/mu.json';
import { MU_TURN_ERRORS } from '@/process/agent/kyrn/KyrnAgent';
import { readJevPreflightRow } from '@/renderer/utils/chat/jevPreflight';
import { findMuTurnError, muTurnErrorKey, noModelDetail } from '@/renderer/utils/chat/muTurnErrors';
import { isDefaultConversationName } from '@/renderer/utils/chat/defaultConversationName';
import { buildConversationExportText } from '@/renderer/utils/chat/conversationExport';
import type { TMessage } from '@/common/chat/chatLib';
import type { TChatConversation } from '@/common/config/storage';

const translator = (language: 'en-US' | 'zh-CN' | 'zh-TW', resources: Record<string, unknown>): TFunction => {
  const i18n = createInstance();
  void i18n.init({
    lng: language,
    initImmediate: false,
    resources: { [language]: { translation: resources } },
    interpolation: { escapeValue: false },
  });
  return i18n.t;
};

describe('Jev preflight row', () => {
  it('reads the state and turn type the bridge sends', () => {
    expect(readJevPreflightRow('jev:r:1', 'Jev · Classifying', { preflight: 'pending' })).toEqual({ state: 'pending' });
    expect(
      readJevPreflightRow('jev:r:1', 'Jev · multi_step_task', { turnType: 'multi_step_task', preflight: 'verdict' })
    ).toEqual({ state: 'verdict', turnType: 'multi_step_task' });
    // A relay that snake_cases keys.
    expect(readJevPreflightRow('jev:r:1', '', { turn_type: 'chat', preflight: 'verdict' })).toEqual({
      state: 'verdict',
      turnType: 'chat',
    });
    expect(readJevPreflightRow('jev:r:1', 'Jev · Fallback', { preflight: 'fallback' })).toEqual({ state: 'fallback' });
  });

  it('reads the English title of conversations recorded before the bridge sent that data', () => {
    expect(readJevPreflightRow('jev:r:1', 'Jev · chat', { turnType: 'chat', state: 'applied' })).toEqual({
      state: 'verdict',
      turnType: 'chat',
    });
    expect(readJevPreflightRow('jev:r:1', 'Jev · Classifying', undefined)).toEqual({ state: 'pending' });
    expect(readJevPreflightRow('jev:r:1', 'Jev · research', {})).toEqual({ state: 'verdict', turnType: 'research' });
    expect(readJevPreflightRow('jev:r:1', 'Jev · Default', {})).toEqual({ state: 'verdict' });
    expect(readJevPreflightRow('jev:r:1', 'Jev · Fallback', {})).toEqual({ state: 'fallback' });
    expect(readJevPreflightRow('jev:r:1', 'Something else', {})).toBeUndefined();
    expect(readJevPreflightRow('call-1', 'Jev · Classifying', { preflight: 'pending' })).toBeUndefined();
  });
});

describe('mu bridge errors', () => {
  it('recognises every error text the bridge raises, with a headline in each locale', () => {
    const locales = [enMu, zhMu, twMu] as Array<{ turnErrors?: Record<string, string> }>;
    for (const [code, english] of Object.entries(MU_TURN_ERRORS)) {
      expect(findMuTurnError([`Internal error: ${english}`]), english).toBe(code);
      expect(muTurnErrorKey(findMuTurnError([english])!)).toBe(`mu.turnErrors.${code}`);
      for (const locale of locales) expect(locale.turnErrors?.[code], code).toEqual(expect.any(String));
    }
  });

  it('keeps the provider text after the model headline and tells the process errors apart', () => {
    expect(findMuTurnError([undefined, 'Model request failed: 429 rate limited'])).toBe('modelFailed');
    expect(findMuTurnError(['mu process exited during the turn'])).toBe('processExited');
    expect(findMuTurnError(['mu process exited'])).toBe('processClosed');
    expect(findMuTurnError(['mu control command timed out'])).toBe('timeout');
    expect(findMuTurnError(['Rate limit reached', null])).toBeUndefined();
  });

  it('says what to do when the provider refused the region or could not be reached', () => {
    // As the app logged them on 2026-09-26, with a Google model and no proxy reaching mu.
    const region =
      'Agent internal error (code -32603) ({"details":"Model request failed: Cloud Code Assist error (400): User location is not supported for the API use."})';
    const timeout =
      'Model request failed: Network error: Connect Timeout Error (attempted address: daily-cloudcode-pa.sandbox.googleapis.com:443, timeout: 10000ms)';
    expect(findMuTurnError([region])).toBe('regionBlocked');
    expect(findMuTurnError([undefined, timeout])).toBe('unreachable');
    expect(findMuTurnError(['Model request failed: 403 unsupported_country_region_territory'])).toBe('regionBlocked');
    expect(findMuTurnError(['Model request failed: fetch failed'])).toBe('unreachable');
    for (const locale of [enMu, zhMu, twMu] as Array<{ turnErrors?: Record<string, string> }>) {
      expect(locale.turnErrors?.regionBlocked).toEqual(expect.any(String));
      expect(locale.turnErrors?.unreachable).toEqual(expect.any(String));
    }
  });

  it('translates a mu error headline', () => {
    const zh = translator('zh-CN', { mu: zhMu });
    expect(zh(muTurnErrorKey('turnRunning'))).toBe('mu 还在处理上一条消息，请等待或先停止。');
  });

  it('reads a missing model as such, in the bridge’s words and in pi’s, and never as a failed request', () => {
    expect(findMuTurnError(['mu has no model to answer with: No API key found for anthropic.'])).toBe('noModel');
    // Conversations from before the bridge named it stored pi's own words, some under the request's headline.
    expect(findMuTurnError(['Model request failed: No API key found for openai.'])).toBe('noModel');
    expect(findMuTurnError(['No models available. Use /login to log into a provider'])).toBe('noModel');
    expect(findMuTurnError(['No model selected'])).toBe('noModel');
  });

  it('keeps of pi’s words about a missing model only what a desktop user can use', () => {
    expect(
      noModelDetail(
        'Agent internal error (code -32603): mu has no model to answer with: No API key found for anthropic.\n\n' +
          'Use /login to log into a provider via OAuth or API key. See:\n  /opt/mu/docs/providers.md'
      )
    ).toBe('No API key found for anthropic.');
    expect(noModelDetail('No API key found for openai. Use /login or set an API key environment variable.')).toBe(
      'No API key found for openai.'
    );
    expect(noModelDetail('No models available. See: /opt/mu/docs/models.md')).toBe('No models available.');
    expect(noModelDetail('mu has no model to answer with')).toBe('');
  });
});

describe('default conversation name', () => {
  it('recognises the default title of every language, not only the one shown now', () => {
    expect(isDefaultConversationName('New Chat')).toBe(true);
    expect(isDefaultConversationName('新会话')).toBe(true);
    expect(isDefaultConversationName('新會話')).toBe(true);
    expect(isDefaultConversationName('Neuer Chat')).toBe(true);
    expect(isDefaultConversationName('Refactor the parser')).toBe(false);
    expect(isDefaultConversationName('')).toBe(false);
    expect(isDefaultConversationName(undefined)).toBe(false);
  });
});

describe('conversation export text', () => {
  const conversation = { id: 'c-1', name: 'Plan', type: 'acp' } as TChatConversation;
  const messages = [
    { id: 'm1', type: 'text', position: 'right', content: { content: 'Hello' } },
  ] as unknown as TMessage[];
  const labels = {
    conversation: '会话',
    conversation_id: '会话 ID',
    exportedAt: '导出时间',
    type: '类型',
    noMessages: '没有消息',
    user: '用户',
    assistant: '助手',
    system: '系统',
  };

  it('words the header lines as the caller asks, formats the time in the app language and leaves out the raw type', () => {
    const text = buildConversationExportText(conversation, messages, {
      ...labels,
      language: 'zh-CN',
      headerLine: (label, value) => `${label}：${value}`,
      speakerLine: (speaker) => `${speaker}：`,
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('会话：Plan');
    expect(lines[1]).toBe('会话 ID：c-1');
    expect(lines[2]).toMatch(/^导出时间：\d{4}\/\d{1,2}\/\d{1,2} /);
    expect(text).not.toContain('acp');
    expect(text).toContain('用户：\nHello');
  });

  it('keeps the plain colon format when the caller gives no wording', () => {
    const text = buildConversationExportText(conversation, messages, { ...labels });
    expect(text.split('\n')[0]).toBe('会话: Plan');
    expect(text).toContain('用户:\nHello');
  });
});

const leafKeys = (value: unknown, prefix: string): string[] =>
  value !== null && typeof value === 'object'
    ? Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => leafKeys(child, `${prefix}.${key}`))
    : [prefix];

describe('locale key structure', () => {
  const localeDir = path.join(process.cwd(), 'packages/desktop/src/renderer/services/i18n/locales');
  // The modules this slice adds keys to. A new key nested under a name that also prefixes literal dotted keys
  // ("export": {…} beside "export.menuTitle") hides every one of those keys from i18next.
  const modules = new Set(['agent', 'common', 'conversation', 'mcp', 'messages', 'mu', 'tools']);

  it.each(['en-US', 'zh-CN', 'zh-TW'])('resolves every key of %s through i18next', (language) => {
    const resources: Record<string, unknown> = {};
    for (const file of readdirSync(path.join(localeDir, language))) {
      const module = file.replace(/\.json$/, '');
      if (modules.has(module)) {
        resources[module] = JSON.parse(readFileSync(path.join(localeDir, language, file), 'utf8'));
      }
    }
    const t = translator(language as 'en-US' | 'zh-CN' | 'zh-TW', resources);
    const unresolved = Object.entries(resources)
      .flatMap(([module, data]) => leafKeys(data, module))
      .filter((key) => t(key) === key);
    expect(unresolved).toEqual([]);
  });
});
