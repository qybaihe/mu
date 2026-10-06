import { describe, expect, it } from 'vitest';
import {
  defaultFeatureState,
  parseManifest,
  type OptionInfo,
} from '../../../../packages/desktop/src/common/kyrn/manifest';
import type { KyrnSettings } from '../../../../packages/desktop/src/common/kyrn/types';
import { DETAIL_AREAS } from '../../../../packages/desktop/src/renderer/pages/settings/settingsNav';
import {
  PAGE_ROWS,
  areaOf,
  areaRows,
  dirtySections,
  isStale,
  matches,
  newDraft,
  optionParts,
  rowCount,
  setCompaction,
  strayAreaOf,
  toSave,
} from '../../../../packages/desktop/src/renderer/pages/settings/KyrnSettings/draft';
import {
  blankProvider,
  freeProviderId,
  providerProblems,
} from '../../../../packages/desktop/src/renderer/pages/settings/KyrnSettings/providers/endpoints';
import manifestJson from './manifest.fixture.json';

const harness = parseManifest(manifestJson);
if (harness.status !== 'ok') throw new Error('fixture manifest is not readable');

const base: KyrnSettings = {
  revision: 'r1',
  tiers: ['jev'],
  judges: { jev: { type: 'jev', model: '', baseUrl: '', apiKeyEnv: 'TYPESAFE_API_KEY', timeoutMs: 10000 } },
  mode: 'shadow',
  betaCompression: false,
  autoCompaction: true,
  maxContextTokens: 0,
  keys: { TYPESAFE_API_KEY: false },
  harness,
  decisionModes: {},
  features: Object.fromEntries(
    harness.manifest.features.map((feature) => [feature.name, defaultFeatureState(feature)])
  ),
  models: {
    providers: [
      {
        ...blankProvider('relay'),
        isNew: undefined,
        baseUrl: 'https://relay.example.com/v1',
        key: 'managed',
        keySet: true,
      },
    ],
    foreign: [],
    defaults: { provider: '', model: '', thinkingLevel: '' },
    commented: false,
    problem: '',
  },
  permissions: { mode: 'jev', from: 'default' },
  boardModel: { supported: true, model: '' },
};

const entry = (id: string) => ({ id, name: '', api: '', baseUrl: '', modelCount: 0 });

