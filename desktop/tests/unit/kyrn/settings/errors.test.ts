import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, type TFunction } from 'i18next';
import { BackendHttpError } from '@/common/adapter/httpBridge';
import { unwrap } from '@/common/kyrn/bridge';
import { KYRN_ERROR_CODES, KyrnError, kyrnFailure, type KyrnErrorParams } from '@/common/kyrn/errors';
import { parseManifest } from '@/common/kyrn/manifest';
import { testProvider } from '@/process/agent/kyrn/config/connection';
import { initializeKyrn, type BackendRequest } from '@/process/agent/kyrn/product';
import { SettingsStore } from '@/process/agent/kyrn/settings';
import { muErrorText, toMuError } from '@/renderer/pages/settings/KyrnSettings/fields/muError';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import zhMu from '@/renderer/services/i18n/locales/zh-CN/mu.json';
import twMu from '@/renderer/services/i18n/locales/zh-TW/mu.json';
import manifestJson from './manifest.fixture.json';

// The IPC layer is not under test: only `unwrap` is.
vi.mock('@/common/platform/bridge', () => ({ bridge: { buildProvider: () => ({}) } }));

/** The code and params a piece of work failed with, or what it threw when that was no `KyrnError`. */
function failure(work: () => unknown): { code: string; params: KyrnErrorParams; message: string } | unknown {
  try {
    work();
  } catch (error) {
    return error instanceof KyrnError ? { code: error.code, params: error.params, message: error.message } : error;
  }
  return undefined;
}

