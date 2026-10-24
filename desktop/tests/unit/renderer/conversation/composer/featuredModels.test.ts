import { describe, expect, it } from 'vitest';
import { isFeaturedModel } from '@/renderer/utils/model/featuredModels';

// The ids are the ones pi lists for a ChatGPT sign-in (`openai`) and the older Codex sign-in (`openai-codex`).

describe('isFeaturedModel', () => {
  it.each([
    'openai/gpt-5.6-luna',
    'openai/gpt-5.6-sol',
    'openai/gpt-5.6-terra',
    'openai/gpt-6-astra',
    'openai/gpt-6-luna',
    'openai/gpt-6-sol',
    'openai/gpt-6.1-sol',
    'openai-codex/gpt-5.6-luna',
    'openai-codex/gpt-6-astra',
    'openai-codex/gpt-6.1-sol',
  ])('lists GPT-5.6, GPT-6 and GPT-6.1: %s', (value) => {
    expect(isFeaturedModel(value)).toBe(true);
  });

  it.each([
    'openai/gpt-4',
    'openai/gpt-4-turbo',
    'openai/gpt-4.1',
    'openai/gpt-4.1-mini',
    'openai/gpt-4o',
    'openai/gpt-4o-2024-11-20',
    'openai/gpt-4o-mini',
    'openai/gpt-5',
    'openai/gpt-5-chat-latest',
    'openai/gpt-5-pro',
    'openai/gpt-5.1',
    'openai/gpt-5.3-codex',
    'openai/gpt-5.5',
    'openai/gpt-5.5-pro',
    'openai/gpt-realtime-2.1',
    'openai/gpt-daybreak-blue-latest',
    'openai/o1',
    'openai/o3-pro',
    'openai/o4-mini',
    'openai-codex/gpt-5.3-codex-spark',
    'openai-codex/gpt-5.5',
  ])('leaves older OpenAI models for "Show all models": %s', (value) => {
    expect(isFeaturedModel(value)).toBe(false);
  });

  it('lists a new point release, or a newer series, without a change here', () => {
    expect(isFeaturedModel('openai/gpt-6.1-luna')).toBe(true);
    expect(isFeaturedModel('openai/gpt-6.2')).toBe(true);
    expect(isFeaturedModel('openai/gpt-5.10-sol')).toBe(true);
    expect(isFeaturedModel('openai-codex/gpt-7-sol')).toBe(true);
    expect(isFeaturedModel('openai/gpt-6.1-sol-2026-11-01')).toBe(true);
  });

  it('lists every model of any other provider, and a value with no provider', () => {
    expect(isFeaturedModel('anthropic/claude-sonnet-4-5')).toBe(true);
    expect(isFeaturedModel('github-copilot/gpt-4o')).toBe(true);
    expect(isFeaturedModel('openrouter/openai/gpt-4o')).toBe(true);
    expect(isFeaturedModel('e2e/e2e-fake-model')).toBe(true);
    expect(isFeaturedModel('gpt-4o')).toBe(true);
  });
});