describe('the draft of the settings area', () => {
  it('is clean when nothing was edited, whatever is read-only about a provider', () => {
    const draft = newDraft(structuredClone(base));
    draft.settings.models.providers[0].keySet = false;
    draft.settings.models.providers[0].headerNames = ['x'];
    expect([...dirtySections(base, draft)]).toEqual([]);
  });
  it('names each page that was edited, and a typed key counts', () => {
    const edited = structuredClone(base);
    edited.decisionModes = { 'tool.risk': 'off' };
    edited.features.guard.enabled = false;
    edited.maxContextTokens = 64000;
    expect(new Set(dirtySections(base, newDraft(edited)))).toEqual(new Set(['decisions', 'features', 'context']));
    // A core switch is one of the features as well: the features part, wherever it was moved.
    const core = structuredClone(base);
    core.features.swarm.enabled = !core.features.swarm.enabled;
    expect([...dirtySections(base, newDraft(core))]).toEqual(['features']);
    expect([...dirtySections(base, { ...newDraft(base), judgeKeys: { TYPESAFE_API_KEY: 'k' } })]).toEqual(['judges']);
    expect([...dirtySections(base, { ...newDraft(base), providerKeys: { relay: 'k' } })]).toEqual(['providers']);
    expect([...dirtySections(base, { ...newDraft(base), providerKeys: { relay: '' } })]).toEqual([]);
  });
  it('counts the startup model and the board’s model as two pages', () => {
    const startup = structuredClone(base);
    startup.models.defaults = { provider: 'relay', model: 'x', thinkingLevel: 'high' };
    expect([...dirtySections(base, newDraft(startup))]).toEqual(['defaultModel']);
    const board = { ...base, boardModel: { ...base.boardModel, model: 'relay/x' } };
    expect([...dirtySections(base, newDraft(board))]).toEqual(['boardModel']);
    expect(toSave(newDraft(startup)).models?.defaults).toEqual({
      provider: 'relay',
      model: 'x',
      thinkingLevel: 'high',
    });
  });
  it('sends keys as credentials under the variable of their provider, and nothing read-only', () => {
    const sent = toSave({
      settings: base,
      judgeKeys: { TYPESAFE_API_KEY: 'judge' },
      providerKeys: { relay: 'sk', gone: 'x' },
    });
    expect(sent.credentials).toEqual([
      { name: 'TYPESAFE_API_KEY', value: 'judge' },
      { name: 'MU_PROVIDER_RELAY_API_KEY', value: 'sk' },
    ]);
    expect(Object.keys(sent)).not.toEqual(expect.arrayContaining(['keys', 'harness']));
    expect(Object.keys(sent.models ?? {})).toEqual(['providers', 'defaults']);
    const old = toSave(newDraft({ ...base, harness: { status: 'missing' }, features: {} }));
    expect(old).not.toHaveProperty('features');
  });
  it('counts a removed hand-written entry as a change, and names it for the store only against the base', () => {
    const read = { ...base, models: { ...base.models, foreign: [entry('lab'), entry('anthropic')] } };
    const draft = newDraft({ ...read, models: { ...read.models, foreign: [entry('anthropic')] } });
    expect([...dirtySections(read, draft)]).toEqual(['providers']);
    expect(toSave(draft, read).models?.removeEntries).toEqual(['lab']);
    expect(toSave(newDraft(read), read).models).not.toHaveProperty('removeEntries');
    // Without the base nothing is known to be removed, so nothing is.
    expect(toSave(draft).models).not.toHaveProperty('removeEntries');
  });
  it('keeps the beta switch and the compaction feature as one, a feature on the context page', () => {
    const on = setCompaction(base, true);
    expect([on.betaCompression, on.features.compaction.enabled]).toEqual([true, true]);
    expect(setCompaction({ ...base, features: {} }, true).betaCompression).toBe(true);
    expect([...dirtySections(base, newDraft(on))]).toEqual(['features']);
  });
  it('names the one judges page for the choice, the order, a profile’s field and any judge’s key', () => {
    const laya = { type: 'local' as const, model: '', baseUrl: '', apiKeyEnv: '', timeoutMs: 3000 };
    const one = { ...base, judges: { ...base.judges, laya } };
    const two = { ...one, tiers: ['jev', 'laya'] };
    // Laya picked: the one judge now.
    expect([...dirtySections(two, newDraft({ ...two, tiers: ['laya'] }))]).toEqual(['judges']);
    // The order turned round, and a second judge added.
    expect([...dirtySections(two, newDraft({ ...two, tiers: ['laya', 'jev'] }))]).toEqual(['judges']);
    expect([...dirtySections(one, newDraft(two))]).toEqual(['judges']);
    // A profile's field.
    const slower = structuredClone(one);
    slower.judges.jev.timeoutMs = 9000;
    expect([...dirtySections(one, newDraft(slower))]).toEqual(['judges']);
    // A key, of the judge chosen or of one further down the order.
    expect([...dirtySections(base, { ...newDraft(base), judgeKeys: { MU_JUDGE_OWN: 'k' } })]).toEqual(['judges']);
    const layaFirst = { ...one, tiers: ['laya', 'jev'] };
    expect([...dirtySections(layaFirst, { ...newDraft(layaFirst), judgeKeys: { TYPESAFE_API_KEY: 'k' } })]).toEqual([
      'judges',
    ]);
  });
  it('never writes the mode a new conversation starts in: that is the permission feature’s option now', () => {
    const picked = { ...base, permissions: { mode: 'full', from: 'picked' as const } };
    expect(toSave(newDraft(picked))).not.toHaveProperty('permissions');
    expect([...dirtySections(base, newDraft(picked))]).toEqual([]);
  });
  it('searches every word, in any of the texts, ignoring case', () => {
    expect(matches('', 'anything')).toBe(true);
    expect(matches('HIVE deliver', 'hive.deliver', '蜂群：投递')).toBe(true);
    expect(matches('蜂群 risk', 'hive.deliver', '蜂群：投递')).toBe(false);
    // A stale revision is recognised by the store's code, not by its English words.
    expect(isStale({ code: 'stale' })).toBe(true);
    expect(isStale({ code: 'unknown' })).toBe(false);
  });
});

