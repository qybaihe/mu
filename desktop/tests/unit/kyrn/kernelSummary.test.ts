import { describe, expect, it } from 'vitest';
import type { HarnessManifest } from '@/common/kyrn/manifest';
import type { KyrnSettings } from '@/common/kyrn/types';
import { describeTier, summarize } from '@/renderer/components/kernel/kernelSummary';

const NO_KEYS: Record<string, boolean> = {};

const decision = (id: string, feature: string) => ({
  id,
  group: 'tools',
  feature,
  title: { zh: id, en: id },
  summary: { zh: id, en: id },
});

function settings(overrides: Partial<KyrnSettings> = {}): KyrnSettings {
  const manifest = {
    version: 1,
    groups: [],
    modes: [],
    decisions: [decision('tool.risk', 'guard'), decision('turn.drift', 'drift'), decision('board.read', 'board')],
    features: [],
  } as unknown as HarnessManifest;
  return {
    revision: 'r',
    tiers: ['jev'],
    judges: {},
    mode: 'active',
    betaCompression: false,
    autoCompaction: true,
    maxContextTokens: 0,
    keys: NO_KEYS,
    harness: { status: 'ok', manifest },
    decisionModes: {},
    features: {
      guard: { enabled: true, options: {} },
      drift: { enabled: true, options: {} },
      board: { enabled: false, options: {} },
    },
    models: {} as KyrnSettings['models'],
    permissions: { mode: 'judge', from: 'default' },
    boardModel: { supported: true, model: '' },
    ...overrides,
  };
}

describe('kernel summary', () => {
  it('names the free Jev on OpenCode Zen when no Jev key is set, and the first service whose keys are', () => {
    expect(describeTier('jev', NO_KEYS)).toEqual({ judge: 'Jev', via: 'OpenCode Zen', free: true });
    expect(describeTier('jev', { MU_JUDGE_OPENROUTER_API_KEY: true })).toEqual({
      judge: 'Jev',
      via: 'OpenRouter',
      free: false,
    });
    // Cloudflare needs its account id as well as its key.
    expect(describeTier('jev', { CLOUDFLARE_API_KEY: true })).toMatchObject({ via: 'OpenCode Zen', free: true });
    expect(describeTier('jev', { CLOUDFLARE_API_KEY: true, CLOUDFLARE_ACCOUNT_ID: true })).toMatchObject({
      via: 'Cloudflare',
    });
  });

  it('names Laya, named services and model judges by what a person would call them', () => {
    expect(describeTier('laya', NO_KEYS)).toEqual({ judge: 'Laya', via: 'local', free: false });
    expect(describeTier('mude', NO_KEYS)).toEqual({ judge: 'mude', via: 'local', free: false });
    expect(describeTier('jev-direct', NO_KEYS)).toMatchObject({ judge: 'Jev', via: 'TypeSafe' });
    expect(describeTier('classifier:openrouter/acme/judge-1', NO_KEYS)).toMatchObject({ judge: 'acme/judge-1' });
    expect(describeTier('llm:anthropic/claude-haiku-5-5', NO_KEYS)).toMatchObject({ judge: 'claude-haiku-5-5' });
  });

  it('counts the decision points that act: active, with their feature on', () => {
    expect(summarize(settings())).toMatchObject({ judge: 'Jev', fallbacks: 0, active: 2, shadow: 0, total: 3 });
    expect(summarize(settings({ decisionModes: { 'turn.drift': 'shadow' } }))).toMatchObject({ active: 1, shadow: 1 });
    expect(summarize(settings({ mode: 'off' }))).toMatchObject({ active: 0, shadow: 0, mode: 'off' });
    expect(summarize(settings({ tiers: ['laya', 'jev'] }))).toMatchObject({ judge: 'Laya', fallbacks: 1 });
    expect(summarize(settings({ harness: { status: 'missing' } }))).toMatchObject({ active: 0, total: 0 });
  });

  it('counts a point with a built-in mode by that mode until mu.json sets one for it, and off with the default off', () => {
    const harness = settings().harness;
    if (harness.status !== 'ok') throw new Error('no manifest');
    const decisions = harness.manifest.decisions.map((item) =>
      item.id === 'turn.drift' ? { ...item, defaultMode: 'shadow' as const } : item
    );
    const shadowed = (overrides: Partial<KyrnSettings> = {}) =>
      settings({ harness: { status: 'ok', manifest: { ...harness.manifest, decisions } }, ...overrides });
    expect(summarize(shadowed())).toMatchObject({ active: 1, shadow: 1, total: 3 });
    // With the default off, the built-in mode gives way as in the kernel: no point asks the judge.
    expect(summarize(shadowed({ mode: 'off' }))).toMatchObject({ active: 0, shadow: 0 });
    expect(summarize(shadowed({ decisionModes: { 'turn.drift': 'active' } }))).toMatchObject({ active: 2, shadow: 0 });
  });
});
