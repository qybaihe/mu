import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../../../packages/desktop/src/process/agent/kyrn/settings';
import {
  findRegistration,
  initializeKyrn,
  recheckKyrn,
  type BackendRequest,
  type OwnCommand,
} from '../../../packages/desktop/src/process/agent/kyrn/product';
import { ownLauncher } from '../../../packages/desktop/src/process/agent/kyrn/windows/launcherCommand';
import { configPath, muEnv, muHome } from '../../../packages/desktop/src/process/agent/kyrn/naming';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kyrn-settings-'));
  const dir = join(root, 'agent');
  mkdirSync(dir);
  writeFileSync(
    join(dir, 'kyrn.json'),
    JSON.stringify({
      tiers: ['jev'],
      routes: { 'browser.step': ['llm-a'] },
      features: { hive: { maxBees: 4 }, compaction: { enabled: false, keepThreshold: 0.4 } },
      judges: { 'llm-a': { type: 'llm', model: 'p/m', thinking: 'low' } },
    })
  );
  return {
    root,
    dir,
    store: new SettingsStore(dir, root),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
describe('native mu settings', () => {
  it('shares the context cap with pi and preserves model settings and reserve', () => {
    const f = fixture();
    try {
      writeFileSync(
        join(f.dir, 'settings.json'),
        JSON.stringify({ defaultModel: 'model', compaction: { reserveTokens: 1000 } })
      );
      const saved = f.store.save({ ...f.store.read(), maxContextTokens: 64000, autoCompaction: true });
      expect(saved.maxContextTokens).toBe(64000);
      expect(JSON.parse(readFileSync(join(f.dir, 'settings.json'), 'utf8'))).toEqual({
        defaultModel: 'model',
        compaction: { reserveTokens: 1000, enabled: true, maxContextTokens: 64000 },
      });
      expect(() => f.store.save({ ...saved, maxContextTokens: 200 })).toThrow('Context threshold');
    } finally {
      f.cleanup();
    }
  });
  it('rejects a stale save after the CLI changes pi settings', () => {
    const f = fixture();
    try {
      const old = f.store.read();
      writeFileSync(join(f.dir, 'settings.json'), '{"defaultModel":"new"}');
      expect(() => f.store.save(old)).toThrow('Configuration changed');
    } finally {
      f.cleanup();
    }
  });
  it('persists the beta toggle without replacing routes, profiles or feature options', () => {
    const f = fixture();
    try {
      f.store.save({ ...f.store.read(), betaCompression: true });
      const raw = JSON.parse(readFileSync(join(f.dir, 'kyrn.json'), 'utf8'));
      expect(raw.features).toEqual({ hive: { maxBees: 4 }, compaction: { enabled: true, keepThreshold: 0.4 } });
      expect(raw.routes).toEqual({ 'browser.step': ['llm-a'] });
      expect(raw.judges['llm-a'].thinking).toBe('low');
    } finally {
      f.cleanup();
    }
  });
  it('rejects stale saves instead of overwriting CLI changes', () => {
    const f = fixture();
    try {
      const old = f.store.read();
      f.store.save({ ...old, betaCompression: true });
      expect(() => f.store.save(old)).toThrow('Configuration changed');
    } finally {
      f.cleanup();
    }
  });
  it('keeps credentials write-only and restricts shell-sensitive input', () => {
    const f = fixture();
    try {
      const saved = f.store.save({
        ...f.store.read(),
        credential: { name: 'TYPESAFE_API_KEY', value: 'fixture-secret' },
      });
      expect(JSON.stringify(saved)).not.toContain('fixture-secret');
      // Windows has no mode bits: a file in the user's profile is theirs through the folder's access rules.
      if (process.platform !== 'win32') expect(statSync(join(f.root, '.env')).mode & 0o777).toBe(0o600);
      expect(() => f.store.save({ ...saved, credential: { name: 'NODE_OPTIONS', value: 'execute' } })).toThrow(
        'Invalid credential'
      );
    } finally {
      f.cleanup();
    }
  });
  it('accepts a private-network HTTP address for a TypeSafe judge and still refuses a public one', () => {
    const f = fixture();
    try {
      const value = f.store.read();
      value.judges['jev-direct'].baseUrl = 'http://192.168.31.124:8000/v1/systemone';
      expect(f.store.save(value).judges['jev-direct'].baseUrl).toBe('http://192.168.31.124:8000/v1/systemone');
      const again = f.store.read();
      again.judges['jev-direct'].baseUrl = 'http://example.com/v1';
      expect(() => f.store.save(again)).toThrow('private-network address');
      expect(f.store.read().judges['jev-direct'].baseUrl).toBe('http://192.168.31.124:8000/v1/systemone');
    } finally {
      f.cleanup();
    }
  });
  it('offers Jev through OpenRouter as a built-in, with a key of its own', () => {
    const f = fixture();
    try {
      const read = f.store.read();
      expect(read.judges['jev-openrouter']).toEqual({
        type: 'typesafe',
        model: '~typesafe/jev-latest',
        baseUrl: 'https://openrouter.ai/api/v1/systemone',
        apiKeyEnv: 'MU_JUDGE_OPENROUTER_API_KEY',
        timeoutMs: 10000,
      });
      expect(read.keys.MU_JUDGE_OPENROUTER_API_KEY).toBe(false);
      // Asked as it is, the built-in stays out of the file; its key goes to the .env.
      const saved = f.store.save({
        ...read,
        tiers: ['jev-openrouter'],
        credentials: [{ name: 'MU_JUDGE_OPENROUTER_API_KEY', value: 'fixture-openrouter' }],
      });
      expect(saved.keys.MU_JUDGE_OPENROUTER_API_KEY).toBe(true);
      const raw = JSON.parse(readFileSync(join(f.dir, 'kyrn.json'), 'utf8'));
      expect(raw.tiers).toEqual(['jev-openrouter']);
      expect(raw.judges['jev-openrouter']).toBeUndefined();
    } finally {
      f.cleanup();
    }
  });
  it('offers Jev on OpenCode Zen and Cloudflare, and Clef, as classifier models whose keys go where pi reads them', () => {
    const f = fixture();
    try {
      const read = f.store.read();
      expect(read.judges['jev-opencode-free']).toEqual({
        type: 'classifier',
        model: 'opencode/jev-1.13-free',
        baseUrl: '',
        apiKeyEnv: '',
        timeoutMs: 10000,
      });
      expect(read.judges['jev-cloudflare'].model).toBe('cloudflare-workers-ai/typesafe/jev');
      expect(read.judges.clef.model).toBe('cloudflare-workers-ai/@cf/cloudflare/clef');
      expect(read.keys).toMatchObject({
        OPENCODE_API_KEY: false,
        CLOUDFLARE_API_KEY: false,
        CLOUDFLARE_ACCOUNT_ID: false,
      });
      const saved = f.store.save({
        ...read,
        tiers: ['jev-cloudflare', 'jev-opencode-free'],
        credentials: [
          { name: 'CLOUDFLARE_API_KEY', value: 'fixture-cloudflare' },
          { name: 'CLOUDFLARE_ACCOUNT_ID', value: '0123abcd' },
        ],
      });
      expect(saved.keys).toMatchObject({
        CLOUDFLARE_API_KEY: true,
        CLOUDFLARE_ACCOUNT_ID: true,
        OPENCODE_API_KEY: false,
      });
      expect(readFileSync(join(f.root, '.env'), 'utf8')).toContain('CLOUDFLARE_ACCOUNT_ID=0123abcd');
      const raw = JSON.parse(readFileSync(join(f.dir, 'kyrn.json'), 'utf8'));
      expect(raw.tiers).toEqual(['jev-cloudflare', 'jev-opencode-free']);
      expect(raw.judges['jev-cloudflare']).toBeUndefined();
      // A provider's variable is saved like a judge's key, but no judge may name it as its key.
      const now = f.store.read();
      const named = { ...now.judges['jev-direct'], apiKeyEnv: 'OPENCODE_API_KEY' };
      expect(() => f.store.save({ ...now, judges: { ...now.judges, 'jev-direct': named } })).toThrow(
        'Invalid credential variable'
      );
      // A classifier model is named "provider/model-id".
      const bare = { ...now.judges['jev-opencode'], model: 'jev-1.13' };
      expect(() => f.store.save({ ...now, tiers: ['odd'], judges: { ...now.judges, odd: bare } })).toThrow(
        'Invalid model'
      );
    } finally {
      f.cleanup();
    }
  });
  it('refuses to put a custom service in the order without an address, so its key never goes to TypeSafe', () => {
    const f = fixture();
    try {
      const read = f.store.read();
      const custom = {
        type: 'typesafe' as const,
        model: 'jev-latest',
        baseUrl: '',
        apiKeyEnv: 'MU_JUDGE_CUSTOM_API_KEY',
        timeoutMs: 10000,
      };
      const input = { ...read, tiers: ['jev-custom'], judges: { ...read.judges, 'jev-custom': custom } };
      expect(() => f.store.save(input)).toThrow('no base URL');
      // Nor OpenRouter's key, once someone took the address away.
      const bare = { ...read.judges['jev-openrouter'], baseUrl: '' };
      expect(() => f.store.save({ ...read, judges: { ...read.judges, 'jev-openrouter': bare } })).not.toThrow();
      expect(() =>
        f.store.save({
          ...f.store.read(),
          tiers: ['jev-openrouter'],
          judges: { ...f.store.read().judges, 'jev-openrouter': bare },
        })
      ).toThrow('no base URL');
      // With its address it is saved, and the store reads it back with its key's state.
      const address = 'http://192.168.1.20:8000/v1/systemone';
      const saved = f.store.save({
        ...f.store.read(),
        tiers: ['jev-custom'],
        judges: { ...f.store.read().judges, 'jev-custom': { ...custom, baseUrl: address } },
      });
      expect(saved.judges['jev-custom']).toMatchObject({ baseUrl: address, apiKeyEnv: 'MU_JUDGE_CUSTOM_API_KEY' });
      expect(saved.keys.MU_JUDGE_CUSTOM_API_KEY).toBe(false);
    } finally {
      f.cleanup();
    }
  });
  it('leaves a judge the order already had as it is to whoever wrote it, and saves other changes', () => {
    const f = fixture();
    try {
      writeFileSync(
        join(f.dir, 'kyrn.json'),
        JSON.stringify({
          tiers: ['relay'],
          judges: { relay: { type: 'typesafe', apiKeyEnv: 'MU_JUDGE_CUSTOM_API_KEY' } },
        })
      );
      expect(f.store.save({ ...f.store.read(), mode: 'active' }).mode).toBe('active');
    } finally {
      f.cleanup();
    }
  });
  it('rejects credentialed or non-HTTPS external endpoints before changing disk', () => {
    const f = fixture();
    try {
      const value = f.store.read();
      value.judges.jev.baseUrl = 'https://secret@example.com';
      expect(() => f.store.save(value)).toThrow('without embedded credentials');
      expect(f.store.read().judges.jev.baseUrl).toBe('');
    } finally {
      f.cleanup();
    }
  });
  it('offers CLM as a built-in: on this machine, or at an address on the network with the key its server asks for', () => {
    const f = fixture();
    try {
      const read = f.store.read();
      expect(read.judges.clm).toEqual({
        type: 'clm',
        model: 'clm-latest',
        baseUrl: '',
        apiKeyEnv: 'MU_JUDGE_CLM_API_KEY',
        timeoutMs: 10000,
      });
      expect(read.keys.MU_JUDGE_CLM_API_KEY).toBe(false);
      // Chosen as it is: only the order is written, and the harness finds clm-serve on this machine.
      f.store.save({ ...read, tiers: ['clm'] });
      let raw = JSON.parse(readFileSync(join(f.dir, 'kyrn.json'), 'utf8'));
      expect(raw.tiers).toEqual(['clm']);
      expect(raw.judges.clm).toBeUndefined();
      // A server on the network, with the key it was started with.
      const address = 'http://192.168.1.20:8700';
      const now = f.store.read();
      const saved = f.store.save({
        ...now,
        judges: { ...now.judges, clm: { ...now.judges.clm, baseUrl: address } },
        credentials: [{ name: 'MU_JUDGE_CLM_API_KEY', value: 'fixture-clm' }],
      });
      expect(saved.judges.clm.baseUrl).toBe(address);
      expect(saved.keys.MU_JUDGE_CLM_API_KEY).toBe(true);
      raw = JSON.parse(readFileSync(join(f.dir, 'kyrn.json'), 'utf8'));
      expect(raw.judges.clm).toMatchObject({ type: 'clm', baseUrl: address, apiKeyEnv: 'MU_JUDGE_CLM_API_KEY' });
      // The questions hold what the person wrote: plain HTTP to the internet is refused.
      const later = f.store.read();
      const exposed = { ...later.judges.clm, baseUrl: 'http://example.com:8700' };
      expect(() => f.store.save({ ...later, judges: { ...later.judges, clm: exposed } })).toThrow(
        'private-network address'
      );
      // And the CLM key never reaches TypeSafe through a System One judge without an address.
      const stray = {
        type: 'typesafe' as const,
        model: '',
        baseUrl: '',
        apiKeyEnv: 'MU_JUDGE_CLM_API_KEY',
        timeoutMs: 10000,
      };
      expect(() => f.store.save({ ...later, tiers: ['stray'], judges: { ...later.judges, stray } })).toThrow(
        'no base URL'
      );
    } finally {
      f.cleanup();
    }
  });
});

describe('the rename from KYRN to mu', () => {
  it('keeps saving to kyrn.json while that is the only file, and follows it once it is renamed', () => {
    const f = fixture();
    try {
      f.store.save({ ...f.store.read(), mode: 'shadow' });
      expect(existsSync(join(f.dir, 'mu.json'))).toBe(false);
      expect(JSON.parse(readFileSync(join(f.dir, 'kyrn.json'), 'utf8')).modes.default).toBe('shadow');

      // The one-time move of the home renames the file. The same store follows it without a restart.
      renameSync(join(f.dir, 'kyrn.json'), join(f.dir, 'mu.json'));
      expect(f.store.read().mode).toBe('shadow');
      f.store.save({ ...f.store.read(), mode: 'off' });
      expect(JSON.parse(readFileSync(join(f.dir, 'mu.json'), 'utf8')).modes.default).toBe('off');
      expect(existsSync(join(f.dir, 'kyrn.json'))).toBe(false);
    } finally {
      f.cleanup();
    }
  });
  it('reads mu.json first when both files are there, and writes mu.json on a fresh machine', () => {
    const f = fixture();
    try {
      writeFileSync(join(f.dir, 'mu.json'), JSON.stringify({ tiers: ['laya'] }));
      expect(f.store.read().tiers).toEqual(['laya']);
      const fresh = join(f.root, 'fresh');
      mkdirSync(fresh);
      expect(configPath(fresh)).toBe(join(fresh, 'mu.json'));
    } finally {
      f.cleanup();
    }
  });
  it('accepts credential variables under the new prefix and the old one', () => {
    const f = fixture();
    try {
      for (const apiKeyEnv of ['MU_JUDGE_CUSTOM', 'KYRN_JUDGE_CUSTOM']) {
        const value = f.store.read();
        value.judges.jev.apiKeyEnv = apiKeyEnv;
        expect(f.store.save(value).judges.jev.apiKeyEnv).toBe(apiKeyEnv);
      }
      const value = f.store.read();
      value.judges.jev.apiKeyEnv = 'PATH';
      expect(() => f.store.save(value)).toThrow('Invalid credential variable');
    } finally {
      f.cleanup();
    }
  });
  it('stays in the old home until it has been moved, and never creates a second one beside it', () => {
    const f = fixture();
    try {
      expect(muHome(f.root)).toBe(join(f.root, '.mu'));
      mkdirSync(join(f.root, '.kyrn'));
      expect(muHome(f.root)).toBe(join(f.root, '.kyrn'));
      mkdirSync(join(f.root, '.mu'));
      expect(muHome(f.root)).toBe(join(f.root, '.mu'));
      expect(muEnv('AGENT_DIR', { MU_AGENT_DIR: '/new', KYRN_AGENT_DIR: '/old' })).toBe('/new');
      expect(muEnv('AGENT_DIR', { KYRN_AGENT_DIR: '/old' })).toBe('/old');
    } finally {
      f.cleanup();
    }
  });
});

type Call = { method: string; path: string; body?: unknown };
const puts = (calls: Call[]) => calls.filter((call) => call.method === 'PUT');
const switches = (calls: Call[], id: string) =>
  calls.filter((call) => call.path === `/api/agents/${id}/enabled`).map((call) => call.body);

describe('mu-only backend catalog', () => {
  type Options = { fail?: (call: Call) => boolean; wholeRecords?: boolean };
  /** Answers the way the bundled AionCore v0.2.2 was seen to, checked against a real one. */
  function backend(records: Record<string, unknown>[], options: Options = {}) {
    const calls: Call[] = [];
    const request: BackendRequest = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      if (options.fail?.({ method, path, body })) throw new Error('probe failed');
      // The list leaves `env` out, whatever is stored.
      if (path === '/api/agents/management') return records.map(({ env: _env, ...row }) => row) as T;
      if (path === '/api/assistants')
        return [
          { id: 'ak', agent_id: 'k', enabled: true },
          { id: 'ao', agent_id: 'other', enabled: true },
        ] as T;
      if (method === 'POST' && path === '/api/agents/custom')
        return { id: 'new', enabled: true, ...(body as object) } as T;
      const enabled = /^\/api\/agents\/([^/]+)\/enabled$/.exec(path);
      if (method === 'PATCH' && enabled) {
        // Setting `enabled` answers with the whole record: the only place `env` can be read.
        if (options.wholeRecords === false) return { status: 'online' } as T;
        const record = records.find((row) => row.id === enabled[1]);
        return { ...record, ...(body as object), available: true } as T;
      }
      return { status: 'online' } as T;
    };
    return { calls, request };
  }

  it('disables other runtimes and assistants before exposing the sole product engine', async () => {
    const { calls, request } = backend([
      { id: 'k', name: 'mu', command: '/kyrn/acp', enabled: true, yolo_id: 'full' },
      { id: 'other', enabled: true },
    ]);
    expect((await initializeKyrn(request, '/kyrn/acp')).assistants).toHaveLength(1);
    expect(calls).toContainEqual({ method: 'PATCH', path: '/api/agents/other/enabled', body: { enabled: false } });
    expect(calls).toContainEqual({ method: 'PATCH', path: '/api/assistants/ao/state', body: { enabled: false } });
    // Already called mu, with full auto set: nothing to read, nothing to update, nothing to create.
    expect(calls.filter((call) => call.method === 'PUT' || call.path === '/api/agents/custom')).toEqual([]);
    expect(switches(calls, 'k')).toEqual([]);
  });
  it('renames the registration from before the rename in place, sending the whole record back', async () => {
    const { calls, request } = backend([
      {
        id: 'k',
        name: 'KYRN',
        command: '/kyrn/acp',
        enabled: true,
        icon: 'icon.svg',
        description: 'KYRN harness · local Codex login · Jev judgment',
        args: ['--flag'],
        // Not in the list the backend returns. An update built from the list would clear it.
        env: [{ name: 'A', value: 'b' }],
        native_skills_dirs: ['/skills'],
        behavior_policy: { supports_side_question: true },
        yolo_id: 'yolo',
      },
      { id: 'other', enabled: true },
    ]);

    const catalog = await initializeKyrn(request, '/kyrn/acp');

    // The old conversations hang on this id: the same agent, not a second one.
    expect(catalog.agentId).toBe('k');
    expect(calls.filter((call) => call.path === '/api/agents/custom')).toEqual([]);
    expect(puts(calls)).toEqual([
      {
        method: 'PUT',
        path: '/api/agents/custom/k',
        body: {
          name: 'mu',
          command: '/kyrn/acp',
          icon: 'icon.svg',
          args: ['--flag'],
          env: [{ name: 'A', value: 'b' }],
          advanced: {
            // AionUi's own word for full auto, which mu does not know, becomes mu's full access.
            yolo_id: 'full',
            native_skills_dirs: ['/skills'],
            behavior_policy: { supports_side_question: true },
            description: 'mu harness · local Codex login · Jev judgment',
          },
        },
      },
    ]);
    // The record is read by setting `enabled` to what it already is; the agent being kept is never switched off.
    expect(switches(calls, 'k')).toEqual([{ enabled: true }]);
  });
  it('reads a disabled registration as it is, and only then switches it on', async () => {
    const { calls, request } = backend([{ id: 'k', name: 'KYRN', command: '/kyrn/acp', enabled: false }]);
    await initializeKyrn(request, '/kyrn/acp');
    expect(switches(calls, 'k')).toEqual([{ enabled: false }, { enabled: true }]);
    expect(puts(calls)).toHaveLength(1);
  });
  it('keeps a description the user wrote', async () => {
    const { calls, request } = backend([
      { id: 'k', name: 'KYRN', command: '/kyrn/acp', enabled: true, description: 'my own words' },
    ]);
    await initializeKyrn(request, '/kyrn/acp');
    const put = puts(calls)[0]?.body as { advanced: { description: string } };
    expect(put.advanced.description).toBe('my own words');
  });
  it('knows its own description in any capitalization, and writes it as the judge is spelled now', async () => {
    const { calls, request } = backend([
      {
        id: 'k',
        name: 'KYRN',
        command: '/kyrn/acp',
        enabled: true,
        description: 'mu harness · local codex login · jev judgment',
      },
    ]);
    await initializeKyrn(request, '/kyrn/acp');
    const put = puts(calls)[0]?.body as { advanced: { description: string } };
    expect(put.advanced.description).toBe('mu harness · local Codex login · Jev judgment');
  });
  it('keeps the old name rather than update a record it could not read whole', async () => {
    const { calls, request } = backend(
      [{ id: 'k', name: 'KYRN', command: '/kyrn/acp', enabled: true, env: [{ name: 'A', value: 'b' }] }],
      { wholeRecords: false }
    );

    const catalog = await initializeKyrn(request, '/kyrn/acp');

    expect(catalog.agentId).toBe('k');
    expect(puts(calls)).toEqual([]);
    expect(calls.filter((call) => call.path === '/api/agents/custom')).toEqual([]);
  });
  it.each([
    ['the update', (call: Call) => call.method === 'PUT'],
    ['reading the record', (call: Call) => call.path === '/api/agents/k/enabled'],
  ])('starts under the old name when the backend refuses %s', async (_what, fail) => {
    const { calls, request } = backend(
      [
        { id: 'k', name: 'KYRN', command: '/kyrn/acp', enabled: true },
        { id: 'other', enabled: true },
      ],
      { fail }
    );

    const catalog = await initializeKyrn(request, '/kyrn/acp');

    expect(catalog.agentId).toBe('k');
    expect(calls.filter((call) => call.path === '/api/agents/custom')).toEqual([]);
    expect(calls).toContainEqual({ method: 'PATCH', path: '/api/agents/other/enabled', body: { enabled: false } });
  });
  it('registers once, as mu, when nothing is registered yet, with full access for runs nobody watches', async () => {
    const { calls, request } = backend([{ id: 'other', enabled: true }]);
    await initializeKyrn(request, '/kyrn/acp');
    const created = calls.filter((call) => call.path === '/api/agents/custom');
    expect(created).toHaveLength(1);
    expect(created[0].body).toMatchObject({ name: 'mu', command: '/kyrn/acp', advanced: { yolo_id: 'full' } });
  });
  it('gives a registration without a full-auto mode mu’s full access, and keeps one of mu’s modes someone chose', async () => {
    const { calls, request } = backend([
      { id: 'k', name: 'mu', command: '/kyrn/acp', enabled: true, env: [{ name: 'A', value: 'b' }] },
    ]);
    await initializeKyrn(request, '/kyrn/acp');
    // A scheduled task asks AionCore for full auto: without it, the run would wait on a question nobody answers.
    expect(puts(calls)).toEqual([
      {
        method: 'PUT',
        path: '/api/agents/custom/k',
        body: expect.objectContaining({
          name: 'mu',
          env: [{ name: 'A', value: 'b' }],
          advanced: expect.objectContaining({ yolo_id: 'full' }),
        }),
      },
    ]);
    const chosen = backend([{ id: 'k', name: 'mu', command: '/kyrn/acp', enabled: true, yolo_id: 'jev' }]);
    await initializeKyrn(chosen.request, '/kyrn/acp');
    expect(puts(chosen.calls)).toEqual([]);
  });
  it.each(['KYRN', 'mu'])('never replaces a different user command registered as %s', async (name) => {
    const { calls, request } = backend([{ id: 'k', name, command: '/other' }]);
    await expect(initializeKyrn(request, '/kyrn/acp')).rejects.toThrow('different mu command');
    expect(calls).toHaveLength(1);
  });
  // The check keeps what mu offers in the record the pickers read: the start makes one, a change to mu's models another.
  it('checks mu again, found by its command, and changes nothing else', async () => {
    const { calls, request } = backend([
      { id: 'other', name: 'Codex', command: '/codex', enabled: false },
      { id: 'k', name: 'mu', command: '/kyrn/acp', enabled: true, yolo_id: 'full' },
    ]);
    await recheckKyrn(request, '/kyrn/acp');
    expect(calls).toEqual([
      { method: 'GET', path: '/api/agents/management', body: undefined },
      { method: 'POST', path: '/api/agents/k/health-check', body: {} },
    ]);
  });
  it('has nothing to check before mu is registered', async () => {
    const { calls, request } = backend([{ id: 'other', name: 'Codex', command: '/codex', enabled: true }]);
    await recheckKyrn(request, '/kyrn/acp');
    expect(calls.map((call) => call.path)).toEqual(['/api/agents/management']);
  });

  // #4: an app installed in C:\Program Files\mu registers its launcher's 8.3 short path, which AionCore can start. A
  // registration an earlier start left may hold another spelling of the same launcher.
  describe('on Windows, where one launcher has several spellings', () => {
    const long = 'C:\\Program Files\\mu\\resources\\mu\\acp.cmd';
    const short = 'C:\\PROGRA~1\\mu\\resources\\mu\\acp.cmd';
    /** What the app works out on such a machine (windows/launcherCommand.ts): the short path, registered. */
    const installed = (): Promise<OwnCommand> =>
      ownLauncher(long, {
        platform: 'win32',
        env: { ProgramData: 'C:\\ProgramData' },
        shortPath: async () => short,
        realPath: (file) =>
          [long, short].some((spelling) => spelling.toLowerCase() === file.toLowerCase()) ? long : undefined,
        write: () => false,
      });

    it('finds the registration by the exact command first', async () => {
      const own = await installed();
      const rows = [
        { id: 'old', name: 'KYRN', command: long, enabled: false },
        { id: 'k', name: 'mu', command: short, enabled: true },
      ];
      expect(own.command).toBe(short);
      expect(findRegistration(rows, own)?.id).toBe('k');
    });
    it.each([
      ['its short path in another case', short.toLowerCase()],
      ['its long path', long],
      ['its long path in another case', long.toUpperCase()],
      ['a forwarder written for it', 'C:\\ProgramData\\mu-desktop\\acp.cmd'],
    ])(
      'takes a registration under mu’s name that runs %s as its own, and registers the short path in it',
      async (_how, registered) => {
        const { calls, request } = backend([
          {
            id: 'k',
            name: 'mu',
            command: registered,
            enabled: true,
            yolo_id: 'full',
            env: [{ name: 'A', value: 'b' }],
          },
          { id: 'other', enabled: true },
        ]);

        const catalog = await initializeKyrn(request, await installed());

        expect(catalog.agentId).toBe('k');
        expect(calls.filter((call) => call.path === '/api/agents/custom')).toEqual([]);
        // The update replaces the whole record: the variables go back with the new command.
        expect(puts(calls)).toEqual([
          {
            method: 'PUT',
            path: '/api/agents/custom/k',
            body: expect.objectContaining({ name: 'mu', command: short, env: [{ name: 'A', value: 'b' }] }),
          },
        ]);
      }
    );
    it.each(['mu', 'KYRN'])('still refuses a registration named %s that runs another launcher', async (name) => {
      const { calls, request } = backend([{ id: 'k', name, command: 'C:\\mu\\resources\\mu\\acp.cmd' }]);
      await expect(initializeKyrn(request, await installed())).rejects.toMatchObject({ code: 'otherRegistration' });
      expect(calls).toHaveLength(1);
    });
    it('checks the registration again while it still holds the long path', async () => {
      const { calls, request } = backend([{ id: 'k', name: 'mu', command: long, enabled: true, yolo_id: 'full' }]);
      await recheckKyrn(request, await installed());
      expect(calls.map((call) => call.path)).toEqual(['/api/agents/management', '/api/agents/k/health-check']);
    });
  });
});