describe('provider form rules', () => {
  it('explains an id, an address and model ids the store would refuse', () => {
    const provider = { ...blankProvider('Bad Id'), baseUrl: 'http://example.com/v1', models: [] };
    expect(providerProblems(provider, true, new Set())).toEqual({ id: 'format', baseUrl: 'unsafe' });
    expect(providerProblems({ ...provider, id: 'openai' }, true, new Set()).id).toBe('reserved');
    expect(providerProblems({ ...provider, id: 'mine' }, true, new Set(['mine'])).id).toBe('taken');
    // A saved provider keeps whatever id it has.
    expect(providerProblems({ ...provider, baseUrl: '' }, false, new Set())).toEqual({ baseUrl: 'empty' });
    const model = {
      id: 'a',
      name: '',
      reasoning: false,
      imageInput: false,
      contextWindow: 1,
      maxTokens: 1,
      thinkingLevelMap: {},
      thinkingLevels: [],
    };
    const ok = { ...provider, id: 'mine', baseUrl: 'http://localhost:1234/v1' };
    expect(providerProblems({ ...ok, baseUrl: 'http://192.168.31.124:8000/v1', models: [] }, false, new Set())).toEqual(
      {}
    );
    expect(providerProblems({ ...ok, models: [model, model] }, true, new Set()).models).toBe('duplicate');
    expect(providerProblems({ ...ok, models: [{ ...model, id: ' ' }] }, true, new Set()).models).toBe('emptyId');
    expect(providerProblems({ ...ok, models: [model] }, true, new Set())).toEqual({});
  });
  it('finds a free id', () => {
    expect(freeProviderId(new Set())).toBe('custom');
    expect(freeProviderId(new Set(['custom', 'custom-2']))).toBe('custom-3');
  });
});

