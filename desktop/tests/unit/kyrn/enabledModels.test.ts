import { describe, expect, it } from 'vitest';
import { enabledModels } from '../../../packages/desktop/src/common/kyrn/models';
import { pickModel } from '../../../packages/desktop/src/process/services/nativeHost/conversations/modelSearch';
import { offeredModels } from '../../../packages/desktop/src/renderer/pages/native/components/composer/composerModel';

/**
 * The models a model menu offers: pi says which the settings enable (`enabledModels` beside `models` in its answer to
 * `get_available_models`), chosen per account in Settings or with `/scoped-models <provider>` in a terminal.
 */
const MODELS = [
  { provider: 'openai', id: 'gpt-6-sol', name: 'GPT-6 Sol' },
  { provider: 'openai', id: 'gpt-4o', name: 'GPT-4o' },
  { provider: 'google-antigravity', id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro High' },
  { provider: 'vercel-ai-gateway', id: 'openai/gpt-5', name: 'GPT-5' },
];

describe('enabled models', () => {
  it('reads the set pi answers with, and nothing from an older mu or while every model is enabled', () => {
    expect(enabledModels({ models: MODELS, enabledModels: ['openai/gpt-6-sol'] })).toEqual(
      new Set(['openai/gpt-6-sol'])
    );
    expect(enabledModels({ models: MODELS })).toBeUndefined();
    expect(enabledModels({ models: MODELS, enabledModels: [] })).toBeUndefined();
    expect(enabledModels(undefined)).toBeUndefined();
  });

  it('lists only the enabled models in the composer’s menu, and the one in use', () => {
    const enabled = new Set(['openai/gpt-6-sol', 'google-antigravity/gemini-3.1-pro-high']);
    expect(offeredModels(MODELS, 'openai/gpt-4o', enabled).options.map((option) => option.value)).toEqual([
      'openai/gpt-6-sol',
      'openai/gpt-4o',
      'google-antigravity/gemini-3.1-pro-high',
    ]);
    expect(offeredModels(MODELS).options.map((option) => option.value)).toEqual([
      'openai/gpt-6-sol',
      'openai/gpt-4o',
      'google-antigravity/gemini-3.1-pro-high',
    ]);
  });

  it('starts a conversation without a model on the default, else the first enabled model', () => {
    const enabled = new Set(['google-antigravity/gemini-3.1-pro-high']);
    expect(pickModel(MODELS, { provider: 'openai', id: 'gpt-4o' }, enabled)).toMatchObject({ id: 'gpt-4o' });
    expect(pickModel(MODELS, undefined, enabled)).toMatchObject({ id: 'gemini-3.1-pro-high' });
    expect(pickModel(MODELS)).toMatchObject({ id: 'gpt-6-sol' });
  });
});
