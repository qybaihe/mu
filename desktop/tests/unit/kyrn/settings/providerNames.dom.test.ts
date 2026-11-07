import { beforeAll, describe, expect, it } from 'vitest';
import { createInstance, type TFunction } from 'i18next';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import zhMu from '@/renderer/services/i18n/locales/zh-CN/mu.json';
import type { ProviderSettings } from '@/common/kyrn/models';
import {
  blankProvider,
  customProviderName,
  providerLabel,
} from '@/renderer/pages/settings/KyrnSettings/providers/endpoints';
import { tokenSize } from '@/renderer/pages/settings/KyrnSettings/providers/parts';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en-US',
    // A language with no texts of its own here reads the English ones, but writes numbers its own way.
    fallbackLng: 'en-US',
    resources: { 'en-US': { translation: { mu: enMu } }, 'zh-CN': { translation: { mu: zhMu } } },
    interpolation: { escapeValue: false },
  });
});
const tIn = (language: string): TFunction => i18n.getFixedT(language);

const saved = (patch: Partial<ProviderSettings>): ProviderSettings => ({
  ...blankProvider('relay'),
  isNew: false,
  ...patch,
});

describe('a context window as model lists write it', () => {
  it('keeps K and M in every language, with the number written the language’s way', () => {
    expect(tokenSize(128_000, 'en-US')).toBe('128K');
    expect(tokenSize(128_000, 'zh-CN')).toBe('128K');
    expect(tokenSize(1_000_000, 'en-US')).toBe('1M');
    expect(tokenSize(1_500_000, 'en-US')).toBe('1.5M');
    expect(tokenSize(1_500_000, 'de-DE')).toBe('1,5M');
    expect(tokenSize(512, 'fa-IR')).toBe('۵۱۲');
  });

  it('calls what rounds to a thousand K a million', () => {
    expect(tokenSize(999_400, 'en-US')).toBe('999K');
    expect(tokenSize(999_999, 'en-US')).toBe('1M');
    expect(tokenSize(1_048_576, 'en-US')).toBe('1M');
  });
});

describe('model counts in words', () => {
  it('writes the count the language’s way and still picks the plural by it', () => {
    expect(tIn('en-US')('mu.providers.modelCount', { count: 1 })).toBe('1 model');
    expect(tIn('en-US')('mu.providers.modelCount', { count: 1234 })).toBe('1,234 models');
    expect(tIn('de-DE')('mu.providers.modelCount', { count: 1234 })).toBe('1.234 models');
    expect(tIn('fa-IR')('mu.providers.modelCount', { count: 3 })).toBe('۳ models');
    expect(tIn('zh-CN')('mu.providers.modelCount', { count: 1234 })).toBe('1,234 个模型');
    expect(tIn('en-US')('mu.test.okModels', { count: 1234, ms: '12' })).toBe(
      'Connected (12 ms). The endpoint lists 1,234 models.'
    );
  });
});

describe('what a provider is called on screen', () => {
  it('calls a new provider with no name a new provider, not by the placeholder id it was given', () => {
    expect(customProviderName(tIn('en-US'), blankProvider('custom'))).toBe('New provider');
    expect(customProviderName(tIn('zh-CN'), blankProvider('custom'))).toBe('新提供商');
    expect(customProviderName(tIn('en-US'), { ...blankProvider('custom'), name: 'My proxy' })).toBe('My proxy');
    // A saved one without a name goes by its id: that is how models.json and pi know it.
    expect(customProviderName(tIn('en-US'), saved({ id: 'relay', name: '' }))).toBe('relay');
  });

  it('names a provider by its own name, a hand-written entry’s, a subscription’s, a built-in one’s, or else its id', () => {
    const models = {
      providers: [saved({ id: 'relay', name: 'Relay' })],
      foreign: [{ id: 'lab', name: 'Lab', api: 'bedrock-converse', baseUrl: '', modelCount: 1 }],
    };
    const t = tIn('en-US');
    expect(providerLabel(t, models, 'relay')).toBe('Relay');
    expect(providerLabel(t, models, 'lab')).toBe('Lab');
    // OpenAI's API keys and Sign in with ChatGPT share `openai`: by its maker's name; the Codex sign-in by its own.
    expect(providerLabel(t, models, 'openai')).toBe('OpenAI');
    expect(providerLabel(t, models, 'openai-codex')).toBe('ChatGPT (Codex)');
    expect(providerLabel(t, models, 'anthropic')).toBe('Claude');
    // pi's built-in providers by their makers' names, never by an id like vercel-ai-gateway.
    expect(providerLabel(t, models, 'openrouter')).toBe('OpenRouter');
    expect(providerLabel(t, models, 'vercel-ai-gateway')).toBe('Vercel AI Gateway');
    expect(providerLabel(t, models, 'corp-gateway')).toBe('corp-gateway');
  });
});