const roots: string[] = [];
/** A harness root (with the fixture manifest, or none) and its agent directory. */
function fixture(withManifest = false) {
  const root = mkdtempSync(join(tmpdir(), 'mu-errors-'));
  roots.push(root);
  const dir = join(root, 'agent');
  mkdirSync(dir);
  if (withManifest) {
    mkdirSync(join(root, 'packages', 'kyrn-judge'), { recursive: true });
    writeFileSync(join(root, 'packages', 'kyrn-judge', 'manifest.json'), JSON.stringify(manifestJson));
  }
  return { root, dir, store: new SettingsStore(dir, root) };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A backend where mu is registered, and its health check says it is not online. */
const offline: BackendRequest = async <T>(method: string, path: string): Promise<T> => {
  if (path === '/api/agents/management') return [{ id: 'k', name: 'mu', command: '/acp', enabled: true }] as T;
  if (path === '/api/assistants') return [] as T;
  return (method === 'POST' && path.endsWith('/health-check') ? { status: 'offline' } : {}) as T;
};
/** A backend where another command is registered as mu. */
const taken: BackendRequest = async <T>(): Promise<T> => [{ id: 'k', name: 'mu', command: '/other' }] as T;

describe('the store names what went wrong with a stable code', () => {
  it('for every failure a person can cause from the screen', () => {
    const { dir, store } = fixture();
    const read = store.read();
    expect(failure(() => store.save({ ...read, maxContextTokens: 200 }))).toMatchObject({
      code: 'contextLimit',
      params: { min: 8192, max: 10000000 },
    });
    expect(
      failure(() => store.save({ ...read, credential: { name: 'TYPESAFE_API_KEY', value: 'two words' } }))
    ).toMatchObject({
      code: 'credential',
    });
    const judge = read.judges.jev;
    expect(
      failure(() => store.save({ ...read, judges: { ...read.judges, jev: { ...judge, apiKeyEnv: 'MY_KEY' } } }))
    ).toEqual({
      code: 'keyVariable',
      params: { name: 'MY_KEY' },
      message: 'Invalid credential variable',
    });
    expect(
      failure(() =>
        store.save({ ...read, judges: { ...read.judges, jev: { ...judge, baseUrl: 'http://example.com' } } })
      )
    ).toMatchObject({ code: 'endpoint' });
    const custom = { ...judge, type: 'typesafe' as const, apiKeyEnv: 'MU_JUDGE_CUSTOM_API_KEY' };
    expect(
      failure(() => store.save({ ...read, tiers: ['jev-custom'], judges: { ...read.judges, 'jev-custom': custom } }))
    ).toMatchObject({ code: 'judgeEndpoint', params: { name: 'jev-custom' } });
    // Without a manifest there is nothing to save decisions into.
    expect(failure(() => store.save({ ...read, decisionModes: { 'tool.risk': 'off' } }))).toMatchObject({
      code: 'harnessOld',
    });
    const models = { ...read.models, defaults: { provider: 'relay', model: '', thinkingLevel: '' as const } };
    expect(failure(() => store.save({ ...read, models }))).toMatchObject({ code: 'pickBoth' });
    // The files changed after they were read: the one failure the screen offers a reload for.
    writeFileSync(join(dir, 'settings.json'), '{"defaultModel":"new"}');
    expect(failure(() => store.save(read))).toMatchObject({ code: 'stale' });
  });

  it('names the two providers that would share a key', () => {
    const { dir, store } = fixture();
    const hand = { baseUrl: 'https://a.example.com', api: 'openai-completions', models: [] };
    writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { 'a.b': hand } }));
    const read = store.read();
    const twin = { ...read.models.providers[0], id: 'a-b', name: '' };
    expect(
      failure(() =>
        store.save({
          ...read,
          models: { ...read.models, providers: [...read.models.providers, twin] },
          credentials: [{ name: 'MU_PROVIDER_A_B_API_KEY', value: 'k' }],
        })
      )
    ).toMatchObject({ code: 'sharedKey', params: { providers: ['a.b', 'a-b'] } });
  });

  it('names the option whose value cannot be saved, and the reason', () => {
    const { store } = fixture(true);
    const read = store.read();
    const preflight = read.features.preflight;
    const features = { ...read.features, preflight: { ...preflight, options: { ...preflight.options, waitMs: 1 } } };
    expect(failure(() => store.save({ ...read, features }))).toMatchObject({
      code: 'optionValue',
      params: { feature: 'preflight', option: 'waitMs', problem: 'range' },
    });
  });

  it('names a configuration file that is not JSON, or cannot be read, with the parser or OS words as the message', () => {
    const { dir, store } = fixture();
    writeFileSync(join(dir, 'mu.json'), '{ "tiers": ');
    expect(failure(() => store.read())).toMatchObject({
      code: 'invalidJson',
      params: { file: join(dir, 'mu.json') },
      message: expect.stringContaining('JSON'),
    });
    rmSync(join(dir, 'mu.json'));
    // A file nobody may read (root may read anything, so this only holds for an ordinary user). Windows has no mode
    // bits: chmod there only sets the read-only flag.
    if (process.getuid?.() === 0 || process.platform === 'win32') return;
    writeFileSync(join(dir, 'settings.json'), '{}');
    chmodSync(join(dir, 'settings.json'), 0o000);
    expect(failure(() => store.read())).toMatchObject({
      code: 'unreadable',
      params: { file: join(dir, 'settings.json') },
      message: expect.stringContaining('EACCES'),
    });
    chmodSync(join(dir, 'settings.json'), 0o600);
  });

  it('names a configuration file it cannot write, with the OS words as the message', () => {
    // Root may write anywhere, so this only holds for an ordinary user. Windows has no mode bits, and a folder's
    // read-only flag does not keep files from being written in it.
    if (process.getuid?.() === 0 || process.platform === 'win32') return;
    const { dir, store } = fixture();
    const read = store.read();
    chmodSync(dir, 0o500);
    try {
      expect(failure(() => store.save({ ...read, autoCompaction: !read.autoCompaction }))).toMatchObject({
        code: 'unwritable',
        params: { file: join(dir, 'settings.json') },
        message: expect.stringContaining('EACCES'),
      });
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('for the connection test and the start of mu', async () => {
    const input = {
      id: 'x',
      api: 'openai-completions' as const,
      baseUrl: 'https://x.example.com/v1',
      authHeader: false,
      model: '',
    };
    await expect(testProvider({ ...input, apiKey: 'two words' }, undefined)).rejects.toMatchObject({
      code: 'credential',
    });
    await expect(testProvider({ ...input, baseUrl: 'http://x.example.com' }, undefined)).rejects.toMatchObject({
      code: 'endpoint',
    });

    await expect(initializeKyrn(offline, '/acp')).rejects.toMatchObject({ code: 'runtimeOffline' });
    await expect(initializeKyrn(taken, '/acp')).rejects.toMatchObject({ code: 'otherRegistration' });
  });
});

describe('across the bridge', () => {
  it('keeps the code and params, answers a backend error with its status, and anything else as unknown', () => {
    expect(
      kyrnFailure(new KyrnError('sharedKey', 'Providers a and b would share a key', { providers: ['a', 'b'] }))
    ).toEqual({
      ok: false,
      error: 'Providers a and b would share a key',
      code: 'sharedKey',
      params: { providers: ['a', 'b'] },
    });
    const backend = new BackendHttpError({
      method: 'GET',
      path: '/api/agents/management',
      status: 500,
      body: { success: false, error: 'database is locked', code: 'INTERNAL' },
    });
    expect(kyrnFailure(backend)).toEqual({
      ok: false,
      error: 'database is locked',
      code: 'backend',
      params: { status: 500 },
    });
    expect(kyrnFailure(new TypeError('fetch failed'))).toEqual({ ok: false, error: 'fetch failed', code: 'unknown' });
    expect(kyrnFailure('odd')).toEqual({ ok: false, error: 'odd', code: 'unknown' });
  });

  it('rethrows a failure in the renderer as a KyrnError with the same code', () => {
    expect(unwrap({ ok: true, data: 3 })).toBe(3);
    let thrown: unknown;
    try {
      unwrap({ ok: false, error: 'mu runtime is not online.', code: 'runtimeOffline' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(KyrnError);
    expect(thrown).toMatchObject({ code: 'runtimeOffline', message: 'mu runtime is not online.', params: {} });
    // An answer from before the codes, or from a mock, still becomes something the screen can word.
    expect(() => unwrap({ ok: false, error: 'boom' })).toThrow(expect.objectContaining({ code: 'unknown' }));
  });
});

describe('the words a screen shows for a code', () => {
  const i18n = createInstance();
  let t: TFunction;
  beforeAll(async () => {
    t = await i18n.init({
      lng: 'en-US',
      resources: {
        'en-US': { translation: { mu: enMu } },
        'zh-CN': { translation: { mu: zhMu } },
        'zh-TW': { translation: { mu: twMu } },
      },
      interpolation: { escapeValue: false },
    });
  });
  const harness = parseManifest(manifestJson);
  const manifest = harness.status === 'ok' ? harness.manifest : undefined;
  const params: Record<string, KyrnErrorParams> = {
    contextLimit: { min: 8192, max: 10000000 },
    keyVariable: { name: 'MY_KEY' },
    sharedKey: { providers: ['a.b', 'a-b'] },
    optionValue: { feature: 'preflight', option: 'waitMs', problem: 'range' },
    invalidJson: { file: '/home/me/.mu/agent/mu.json' },
    unreadable: { file: '/home/me/.mu/agent/settings.json' },
    unwritable: { file: '/home/me/.mu/.env' },
    backend: { status: 500 },
    skillName: { name: 'My Skill' },
    skillExists: { name: 'review' },
    notFound: { name: 'review' },
    notMine: { name: 'review', source: 'claude' },
    mcpName: { name: 'my server' },
    mcpExists: { name: 'github' },
    mcpInvalid: { field: 'url' },
  };

  it.each(['en-US', 'zh-CN', 'zh-TW'])(
    'has a sentence for every code in %s, never a key or the English message',
    async (language) => {
      await i18n.changeLanguage(language);
      for (const code of KYRN_ERROR_CODES) {
        const { text } = muErrorText(
          t,
          language,
          { code, params: params[code] ?? {}, message: 'raw English' },
          manifest
        );
        expect(text, code).not.toMatch(/^mu\./);
        expect(text, code).not.toContain('raw English');
        expect(text, code).not.toContain('{{');
      }
    }
  );

  it('formats lists and numbers in the language, names the option, and keeps the raw message only as detail', async () => {
    await i18n.changeLanguage('en-US');
    const word = (code: (typeof KYRN_ERROR_CODES)[number], message = 'raw') =>
      muErrorText(t, i18n.language, { code, params: params[code] ?? {}, message }, manifest);
    expect(word('sharedKey')).toEqual({
      text: 'a.b and a-b would share one key variable. Change one of the IDs.',
      detail: '',
    });
    expect(word('contextLimit').text).toBe('The context cap must be 0 or a whole number from 8,192 to 10,000,000.');
    expect(word('optionValue').text).toBe('“Wait at most” is outside the allowed range.');
    expect(word('invalidJson', 'Unexpected end of JSON input')).toEqual({
      text: '/home/me/.mu/agent/mu.json is not valid JSON. Fix it by hand, then reload.',
      detail: 'Unexpected end of JSON input',
    });
    expect(word('unwritable', 'EACCES: permission denied')).toEqual({
      text: '/home/me/.mu/.env could not be written.',
      detail: 'EACCES: permission denied',
    });
    expect(word('backend', 'database is locked')).toEqual({
      text: 'The local service did not answer as expected (HTTP 500).',
      detail: 'database is locked',
    });
    expect(word('stale').text).toMatch(/^Another program/);
    expect(word('notMine')).toEqual({
      text: 'review comes from Claude Code. mu does not change those files.',
      detail: '',
    });
    expect(word('mcpInvalid').text).toBe('The URL must start with http:// or https://.');
    // A command's arguments are part of the command.
    expect(muErrorText(t, 'en-US', { code: 'mcpInvalid', params: { field: 'args' }, message: '' }).text).toBe(
      'The command cannot be used. Check it and try again.'
    );
    await i18n.changeLanguage('zh-CN');
    expect(muErrorText(t, 'zh-CN', { code: 'sharedKey', params: params.sharedKey, message: '' }).text).toBe(
      'a.b 和 a-b 会共用同一个密钥变量，请修改其中一个 ID。'
    );
    expect(
      muErrorText(t, 'zh-CN', { code: 'optionValue', params: params.optionValue, message: '' }, manifest).text
    ).toBe('「最多等待」超出了允许的范围。');
    expect(
      muErrorText(t, 'zh-CN', { code: 'notMine', params: { name: 'x', source: 'agents' }, message: '' }).text
    ).toBe('x 来自 共享的 .agents 文件夹，mu 不改动那里的文件。');
  });

  it('reads any caught value, and a code it does not know is unknown', () => {
    expect(toMuError(new KyrnError('stale', 'Configuration changed.'))).toEqual({
      code: 'stale',
      params: {},
      message: 'Configuration changed.',
    });
    expect(toMuError(Object.assign(new Error('x'), { code: 'EACCES' }))).toEqual({
      code: 'unknown',
      params: {},
      message: 'x',
    });
    expect(toMuError('plain')).toEqual({ code: 'unknown', params: {}, message: 'plain' });
  });
});