describe('which page of the details a setting is on', () => {
  const { manifest } = harness;

  it('puts a feature on the area of the first point it asks, or on the area it has of its own', () => {
    const area = (name: string) => areaOf(manifest, { name });
    expect(area('preflight')).toBe('input');
    expect(area('compaction')).toBe('context');
    expect(area('swarm')).toBe('team');
    // The lessons have a page of their own; the guard and the constraints are safety, apart from the tools.
    expect(area('memory')).toBe('memory');
    expect(area('guard')).toBe('safety');
    expect(area('constraints')).toBe('safety');
    expect(area('locate')).toBe('tools');
    // The capability catalog asks in the context group, and decides which tools are shown: the tools.
    expect(area('catalog')).toBe('tools');
    // One that asks at no point, or one the harness does not have, is under Other.
    expect(area('background')).toBe('other');
    expect(area('no-such-feature')).toBe('other');
    expect(areaOf(undefined, { name: 'preflight' })).toBe('other');
    // A point whose feature the harness does not describe goes by its group, and a group without a page is Other.
    expect(strayAreaOf({ group: 'tools', feature: 'gone' })).toBe('tools');
    expect(strayAreaOf({ group: 'misc', feature: 'gone' })).toBe('other');
    expect(strayAreaOf({ group: 'context', feature: 'memory' })).toBe('memory');
  });

  it('nests each point under its feature, lists a point without one alone, and leaves the terminal’s features out', () => {
    const team = areaRows(manifest, 'team');
    expect(team.map((row) => [row.feature?.name, row.decisions.map((decision) => decision.id)])).toEqual([
      ['swarm', ['swarm.routing']],
      ['hive', ['hive.publish', 'hive.deliver']],
    ]);
    expect(rowCount(team)).toBe(5);
    const other = areaRows(manifest, 'other').map((row) => row.feature?.name);
    expect(other).toContain('background');
    expect(other).not.toContain('welcome');
    const stray = parseManifest({
      ...manifestJson,
      decisions: [...manifestJson.decisions, { ...manifestJson.decisions[0], id: 'gone.point', feature: 'gone' }],
    });
    if (stray.status !== 'ok') throw new Error('unreadable');
    const input = areaRows(stray.manifest, 'input');
    expect(input.at(-1)).toEqual({ decisions: [expect.objectContaining({ id: 'gone.point' })] });
    expect(areaRows(undefined, 'input')).toEqual([]);
  });

  it('puts every point and every feature of the fixture harness on one page, each page within twelve rows', () => {
    const all = DETAIL_AREAS.map((area) => areaRows(manifest, area));
    for (const [index, rows] of all.entries())
      expect(rowCount(rows), DETAIL_AREAS[index]).toBeLessThanOrEqual(PAGE_ROWS);
    const decisions = all.flat().flatMap((row) => row.decisions.map((decision) => decision.id));
    expect(decisions.toSorted()).toEqual(manifest.decisions.map((decision) => decision.id).toSorted());
    const features = all.flat().flatMap((row) => (row.feature ? [row.feature.name] : []));
    expect(features.toSorted()).toEqual(
      manifest.features
        .filter((feature) => feature.name !== 'welcome')
        .map((feature) => feature.name)
        .toSorted()
    );
    for (const feature of manifest.features) expect(optionParts(feature.options).length, feature.name).toBe(1);
  });
});

/** An option as far as the pages of options care: its key, and whether it is a switch. */
const option = (key: string, kind: OptionInfo['kind']) => ({ key, kind });
const keys = (parts: { key: string }[][]) => parts.map((part) => part.map((each) => each.key));

describe('the pages of a feature’s options', () => {
  it('keeps a switch on the page of the settings after it, and fills each page up to twelve', () => {
    // The capability packs: six switches, eighteen options, each switch followed by its own settings.
    const packs = [
      option('astGrep', 'boolean'),
      option('maxResults', 'number'),
      option('maxDiffChars', 'number'),
      option('astGrepCommand', 'text'),
      option('github', 'boolean'),
      option('ghCommand', 'text'),
      option('commit', 'boolean'),
      option('maxPlanChars', 'number'),
      option('review', 'boolean'),
      option('conflicts', 'boolean'),
      option('maxSideLines', 'number'),
      option('maxConflictChars', 'number'),
      option('maxFindings', 'number'),
      option('debugger', 'boolean'),
      option('maxFrames', 'number'),
      option('maxVariables', 'number'),
      option('debugOutputChars', 'number'),
      option('debugWaitMs', 'number'),
    ];
    const parts = optionParts(packs);
    expect(keys(parts)).toEqual([
      [
        'astGrep',
        'maxResults',
        'maxDiffChars',
        'astGrepCommand',
        'github',
        'ghCommand',
        'commit',
        'maxPlanChars',
        'review',
      ],
      [
        'conflicts',
        'maxSideLines',
        'maxConflictChars',
        'maxFindings',
        'debugger',
        'maxFrames',
        'maxVariables',
        'debugOutputChars',
        'debugWaitMs',
      ],
    ]);
    expect(parts.flat()).toEqual(packs);
  });

  it('leaves twelve options on one page, cuts a longer run without switches where the page is full', () => {
    const twelve = Array.from({ length: PAGE_ROWS }, (_, index) => option(`n${index}`, 'number'));
    expect(optionParts(twelve)).toHaveLength(1);
    const fourteen = Array.from({ length: 14 }, (_, index) => option(`n${index}`, 'number'));
    expect(optionParts(fourteen).map((part) => part.length)).toEqual([12, 2]);
    expect(optionParts([])).toEqual([[]]);
  });
});
