import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../../../../packages/desktop/src/process/agent/kyrn/settings';
import {
  isSafeEndpoint,
  providerKeyVariable,
  suggestProviderId,
  supportedThinkingLevels,
  type ProviderSettings,
} from '../../../../packages/desktop/src/common/kyrn/models';

type Json = Record<string, unknown>;

function fixture(models?: Json | string, pi?: Json) {
  const root = mkdtempSync(join(tmpdir(), 'mu-models-'));
  const dir = join(root, 'agent');
  mkdirSync(dir);
  if (models)
    writeFileSync(join(dir, 'models.json'), typeof models === 'string' ? models : JSON.stringify(models, null, 2));
  if (pi) writeFileSync(join(dir, 'settings.json'), JSON.stringify(pi, null, 2));
  const json = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Json;
  return {
    root,
    dir,
    store: new SettingsStore(dir, root),
    models: () => json('models.json').providers as Record<string, Json>,
    pi: () => json('settings.json'),
    env: () => (existsSync(join(root, '.env')) ? readFileSync(join(root, '.env'), 'utf8') : ''),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
function using<T>(f: ReturnType<typeof fixture>, work: (f: ReturnType<typeof fixture>) => T): T {
  try {
    return work(f);
  } finally {
    f.cleanup();
  }
}

const provider = (patch: Partial<ProviderSettings> = {}): ProviderSettings => ({
  id: 'my-proxy',
  name: 'My proxy',
  api: 'anthropic-messages',
  baseUrl: 'https://proxy.example.com',
  authHeader: false,
  models: [
    {
      id: 'claude-x',
      name: '',
      reasoning: true,
      imageInput: true,
      contextWindow: 200000,
      maxTokens: 16384,
      thinkingLevelMap: {},
      thinkingLevels: [],
    },
  ],
  key: 'none',
  keySet: false,
  headerNames: [],
  ...patch,
});

/** What a person might have written by hand: things this screen does not edit are all over it. */
const handWritten = {
  providers: {
    anthropic: { baseUrl: 'https://my-proxy.example.com' },
    openrouter: { modelOverrides: { 'anthropic/claude-sonnet-4': { name: 'Bedrock route' } } },
    ollama: {
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      apiKey: 'ollama',
      compat: { supportsDeveloperRole: false },
      headers: { 'x-team': '!op read op://vault/team' },
      models: [
        { id: 'llama3.1:8b' },
        {
          id: 'gpt-oss:20b',
          reasoning: true,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          thinkingLevelMap: { off: null, max: 'max' },
        },
      ],
    },
    vault: {
      baseUrl: 'https://vault.example.com/v1',
      api: 'openai-responses',
      apiKey: '!op read op://vault/key',
      models: [{ id: 'm' }],
    },
    azure: { baseUrl: 'https://azure.example.com', api: 'azure-openai-responses', models: [{ id: 'gpt' }] },
  },
};

describe('custom model providers in models.json', () => {
  it('shows editable providers, and lists overrides of built-in ones and unknown wire formats without editing them', () => {
    using(fixture(handWritten), (f) => {
      const { models } = f.store.read();
      expect(models.providers.map((item) => item.id)).toEqual(['ollama', 'vault']);
      expect(models.foreign.map((item) => item.id)).toEqual(['anthropic', 'openrouter', 'azure']);
      const [ollama, vault] = models.providers;
      // A literal and a command are somebody's own arrangement: reported as set, never read back.
      expect([ollama.key, ollama.keySet, vault.key, vault.keySet]).toEqual(['manual', true, 'manual', true]);
      expect(ollama.headerNames).toEqual(['x-team']);
      expect(JSON.stringify(models)).not.toContain('op read');
      expect(JSON.stringify(models)).not.toContain('"ollama"}');
      expect(ollama.models[0]).toMatchObject({
        id: 'llama3.1:8b',
        reasoning: false,
        contextWindow: 128000,
        maxTokens: 16384,
      });
      expect(ollama.models[0].thinkingLevels).toEqual(['off']);
      expect(ollama.models[1].thinkingLevels).toEqual(['minimal', 'low', 'medium', 'high', 'max']);
      expect(ollama.models[1].thinkingLevelMap).toEqual({ off: null, max: 'max' });
    });
  });
  it('adds a provider with its key in the harness .env and only a reference in models.json', () => {
    using(fixture(handWritten), (f) => {
      const read = f.store.read();
      const saved = f.store.save({
        ...read,
        models: { ...read.models, providers: [...read.models.providers, provider()] },
        credentials: [{ name: 'MU_PROVIDER_MY_PROXY_API_KEY', value: 'sk-fixture-secret' }],
      });
      expect(f.models()['my-proxy']).toEqual({
        name: 'My proxy',
        baseUrl: 'https://proxy.example.com',
        api: 'anthropic-messages',
        apiKey: '$MU_PROVIDER_MY_PROXY_API_KEY',
        models: [{ id: 'claude-x', reasoning: true, input: ['text', 'image'], contextWindow: 200000 }],
      });
      expect(f.env()).toBe('MU_PROVIDER_MY_PROXY_API_KEY=sk-fixture-secret\n');
      // Windows has no mode bits: a file in the user's profile is theirs through the folder's access rules.
      if (process.platform !== 'win32') {
        expect(statSync(join(f.root, '.env')).mode & 0o777).toBe(0o600);
        expect(statSync(join(f.dir, 'models.json')).mode & 0o777).toBe(0o600);
      }
      expect(JSON.stringify(saved)).not.toContain('sk-fixture-secret');
      expect(readFileSync(join(f.dir, 'models.json'), 'utf8')).not.toContain('sk-fixture-secret');
      const added = saved.models.providers.find((item) => item.id === 'my-proxy')!;
      expect([added.key, added.keySet]).toEqual(['managed', true]);
      // Everything that was there is still there, byte for byte in meaning and in order.
      const { 'my-proxy': _added, ...rest } = f.models();
      expect(rest).toEqual(handWritten.providers);
      expect(Object.keys(f.models())).toEqual([...Object.keys(handWritten.providers), 'my-proxy']);
    });
  });
  it('edits over the existing entry: foreign fields, a hand-written key and untouched models stay as they were', () => {
    using(fixture(handWritten), (f) => {
      const read = f.store.read();
      const ollama = read.models.providers[0];
      const models = [{ ...ollama.models[0], name: 'Llama 3.1', contextWindow: 64000 }, ollama.models[1]];
      f.store.save({
        ...read,
        models: {
          ...read.models,
          providers: [{ ...ollama, name: 'Ollama', authHeader: true, models }, read.models.providers[1]],
        },
      });
      const written = f.models();
      expect(written.ollama).toEqual({
        ...handWritten.providers.ollama,
        name: 'Ollama',
        authHeader: true,
        models: [
          { id: 'llama3.1:8b', name: 'Llama 3.1', contextWindow: 64000 },
          handWritten.providers.ollama.models[1],
        ],
      });
      expect(written.vault).toEqual(handWritten.providers.vault);
      expect(f.env()).toBe('');
    });
  });
  it('writes the thinking levels the screen turned on and off, and keeps the rest of the model', () => {
    using(fixture(handWritten), (f) => {
      const read = f.store.read();
      const ollama = read.models.providers[0];
      const gpt = { ...ollama.models[1], thinkingLevelMap: { off: null, xhigh: 'xhigh' } };
      f.store.save({
        ...read,
        models: {
          ...read.models,
          providers: [{ ...ollama, models: [ollama.models[0], gpt] }, read.models.providers[1]],
        },
      });
      const models = f.models().ollama.models as Json[];
      expect(models[1]).toEqual({
        id: 'gpt-oss:20b',
        reasoning: true,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        thinkingLevelMap: { off: null, xhigh: 'xhigh' },
      });
      expect(models[0]).toEqual(handWritten.providers.ollama.models[0]);
    });
  });
  it('stores only levels that differ from the default, and keeps a custom wire value', () => {
    const doc = {
      providers: {
        grok: {
          baseUrl: 'http://127.0.0.1:8000/v1',
          api: 'openai-responses',
          models: [{ id: 'grok-4.7', reasoning: true, thinkingLevelMap: { xhigh: 'extra-high' } }],
        },
      },
    };
    using(fixture(doc), (f) => {
      const read = f.store.read();
      const grok = read.models.providers[0];
      const model = grok.models[0];
      expect(model.thinkingLevelMap).toEqual({ xhigh: 'extra-high' });
      expect(model.thinkingLevels).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
      f.store.save({
        ...read,
        models: {
          ...read.models,
          providers: [
            {
              ...grok,
              models: [{ ...model, thinkingLevelMap: { low: 'low', minimal: null, xhigh: 'extra-high', max: null } }],
            },
          ],
        },
      });
      expect((f.models().grok.models as Json[])[0]).toEqual({
        id: 'grok-4.7',
        reasoning: true,
        thinkingLevelMap: { minimal: null, xhigh: 'extra-high' },
      });
    });
  });
  it('refuses a thinking map with an unknown level or a wire value that is not plain text', () => {
    using(fixture(handWritten), (f) => {
      const read = f.store.read();
      const ollama = read.models.providers[0];
      const save = (thinkingLevelMap: unknown) =>
        f.store.save({
          ...read,
          models: {
            ...read.models,
            providers: [
              {
                ...ollama,
                models: [{ ...ollama.models[1], thinkingLevelMap: thinkingLevelMap as never }],
              },
            ],
          },
        });
      expect(() => save({ turbo: 'x' })).toThrow('Invalid thinking level');
      expect(() => save({ xhigh: 'bad\nvalue' })).toThrow('Invalid thinking level');
    });
  });
  it('replaces a hand-written key only when a new one is typed', () => {
    using(fixture(handWritten), (f) => {
      const read = f.store.read();
      f.store.save({ ...read, credentials: [{ name: providerKeyVariable('vault'), value: 'new-key' }] });
      expect(f.models().vault.apiKey).toBe('$MU_PROVIDER_VAULT_API_KEY');
      expect(f.env()).toBe('MU_PROVIDER_VAULT_API_KEY=new-key\n');
    });
  });
  it('removes a provider together with the key this app stored for it, and nothing else', () => {
    using(fixture(handWritten), (f) => {
      writeFileSync(join(f.root, '.env'), '# mine\nTYPESAFE_API_KEY=judge\nMU_PROVIDER_OTHER_API_KEY=other\n');
      const first = f.store.read();
      const added = f.store.save({
        ...first,
        models: { ...first.models, providers: [...first.models.providers, provider()] },
        credentials: [{ name: 'MU_PROVIDER_MY_PROXY_API_KEY', value: 'sk-1' }],
      });
      expect(f.env()).toContain('MU_PROVIDER_MY_PROXY_API_KEY=sk-1');
      f.store.save({
        ...added,
        models: { ...added.models, providers: added.models.providers.filter((item) => item.id === 'ollama') },
      });
      expect(Object.keys(f.models())).toEqual(['anthropic', 'openrouter', 'ollama', 'azure']);
      expect(f.env()).toBe('# mine\nTYPESAFE_API_KEY=judge\nMU_PROVIDER_OTHER_API_KEY=other\n');
    });
  });
  it('deletes a hand-written entry only when it is named, whole, and leaves every other entry as it was', () => {
    using(fixture(handWritten), (f) => {
      const read = f.store.read();
      const before = f.models();
      f.store.save({ ...read, models: { ...read.models, removeEntries: ['openrouter'] } });
      const after = f.models();
      expect(Object.keys(after)).toEqual(['anthropic', 'ollama', 'vault', 'azure']);
      for (const id of Object.keys(after)) expect(after[id]).toEqual(before[id]);
      expect(f.store.read().models.foreign.map((item) => item.id)).toEqual(['anthropic', 'azure']);
    });
  });
  it('refuses to delete by name what is not a hand-written entry, or out of a models.json with comments', () => {
    using(fixture(handWritten), (f) => {
      const read = f.store.read();
      const remove = (ids: unknown) => () =>
        f.store.save({ ...read, models: { ...read.models, removeEntries: ids as string[] } });
      // A provider of this screen is removed by leaving it out; an unknown or inherited name is no entry at all.
      for (const id of ['ollama', 'missing', 'constructor', '__proto__', 7])
        expect(remove([id])).toThrow('Invalid entry to remove');
      expect(remove('openrouter')).toThrow('Invalid entries');
      expect(Object.keys(f.models())).toEqual(['anthropic', 'openrouter', 'ollama', 'vault', 'azure']);
    });
    const commented = `{
  // by hand
  "providers": { "anthropic": { "baseUrl": "https://p.example.com" } }
}`;
    using(fixture(commented), (f) => {
      const read = f.store.read();
      expect(() => f.store.save({ ...read, models: { ...read.models, removeEntries: ['anthropic'] } })).toThrow(
        'contains comments'
      );
      expect(readFileSync(join(f.dir, 'models.json'), 'utf8')).toBe(commented);
    });
  });
  it('validates the id of a new provider: a slug, not taken, and not one of the built-in providers', () => {
    using(fixture(handWritten), (f) => {
      const read = f.store.read();
      const add = (id: string) => () =>
        f.store.save({ ...read, models: { ...read.models, providers: [...read.models.providers, provider({ id })] } });
      for (const id of ['My Proxy', 'a_b', '-lead', '', 'x'.repeat(41), 'openai', 'anthropic', 'azure', 'ollama'])
        expect(add(id), id).toThrow(/Invalid provider id|Duplicate provider/);
      expect(add('good-one-2')).not.toThrow();
    });
  });
  it('validates the endpoint like a judge URL: HTTPS, or HTTP to this machine or a private network, without credentials', () => {
    using(fixture(), (f) => {
      const read = f.store.read();
      const add = (patch: Partial<ProviderSettings>) => () =>
        f.store.save({ ...read, models: { ...read.models, providers: [provider(patch)] } });
      // A save moves the revision on, so each address that is taken is saved over a fresh read.
      const save = (patch: Partial<ProviderSettings>) => () => {
        const now = f.store.read();
        f.store.save({ ...now, models: { ...now.models, providers: [provider(patch)] } });
      };
      for (const baseUrl of [
        'http://example.com/v1',
        'http://8.8.8.8/v1',
        'http://172.32.0.1/v1',
        'https://user:pw@example.com',
        'https://example.com/?key=1',
        'ftp://x',
        '',
      ])
        expect(add({ baseUrl }), baseUrl).toThrow('private-network address');
      expect(add({ api: 'soap' as 'openai-responses' })).toThrow('Invalid endpoint type');
      expect(add({ models: [{ ...provider().models[0], id: ' ' }] })).toThrow('Invalid model id');
      expect(add({ models: [provider().models[0], provider().models[0]] })).toThrow('Invalid model id');
      expect(add({ models: [{ ...provider().models[0], contextWindow: 0 }] })).toThrow('Invalid context window');
      expect(add({ models: [{ ...provider().models[0], maxTokens: 1.5 }] })).toThrow('Invalid max output tokens');
      expect(existsSync(join(f.dir, 'models.json'))).toBe(false);
      expect(add({ baseUrl: 'http://127.0.0.1:8080/v1', api: 'openai-completions' })).not.toThrow();
      expect(save({ baseUrl: 'http://192.168.31.124:8000/v1', api: 'openai-completions' })).not.toThrow();
      expect(save({ baseUrl: 'http://10.1.2.3/v1', api: 'openai-completions' })).not.toThrow();
      expect(save({ baseUrl: 'http://172.16.5.5/v1', api: 'openai-completions' })).not.toThrow();
      expect(save({ baseUrl: 'http://[fd00::1]:8000/v1', api: 'openai-completions' })).not.toThrow();
    });
  });
  it('only takes a key for a provider of the same save, under the one variable its id maps to', () => {
    using(fixture(), (f) => {
      const read = f.store.read();
      const models = { ...read.models, providers: [provider()] };
      const save =
        (name: string, value = 'key', withModels = true) =>
        () =>
          f.store.save({
            ...read,
            ...(withModels ? { models } : { models: undefined }),
            credentials: [{ name, value }],
          });
      expect(save('MU_PROVIDER_SOMEONE_ELSE_API_KEY')).toThrow('Invalid credential');
      expect(save('NODE_OPTIONS')).toThrow('Invalid credential');
      expect(save('MU_PROVIDER_MY_PROXY_API_KEY', 'a b; rm -rf')).toThrow('Invalid credential');
      expect(save('MU_PROVIDER_MY_PROXY_API_KEY', 'key', false)).toThrow('Invalid credential');
      expect(f.env()).toBe('');
      // A judge may not borrow a provider's key either.
      const judges = { ...read.judges, jev: { ...read.judges.jev, apiKeyEnv: 'MU_PROVIDER_MY_PROXY_API_KEY' } };
      expect(() => f.store.save({ ...read, judges })).toThrow('Invalid credential variable');
    });
  });
  it('refuses two providers whose ids map to the same variable', () => {
    using(
      fixture({ providers: { 'a.b': { baseUrl: 'https://a.example.com', api: 'openai-completions', models: [] } } }),
      (f) => {
        const read = f.store.read();
        const twin = provider({ id: 'a-b' });
        expect(providerKeyVariable('a.b')).toBe(providerKeyVariable('a-b'));
        expect(() =>
          f.store.save({
            ...read,
            models: { ...read.models, providers: [...read.models.providers, twin] },
            credentials: [{ name: providerKeyVariable('a-b'), value: 'k' }],
          })
        ).toThrow(/Invalid credential|share a key/);
      }
    );
  });
  it('reads a models.json with comments the way pi does, and refuses to save providers into it', () => {
    const commented = `{
  // my local models
  "providers": {
    "ollama": { "baseUrl": "http://localhost:11434/v1", "api": "openai-completions", "models": [{ "id": "a//b" },] },
  }
}`;
    using(fixture(commented, { defaultProvider: 'ollama', defaultModel: 'a//b' }), (f) => {
      const read = f.store.read();
      expect(read.models.commented).toBe(true);
      expect(read.models.providers[0].models[0].id).toBe('a//b');
      expect(() => f.store.save({ ...read, models: { ...read.models, providers: [] } })).toThrow('contains comments');
      expect(readFileSync(join(f.dir, 'models.json'), 'utf8')).toBe(commented);
      // The defaults live in another file and still save.
      f.store.save({
        ...read,
        models: { ...read.models, defaults: { ...read.models.defaults, thinkingLevel: 'high' } },
      });
      expect(f.pi().defaultThinkingLevel).toBe('high');
    });
  });
  it('reports a models.json that cannot be parsed and keeps its hands off it', () => {
    using(fixture('{ "providers": '), (f) => {
      const read = f.store.read();
      expect(read.models.problem).not.toBe('');
      expect(read.models.providers).toEqual([]);
      expect(() => f.store.save({ ...read, models: { ...read.models, providers: [provider()] } })).toThrow(
        'could not be read'
      );
      expect(readFileSync(join(f.dir, 'models.json'), 'utf8')).toBe('{ "providers": ');
    });
  });
});

describe('the startup model and thinking level in settings.json', () => {
  it('writes the three keys, keeps everything else, and removes a key that is cleared', () => {
    using(
      fixture(undefined, { theme: 'dark', compaction: { reserveTokens: 1000 }, defaultThinkingLevel: 'low' }),
      (f) => {
        const read = f.store.read();
        expect(read.models.defaults).toEqual({ provider: '', model: '', thinkingLevel: 'low' });
        const saved = f.store.save({
          ...read,
          models: {
            ...read.models,
            defaults: { provider: 'anthropic', model: 'claude-sonnet-5', thinkingLevel: 'xhigh' },
          },
        });
        expect(f.pi()).toEqual({
          theme: 'dark',
          compaction: { reserveTokens: 1000 },
          defaultThinkingLevel: 'xhigh',
          defaultProvider: 'anthropic',
          defaultModel: 'claude-sonnet-5',
        });
        f.store.save({
          ...saved,
          models: { ...saved.models, defaults: { provider: '', model: '', thinkingLevel: '' } },
        });
        expect(f.pi()).toEqual({ theme: 'dark', compaction: { reserveTokens: 1000 } });
      }
    );
  });
  it('rejects a level pi does not have, and a provider without a model', () => {
    using(fixture(), (f) => {
      const read = f.store.read();
      const save = (defaults: Json) => () =>
        f.store.save({ ...read, models: { ...read.models, defaults: defaults as typeof read.models.defaults } });
      expect(save({ provider: 'a', model: 'b', thinkingLevel: 'ultra' })).toThrow('Invalid thinking level');
      expect(save({ provider: 'a', model: '', thinkingLevel: '' })).toThrow('together');
      expect(existsSync(join(f.dir, 'settings.json'))).toBe(false);
    });
  });
  it('moves a per-model level along, because pi lets that one win over the default', () => {
    const pi = { defaultProvider: 'p', defaultModel: 'm', modelThinkingLevels: { 'p/m': 'high', 'p/other': 'low' } };
    using(fixture(undefined, pi), (f) => {
      const read = f.store.read();
      f.store.save({
        ...read,
        models: { ...read.models, defaults: { provider: 'p', model: 'm', thinkingLevel: 'minimal' } },
      });
      expect(f.pi().modelThinkingLevels).toEqual({ 'p/m': 'minimal', 'p/other': 'low' });
    });
  });
  it('a send box makes a model the default: only the defaults change, with no revision to match', () => {
    const pi = { theme: 'dark', defaultProvider: 'p', defaultModel: 'm', defaultThinkingLevel: 'low' };
    using(fixture({ providers: {} }, pi), (f) => {
      const models = readFileSync(join(f.dir, 'models.json'), 'utf8');
      expect(f.store.defaultModel()).toEqual({ provider: 'p', model: 'm', thinkingLevel: 'low' });
      // Without a level, the default level stays.
      expect(f.store.setDefaultModel({ provider: 'openai-codex', model: 'gpt-5.6-luna' })).toEqual({
        provider: 'openai-codex',
        model: 'gpt-5.6-luna',
        thinkingLevel: 'low',
      });
      expect(f.pi()).toEqual({ ...pi, defaultProvider: 'openai-codex', defaultModel: 'gpt-5.6-luna' });
      f.store.setDefaultModel({ provider: 'openai-codex', model: 'gpt-5.6-luna', thinkingLevel: 'high' });
      expect(f.pi().defaultThinkingLevel).toBe('high');
      expect(readFileSync(join(f.dir, 'models.json'), 'utf8')).toBe(models);
    });
  });
  it('refuses a default from a send box without a model or with a level pi does not have', () => {
    using(fixture(), (f) => {
      expect(() => f.store.setDefaultModel({ provider: 'p', model: '' })).toThrow('Invalid model');
      expect(() =>
        f.store.setDefaultModel({ provider: 'p', model: 'm', thinkingLevel: 'ultra' as unknown as 'high' })
      ).toThrow('Invalid model');
      expect(existsSync(join(f.dir, 'settings.json'))).toBe(false);
      expect(f.store.defaultModel()).toEqual({ provider: '', model: '', thinkingLevel: '' });
    });
  });
  it('knows which levels a model takes, by pi’s rule', () => {
    expect(supportedThinkingLevels(false)).toEqual(['off']);
    expect(supportedThinkingLevels(true)).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    expect(supportedThinkingLevels(true, { off: null, xhigh: 'xhigh', max: null })).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(suggestProviderId(' My Proxy (EU) ')).toBe('my-proxy-eu');
  });
});

describe('one revision over the three files', () => {
  it.each(['mu.json', 'settings.json', 'models.json'])('rejects a save after %s changed underneath it', (name) => {
    using(fixture(handWritten, { defaultModel: 'a' }), (f) => {
      const old = f.store.read();
      writeFileSync(join(f.dir, name), name === 'models.json' ? '{"providers":{}}' : '{"tiers":["mock"]}');
      expect(() => f.store.save({ ...old, mode: 'shadow' })).toThrow('Configuration changed');
      // The rejected save wrote nothing: no `modes` anywhere.
      for (const file of ['mu.json', 'settings.json', 'models.json'])
        if (existsSync(join(f.dir, file))) expect(readFileSync(join(f.dir, file), 'utf8')).not.toContain('modes');
    });
  });
  it('writes only the files a save changes', () => {
    using(fixture(handWritten, { defaultModel: 'a' }), (f) => {
      const before = ['models.json', 'settings.json'].map((name) => readFileSync(join(f.dir, name), 'utf8'));
      f.store.save({ ...f.store.read(), mode: 'shadow' });
      expect(['models.json', 'settings.json'].map((name) => readFileSync(join(f.dir, name), 'utf8'))).toEqual(before);
      expect(existsSync(join(f.dir, 'mu.json'))).toBe(true);
    });
  });
});

describe('isSafeEndpoint', () => {
  const allowed = [
    'https://api.example.com/v1',
    'http://127.0.0.1:8080/v1',
    'http://localhost:11434/v1',
    'http://[::1]:11434/v1',
    'http://10.0.0.8/v1',
    'http://172.16.0.1/v1',
    'http://172.31.255.254/v1',
    'http://192.168.31.124:8000/v1',
    'http://[fd00::1]:8000/v1',
    'http://[fd7a:115c:a1e0::1]/v1',
    'http://[::ffff:192.168.1.5]/v1',
    'https://192.168.1.1/v1',
  ];
  const refused = [
    'http://example.com/v1',
    'http://8.8.8.8/v1',
    'http://172.15.255.255/v1',
    'http://172.32.0.1/v1',
    'http://11.0.0.1/v1',
    'http://169.254.169.254/',
    'http://[2001:db8::1]/v1',
    'http://[::ffff:8.8.8.8]/v1',
    'http://192.168.1.1/?key=1',
    'http://user:pw@192.168.1.1/v1',
    'https://user:pw@example.com',
    'ftp://192.168.1.1',
    '',
    'not a url',
  ];
  it('allows https, loopback http, and private-network http literals', () => {
    for (const url of allowed) expect(isSafeEndpoint(url), url).toBe(true);
    for (const url of refused) expect(isSafeEndpoint(url), url).toBe(false);
  });
});
