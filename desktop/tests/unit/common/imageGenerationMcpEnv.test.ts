import { describe, expect, it } from 'vitest';

import {
  describeImageGenerationResolveFailure,
  IMAGE_GEN_ENV_KEYS,
  removeImageGenerationEnvKeys,
  resolveImageGenerationMcpEnv,
  withCurrentImageGenerationEnvKeys,
} from '@/common/config/imageGenerationMcpEnv';
import type { IProvider } from '@/common/config/storage';

const geminiProvider: IProvider = {
  id: '03c8482c',
  platform: 'gemini',
  name: 'Gemini',
  base_url: 'https://generativelanguage.googleapis.com',
  api_key: 'provider-key',
  models: ['gemini-2.5-pro', 'gemini-3-pro-image-preview'],
  enabled: true,
};

describe('resolveImageGenerationMcpEnv', () => {
  it('resolves image generation env from provider id and selected model', () => {
    const result = resolveImageGenerationMcpEnv({ id: '03c8482c', use_model: 'gemini-3-pro-image-preview' }, [
      geminiProvider,
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe('provider-id');
    expect(result.env).toEqual({
      [IMAGE_GEN_ENV_KEYS.providerId]: '03c8482c',
      [IMAGE_GEN_ENV_KEYS.platform]: 'gemini',
      [IMAGE_GEN_ENV_KEYS.baseUrl]: 'https://generativelanguage.googleapis.com',
      [IMAGE_GEN_ENV_KEYS.apiKey]: 'provider-key',
      [IMAGE_GEN_ENV_KEYS.model]: 'gemini-3-pro-image-preview',
    });
  });

  it('matches legacy env by platform, base URL, and model when provider id is absent', () => {
    const result = resolveImageGenerationMcpEnv(undefined, [geminiProvider], {
      MU_IMG_PLATFORM: 'gemini',
      MU_IMG_BASE_URL: 'https://generativelanguage.googleapis.com/',
      MU_IMG_MODEL: 'gemini-3-pro-image-preview',
      MU_IMG_API_KEY: 'stale-key',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe('field-match');
    expect(result.env.MU_IMG_PROVIDER_ID).toBe('03c8482c');
    expect(result.env.MU_IMG_API_KEY).toBe('provider-key');
  });

  it('reads the settings an earlier version stored under the old names', () => {
    const result = resolveImageGenerationMcpEnv(undefined, [geminiProvider], {
      AIONUI_IMG_PLATFORM: 'gemini',
      AIONUI_IMG_BASE_URL: 'https://generativelanguage.googleapis.com',
      AIONUI_IMG_MODEL: 'gemini-3-pro-image-preview',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.MU_IMG_PROVIDER_ID).toBe('03c8482c');
  });

  it('fails loudly when neither provider id nor legacy fields match a provider', () => {
    const result = resolveImageGenerationMcpEnv(
      { platform: 'gemini', base_url: 'https://unknown.example', use_model: 'gemini-3-pro-image-preview' },
      [geminiProvider]
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-provider-match');
  });

  it('fails when the selected model is not present on the matched provider', () => {
    const result = resolveImageGenerationMcpEnv({ id: '03c8482c', use_model: 'missing-image-model' }, [geminiProvider]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('model-not-found');
  });
});

const echoT = (key: string, options?: Record<string, unknown>) => `${key} ${JSON.stringify(options)}`;

describe('describeImageGenerationResolveFailure', () => {
  it('gives the settings page a translated text with the model and provider name', () => {
    const result = resolveImageGenerationMcpEnv({ id: '03c8482c', use_model: 'missing-image-model' }, [geminiProvider]);
    if (result.ok) throw new Error('expected a failure');

    expect(describeImageGenerationResolveFailure(echoT, result)).toBe(
      'settings.imageGenErrors.modelNotFound {"model":"missing-image-model","provider":"Gemini"}'
    );
  });

  it('asks for a model when nothing is selected', () => {
    const result = resolveImageGenerationMcpEnv(undefined, [geminiProvider]);
    if (result.ok) throw new Error('expected a failure');

    expect(describeImageGenerationResolveFailure(echoT, result)).toBe(
      'settings.imageGenErrors.missingSelection {"model":"","provider":""}'
    );
  });
});

describe('the settings stored under the old names', () => {
  it('move to the current names, and a current name that has a value keeps it', () => {
    expect(
      withCurrentImageGenerationEnvKeys({
        AIONUI_IMG_MODEL: 'old-model',
        MU_IMG_MODEL: 'new-model',
        AIONUI_IMG_PROXY: 'http://proxy:8080',
        OTHER: 'kept',
      })
    ).toEqual({ MU_IMG_MODEL: 'new-model', MU_IMG_PROXY: 'http://proxy:8080', OTHER: 'kept' });
  });

  it('leave the settings as they are when there is nothing to move', () => {
    const env = { MU_IMG_MODEL: 'm', OTHER: 'kept' };
    expect(withCurrentImageGenerationEnvKeys(env)).toBe(env);
  });

  it('go when the image settings are cleared, except a proxy, which stays under its current name', () => {
    expect(
      removeImageGenerationEnvKeys({
        AIONUI_IMG_API_KEY: 'k',
        AIONUI_IMG_MODEL: 'm',
        MU_IMG_PLATFORM: 'gemini',
        AIONUI_IMG_PROXY: 'http://proxy:8080',
        OTHER: 'kept',
      })
    ).toEqual({ MU_IMG_PROXY: 'http://proxy:8080', OTHER: 'kept' });
  });
});
