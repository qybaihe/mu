import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../../../../packages/desktop/src/process/agent/kyrn/settings';
import { featureEntry } from '../../../../packages/desktop/src/process/agent/kyrn/config/features';
import {
  checkOption,
  localized,
  parseManifest,
  type FeatureInfo,
  type OptionInfo,
} from '../../../../packages/desktop/src/common/kyrn/manifest';
import manifest from './manifest.fixture.json';

type Json = Record<string, unknown>;

/** A harness root with (or without) a manifest, and an agent directory with the given mu.json. */
function fixture(config: Json | undefined, harness: unknown = manifest) {
  // `null`: a harness from before the manifest, which has no such file.
  const root = mkdtempSync(join(tmpdir(), 'mu-features-'));
  const dir = join(root, 'agent');
  mkdirSync(dir);
  if (config) writeFileSync(join(dir, 'mu.json'), JSON.stringify(config, null, '\t'));
  if (harness !== null) {
    mkdirSync(join(root, 'packages', 'kyrn-judge'), { recursive: true });
    writeFileSync(join(root, 'packages', 'kyrn-judge', 'manifest.json'), JSON.stringify(harness));
  }
  const file = () => JSON.parse(readFileSync(join(dir, 'mu.json'), 'utf8')) as Json;
  return {
    dir,
    store: new SettingsStore(dir, root),
    file,
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

const parsed = parseManifest(manifest);
if (parsed.status !== 'ok') throw new Error('fixture manifest is not readable');
const feature = (name: string): FeatureInfo => parsed.manifest.features.find((item) => item.name === name)!;
const option = (name: string, key: string): OptionInfo => feature(name).options.find((item) => item.key === key)!;

describe('the harness manifest', () => {
  it('is read whole, whatever it lists: nothing here knows the decisions or features by name', () => {
    expect(parsed.manifest.decisions).toHaveLength(manifest.decisions.length);
    expect(parsed.manifest.features.map((item) => item.name)).toEqual(manifest.features.map((item) => item.name));
    for (const decision of parsed.manifest.decisions) expect(parsed.manifest.groups[decision.group]).toBeDefined();
  });
  it('reports a missing manifest, a broken one and an unknown version, and then offers the basic settings only', () => {
    for (const [harness, status] of [
      [null, 'missing'],
      ['not an object', 'missing'],
      [{ ...manifest, version: 2 }, 'unsupported'],
    ] as const) {
      using(fixture({ modes: { 'tool.risk': 'active' }, features: { hive: false } }, harness), (f) => {
        const read = f.store.read();
        expect(read.harness.status).toBe(status);
        expect(read.decisionModes).toEqual({});
        expect(read.features).toEqual({});
        // The basic settings still save, and what the manifest would have described is left alone.
        f.store.save({ ...read, mode: 'shadow' });
        expect(f.file()).toEqual({ modes: { 'tool.risk': 'active', default: 'shadow' }, features: { hive: false } });
        expect(() => f.store.save({ ...f.store.read(), features: { hive: { enabled: true, options: {} } } })).toThrow(
          'does not describe'
        );
      });
    }
    expect(parseManifest({ ...manifest, version: 2 })).toEqual({ status: 'unsupported', version: '2' });
  });
  it('leaves out an option of a kind it does not know instead of failing', () => {
    const odd = {
      ...manifest.features[0],
      options: [{ key: 'curve', kind: 'spline', default: 1, label: { zh: '曲', en: 'c' } }],
    };
    const state = parseManifest({ ...manifest, features: [odd] });
    expect(state.status === 'ok' && state.manifest.features[0].options).toEqual([]);
  });
  it('speaks Chinese to every Chinese locale and English to all others, when that is all the harness has', () => {
    const text = { zh: '生效', en: 'Active' };
    expect(['zh-CN', 'zh-TW', 'zh'].map((language) => localized(text, language))).toEqual(['生效', '生效', '生效']);
    expect(['en-US', 'ja-JP', 'fa-IR', ''].map((language) => localized(text, language))).toEqual(
      Array(4).fill('Active')
    );
  });
  it('prefers the exact locale, then its base language, then English', () => {
    const text = { zh: '生效', en: 'Active', 'zh-TW': '生效中', ja: '有効', 'pt-BR': 'Ativo' };
    expect(
      ['zh-TW', 'zh-tw', 'zh-CN', 'ja-JP', 'pt-BR', 'pt-PT', 'de-DE'].map((language) => localized(text, language))
    ).toEqual(['生效中', '生效中', '生效', '有効', 'Ativo', 'Active', 'Active']);
  });
  it('keeps the other languages a harness writes, and nothing that is not a text in a language', () => {
    const decision = manifest.decisions[0];
    const title = { ...decision.title, 'zh-TW': '訊息預判', ja: 'メッセージ事前判定', note: 7, 'Bad Tag': 'x', ko: '' };
    const state = parseManifest({ ...manifest, decisions: [{ ...decision, title }] });
    expect(state.status === 'ok' && state.manifest.decisions[0].title).toEqual({
      zh: decision.title.zh,
      en: decision.title.en,
      'zh-TW': '訊息預判',
      ja: 'メッセージ事前判定',
    });
  });
});

describe('per-decision modes', () => {
  it('sets an override, removes it for "follow the default", and keeps modes the manifest does not list', () => {
    using(fixture({ modes: { default: 'shadow', 'future.decision': 'off', 'tool.risk': 'active' } }), (f) => {
      const read = f.store.read();
      expect(read.decisionModes).toEqual({ 'tool.risk': 'active' });
      f.store.save({ ...read, decisionModes: { 'hive.deliver': 'off' } });
      expect(f.file().modes).toEqual({ default: 'shadow', 'future.decision': 'off', 'hive.deliver': 'off' });
      expect(f.store.read().decisionModes).toEqual({ 'hive.deliver': 'off' });
    });
  });
  it('rejects a decision the manifest does not list and a mode that does not exist, before writing', () => {
    using(fixture({ tiers: ['jev'] }), (f) => {
      const read = f.store.read();
      expect(() => f.store.save({ ...read, decisionModes: { 'made.up': 'off' } })).toThrow('Unknown decision');
      expect(() => f.store.save({ ...read, decisionModes: { 'tool.risk': 'loud' as 'off' } })).toThrow('Invalid mode');
      expect(f.file()).toEqual({ tiers: ['jev'] });
    });
  });
  it('does not touch the overrides when the save leaves them out', () => {
    using(fixture({ modes: { 'tool.risk': 'active' } }), (f) => {
      const { decisionModes: _modes, ...rest } = f.store.read();
      f.store.save({ ...rest, mode: 'off' });
      expect(f.file().modes).toEqual({ 'tool.risk': 'active', default: 'off' });
    });
  });
});

describe('feature options', () => {
  it('validates each kind: type, range, choice and length', () => {
    expect(checkOption(option('preflight', 'thinking'), 'yes')).toBe('type');
    expect(checkOption(option('preflight', 'waitMs'), 499)).toBe('range');
    expect(checkOption(option('preflight', 'waitMs'), 30001)).toBe('range');
    expect(checkOption(option('preflight', 'waitMs'), Number.NaN)).toBe('type');
    expect(checkOption(option('preflight', 'waitMs'), 500)).toBeUndefined();
    expect(checkOption(option('memory', 'path'), 7)).toBe('type');
    expect(checkOption(option('memory', 'path'), 'x'.repeat(1001))).toBe('length');
    expect(checkOption(option('admission', 'testLog'), 'loud')).toBe('choice');
    expect(checkOption(option('admission', 'testLog'), 'rules')).toBeUndefined();
    expect(checkOption(option('admission', 'passThrough'), ['read', 3])).toBe('type');
    expect(checkOption(option('admission', 'passThrough'), ['read', ' '])).toBe('length');
    expect(checkOption(option('forgetting', 'thresholds'), [50, '70'])).toBe('type');
    expect(checkOption(option('forgetting', 'thresholds'), [40, 60])).toBeUndefined();
  });
  it('rejects an invalid value or an unknown feature before writing anything', () => {
    using(fixture({ features: { hive: { maxBees: 4 } } }), (f) => {
      const read = f.store.read();
      const preflight = read.features.preflight;
      for (const [options, message] of [
        [{ waitMs: 100 }, 'preflight.waitMs (range)'],
        [{ show: 'no' }, 'preflight.show (type)'],
      ] as const) {
        const features = {
          ...read.features,
          preflight: { ...preflight, options: { ...preflight.options, ...options } },
        };
        expect(() => f.store.save({ ...read, features })).toThrow(message);
      }
      expect(() => f.store.save({ ...read, features: { nonsense: { enabled: true, options: {} } } })).toThrow(
        'Unknown feature'
      );
      expect(f.file()).toEqual({ features: { hive: { maxBees: 4 } } });
    });
  });
  it('writes only what differs from the default, and removes the entry when nothing does', () => {
    using(fixture(undefined), (f) => {
      const read = f.store.read();
      const admission = read.features.admission;
      const changed = {
        ...read.features,
        admission: { ...admission, options: { ...admission.options, testLog: 'rules', passThrough: ['read'] } },
      };
      const saved = f.store.save({ ...read, features: changed });
      // The other nineteen features, and the four other admission options, are not in the file.
      expect(f.file()).toEqual({ features: { admission: { passThrough: ['read'], testLog: 'rules' } } });
      expect(saved.features.admission.options.minChars).toBe(option('admission', 'minChars').default);

      f.store.save({ ...saved, features: { ...saved.features, admission } });
      expect(f.file()).toEqual({ features: {} });
    });
  });
  it('writes false for a feature that is off, and keeps options and unknown keys when there are any', () => {
    using(fixture({ features: { hive: { maxBees: 4, lastCall: false }, swarm: { enabled: true } } }), (f) => {
      const read = f.store.read();
      expect(read.features.hive).toMatchObject({ enabled: true, options: { lastCall: false } });
      const off = (name: string) => ({ ...read.features[name], enabled: false });
      f.store.save({
        ...read,
        features: { ...read.features, hive: off('hive'), swarm: off('swarm'), guard: off('guard') },
      });
      expect(f.file().features).toEqual({
        // `maxBees` is not in the manifest: it is somebody's, and stays. `lastCall` differs from the default.
        hive: { maxBees: 4, lastCall: false, enabled: false },
        swarm: false,
        guard: false,
      });
      const again = f.store.read();
      expect([again.features.hive.enabled, again.features.swarm.enabled, again.features.guard.enabled]).toEqual([
        false,
        false,
        false,
      ]);
      // Back on: a feature that is on by default needs no entry at all.
      f.store.save({ ...again, features: { ...again.features, guard: { ...again.features.guard, enabled: true } } });
      expect(f.file().features).not.toHaveProperty('guard');
    });
  });
  it('reads every spelling the harness accepts and leaves an untouched one exactly as written', () => {
    const features = {
      compaction: true,
      hive: false,
      monitor: { enabled: true, every: 6 },
      browser: { headless: 'yes' },
    };
    using(fixture({ features }), (f) => {
      const read = f.store.read();
      expect(read.features.compaction.enabled).toBe(true);
      expect(read.features.hive.enabled).toBe(false);
      expect(read.betaCompression).toBe(true);
      // A value of the wrong type is shown as the default.
      expect(read.features.browser.options.headless).toBe(true);
      const locate = read.features.locate;
      f.store.save({
        ...read,
        features: { ...read.features, locate: { ...locate, options: { ...locate.options, results: 20 } } },
      });
      // `monitor` says things the defaults say too, and `compaction` is spelled `true`: neither was touched.
      expect(f.file().features).toEqual({ ...features, locate: { results: 20 } });
    });
  });
  it('shows an out-of-range value from the file as it is, and only complains when that feature is saved', () => {
    using(fixture({ features: { preflight: { waitMs: 5 } } }), (f) => {
      const read = f.store.read();
      expect(read.features.preflight.options.waitMs).toBe(5);
      expect(() => f.store.save({ ...read, mode: 'active' })).not.toThrow();
      const next = f.store.read();
      const preflight = { ...next.features.preflight, options: { ...next.features.preflight.options, hints: false } };
      expect(() => f.store.save({ ...next, features: { ...next.features, preflight } })).toThrow('waitMs (range)');
    });
  });
  it('keeps the old beta switch and features.compaction in step', () => {
    using(fixture({ features: { compaction: { keepThreshold: 0.4 } } }), (f) => {
      const on = f.store.save({ ...f.store.read(), betaCompression: true });
      expect(f.file().features).toEqual({ compaction: { keepThreshold: 0.4, enabled: true } });
      expect(on.features.compaction.enabled).toBe(true);
      const compaction = { ...on.features.compaction, enabled: false };
      const off = f.store.save({ ...on, features: { ...on.features, compaction } });
      expect(off.betaCompression).toBe(false);
      expect(f.file().features).toEqual({ compaction: { keepThreshold: 0.4 } });
    });
  });
  it('builds the smallest entry that says the state', () => {
    const hive = feature('hive');
    const state = {
      enabled: true,
      options: { maxNotesPerBee: 12, maxDeliveriesPerBee: 10, checkpointEvery: 4, lastCall: true },
    };
    expect(featureEntry(hive, { lastCall: false }, state)).toBeUndefined();
    expect(featureEntry(hive, undefined, { ...state, enabled: false })).toBe(false);
    expect(featureEntry(hive, { note: 'mine' }, { ...state, enabled: false })).toEqual({
      note: 'mine',
      enabled: false,
    });
    expect(featureEntry(feature('compaction'), true, { ...state, enabled: true, options: {} })).toEqual({
      enabled: true,
    });
  });
});

describe('what a save leaves alone', () => {
  it('never drops routes, writer, recordState, judge profiles or keys it does not know', () => {
    const config = {
      tiers: ['laya', 'jev'],
      routes: { 'browser.step': ['luna'] },
      writer: 'openai/gpt-5.6-luna',
      recordState: true,
      judges: {
        laya: { type: 'local', profile: { capabilities: { relate: false } } },
        luna: { type: 'llm', model: 'a/b' },
      },
      somethingNew: { nested: [1, 2, 3] },
      features: { hive: { maxBees: 4 } },
    };
    using(fixture(config), (f) => {
      const read = f.store.read();
      const swarm = { ...read.features.swarm, options: { ...read.features.swarm.options, concurrency: 5 } };
      f.store.save({
        ...read,
        mode: 'shadow',
        decisionModes: { 'tool.risk': 'active' },
        features: { ...read.features, swarm },
      });
      expect(f.file()).toEqual({
        ...config,
        modes: { default: 'shadow', 'tool.risk': 'active' },
        features: { hive: { maxBees: 4 }, swarm: { concurrency: 5 } },
      });
    });
  });
  it('does not rewrite a file it has nothing to change in, nor freeze the built-in judges into it', () => {
    using(fixture({ tiers: ['jev'] }), (f) => {
      const before = readFileSync(join(f.dir, 'mu.json'), 'utf8');
      f.store.save(f.store.read());
      expect(readFileSync(join(f.dir, 'mu.json'), 'utf8')).toBe(before);
      f.store.save({ ...f.store.read(), mode: 'shadow' });
      // Tabs, as the file had them, and no `judges` block full of defaults.
      expect(readFileSync(join(f.dir, 'mu.json'), 'utf8')).toBe(
        '{\n\t"tiers": [\n\t\t"jev"\n\t],\n\t"modes": {\n\t\t"default": "shadow"\n\t}\n}\n'
      );
    });
  });
});
