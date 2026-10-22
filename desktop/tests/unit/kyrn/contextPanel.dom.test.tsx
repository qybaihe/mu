import React from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance, type i18n as I18n } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { Activity } from '@/common/kyrn/types';
import common from '@/renderer/services/i18n/locales/en-US/common.json';
import zhCommon from '@/renderer/services/i18n/locales/zh-CN/common.json';
import ContextPanel from '@/renderer/pages/conversation/KyrnPanel/Judge/ContextPanel';

let next = 0;
const event = (kind: string, payload: Record<string, unknown>): Activity => ({
  id: `e${++next}`,
  at: 1_000 + next,
  kind,
  payload,
});

const events: Activity[] = [
  event('context.usage', {
    usage: { tokens: 12_345, contextWindow: 200_000 },
    settings: { enabled: true, maxContextTokens: 100_000 },
    sessionTokens: { input: 100, cacheRead: 800, cacheWrite: 100 },
  }),
  event('context.policy', { betaEnabled: true, mode: 'active' }),
  event('compaction_end', {
    applied: true,
    beta: true,
    tokensBefore: 32_000,
    tokensAfter: 8_000,
    metrics: { kept: 1, pruned: 2, dropped: 1 },
  }),
  event('compaction_end', { applied: false, aborted: false, error: 'context overflow' }),
];

const instance = async (lng: string, resources: Record<string, unknown>): Promise<I18n> => {
  const i18n = createInstance();
  await i18n.init({ lng, fallbackLng: 'en', resources, interpolation: { escapeValue: false } });
  return i18n;
};

const show = (i18n: I18n) =>
  render(
    <I18nextProvider i18n={i18n}>
      <ContextPanel events={events} />
    </I18nextProvider>
  );

let english: I18n;
beforeAll(async () => {
  english = await instance('en', { en: { translation: { common } } });
});
afterEach(cleanup);

describe('context panel wording', () => {
  it('writes counts, percentages and compaction results as whole sentences', () => {
    show(english);
    expect(screen.getByText('12,345 / 200,000')).toBeInTheDocument();
    expect(screen.getByText('Compacts at 100,000 tokens')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Cache hit rate for this conversation: 80%' })).toBeInTheDocument();

    fireEvent.click(screen.getByText('Compaction results (2)'));
    expect(screen.getByText('32,000 → ≈8,000 tokens')).toBeInTheDocument();
    expect(screen.getByText('Context reduced by ≈75%')).toBeInTheDocument();
    // One plural form per count: "1 result", never "1 results".
    expect(screen.getByText('1 result kept · 2 pruned · 1 call removed')).toBeInTheDocument();
    // A failed compaction is named in the app language; the runtime's message is only the detail under it.
    expect(screen.getByText(common.kyrn.compactionFailed)).toBeInTheDocument();
    expect(screen.getByText('context overflow')).toBeInTheDocument();
  });

  it('follows the app language, not the operating system, for numbers', async () => {
    show(await instance('de-DE', { en: { translation: { common } } }));
    expect(screen.getByText('12.345 / 200.000')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Compaction results (2)'));
    expect(screen.getByText(/^Context reduced by ≈75\s%$/)).toBeInTheDocument();
  });

  it('says "about" in Chinese rather than gluing an English unit on', async () => {
    show(await instance('zh-CN', { 'zh-CN': { translation: { common: zhCommon } } }));
    fireEvent.click(screen.getByText(zhCommon.kyrn.compactionResults.replace('{{count}}', '2')));
    expect(screen.getByText('32,000 → 约 8,000 tokens')).toBeInTheDocument();
    expect(screen.getByText('保留 1 项结果 · 裁剪 2 项 · 移除 1 次调用')).toBeInTheDocument();
  });
});
