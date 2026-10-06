import {
  ENDPOINT_TYPES,
  PROVIDER_ID,
  RESERVED_PROVIDER_IDS,
  THINKING_LEVELS,
  canonicalThinkingLevelMap,
  isSafeEndpoint,
  providerKeyVariable,
  readThinkingLevelMap,
  supportedThinkingLevels,
  type EndpointType,
  type ForeignProvider,
  type ModelDefaults,
  type ModelsSettings,
  type ProviderModel,
  type ProviderSettings,
  type ThinkingLevel,
  type ThinkingLevelMap,
} from '../../../../common/kyrn/models';
import { KyrnError } from '../../../../common/kyrn/errors';
import type { Credential } from '../../../../common/kyrn/types';
import { array, asRecord, text, type JsonRecord } from '../piRpc';
import { hasVariable, stripJsonComments, variableValue } from './files';

/** pi's defaults for a model that does not say (docs/models.md). Not written unless they were there or are changed. */
const CONTEXT_WINDOW = 128000;
const MAX_TOKENS = 16384;
/** No control characters: these strings end up in a file people read and in HTTP requests. */
const printable = (value: string): boolean =>
  ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
/** A value the screen never sends; the message says which, for the detail line. */
const invalid = (message: string): KyrnError => new KyrnError('invalid', message);

/** HTTPS, or plain HTTP to this machine or a private-network address; nothing that smuggles a credential or a second destination. */
export function assertEndpoint(value: string): void {
  if (!isSafeEndpoint(value))
    throw new KyrnError(
      'endpoint',
      'Use HTTPS, or HTTP to loopback or a private-network address, without embedded credentials'
    );
}

export type ModelsDocument = { doc: JsonRecord; commented: boolean; problem: string };

/** models.json as pi reads it: plain JSON, or JSON with `//` comments and trailing commas. */
export function parseModels(raw: string): ModelsDocument {
  const clean = raw.replace(/^\uFEFF/, '');
  if (!clean.trim()) return { doc: {}, commented: false, problem: '' };
  try {
    return { doc: asRecord(JSON.parse(clean)), commented: false, problem: '' };
  } catch {
    try {
      return { doc: asRecord(JSON.parse(stripJsonComments(clean))), commented: true, problem: '' };
    } catch (error) {
      return {
        doc: {},
        commented: false,
        problem: error instanceof Error ? error.message : 'models.json is not valid JSON',
      };
    }
  }
}

const isEndpoint = (value: unknown): value is EndpointType => ENDPOINT_TYPES.includes(value as EndpointType);

/** An entry this screen can edit whole: a provider of its own, with a base URL, one of the four wire formats and models. */
function editable(entry: JsonRecord): boolean {
  return (
    typeof entry.baseUrl === 'string' &&
    isEndpoint(entry.api) &&
    Array.isArray(entry.models) &&
    entry.oauth === undefined &&
    entry.models.every((model) => typeof asRecord(model).id === 'string' && asRecord(model).id !== '')
  );
}

function readModel(entry: JsonRecord): ProviderModel {
  const reasoning = entry.reasoning === true;
  const thinkingLevelMap = readThinkingLevelMap(entry.thinkingLevelMap);
  return {
    id: text(entry.id),
    name: text(entry.name),
    reasoning,
    imageInput: array(entry.input).includes('image'),
    contextWindow: typeof entry.contextWindow === 'number' ? entry.contextWindow : CONTEXT_WINDOW,
    maxTokens: typeof entry.maxTokens === 'number' ? entry.maxTokens : MAX_TOKENS,
    thinkingLevelMap,
    thinkingLevels: supportedThinkingLevels(reasoning, thinkingLevelMap),
  };
}

function readProvider(id: string, entry: JsonRecord, envText: string): ProviderSettings {
  const variable = providerKeyVariable(id);
  const apiKey = text(entry.apiKey);
  const key = !apiKey ? 'none' : apiKey === `$${variable}` || apiKey === `\${${variable}}` ? 'managed' : 'manual';
  return {
    id,
    name: text(entry.name),
    api: entry.api as EndpointType,
    baseUrl: text(entry.baseUrl),
    authHeader: entry.authHeader === true,
    models: array(entry.models).map(asRecord).map(readModel),
    key,
    keySet: key === 'manual' || (key === 'managed' && hasVariable(variable, envText)),
    headerNames: Object.keys(asRecord(entry.headers)),
  };
}

export function readDefaults(pi: JsonRecord): ModelDefaults {
  const level = text(pi.defaultThinkingLevel);
  return {
    provider: text(pi.defaultProvider),
    model: text(pi.defaultModel),
    thinkingLevel: THINKING_LEVELS.includes(level as ThinkingLevel) ? (level as ThinkingLevel) : '',
  };
}

export function readModels(document: ModelsDocument, pi: JsonRecord, envText: string): ModelsSettings {
  const providers: ProviderSettings[] = [];
  const foreign: ForeignProvider[] = [];
  for (const [id, value] of Object.entries(asRecord(document.doc.providers))) {
    const entry = asRecord(value);
    if (editable(entry)) providers.push(readProvider(id, entry, envText));
    else
      foreign.push({
        id,
        name: text(entry.name),
        api: text(entry.api),
        baseUrl: text(entry.baseUrl),
        modelCount: array(entry.models).length + Object.keys(asRecord(entry.modelOverrides)).length,
      });
  }
  return { providers, foreign, defaults: readDefaults(pi), commented: document.commented, problem: document.problem };
}

const sameMap = (a: ThinkingLevelMap | undefined, b: ThinkingLevelMap | undefined): boolean =>
  JSON.stringify(canonicalThinkingLevelMap(a) ?? {}) === JSON.stringify(canonicalThinkingLevelMap(b) ?? {});

const sameModel = (a: ProviderModel, b: ProviderModel): boolean =>
  a.id === b.id &&
  a.name === b.name &&
  a.reasoning === b.reasoning &&
  a.imageInput === b.imageInput &&
  a.contextWindow === b.contextWindow &&
  a.maxTokens === b.maxTokens &&
  sameMap(a.thinkingLevelMap, b.thinkingLevelMap);

const sameProvider = (a: ProviderSettings, b: ProviderSettings): boolean =>
  a.id === b.id &&
  a.name === b.name &&
  a.api === b.api &&
  a.baseUrl === b.baseUrl &&
  a.authHeader === b.authHeader &&
  a.models.length === b.models.length &&
  a.models.every((model, i) => sameModel(model, b.models[i]));

function limited(value: unknown, max: number, what: string): string {
  if (typeof value !== 'string' || value.length > max || !printable(value)) throw invalid(`Invalid ${what}`);
  return value;
}

function tokens(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 100_000_000)
    throw invalid(`Invalid ${what}`);
  return value;
}

function validateProvider(provider: ProviderSettings, isNew: boolean, taken: Set<string>): void {
  limited(provider.id, 80, 'provider id');
  if (isNew && (!PROVIDER_ID.test(provider.id) || RESERVED_PROVIDER_IDS.has(provider.id) || taken.has(provider.id)))
    throw invalid(`Invalid provider id: ${provider.id}`);
  limited(provider.name, 80, 'provider name');
  if (!isEndpoint(provider.api)) throw invalid('Invalid endpoint type');
  if (typeof provider.authHeader !== 'boolean') throw invalid('Invalid provider');
  assertEndpoint(limited(provider.baseUrl, 2000, 'base URL'));
  if (!Array.isArray(provider.models) || provider.models.length > 200) throw invalid('Invalid models');
  const ids = new Set<string>();
  for (const model of provider.models) {
    if (!limited(model.id, 200, 'model id').trim() || ids.has(model.id)) throw invalid(`Invalid model id: ${model.id}`);
    ids.add(model.id);
    limited(model.name, 200, 'model name');
    if (typeof model.reasoning !== 'boolean' || typeof model.imageInput !== 'boolean') throw invalid('Invalid model');
    tokens(model.contextWindow, 'context window');
    tokens(model.maxTokens, 'max output tokens');
    assertThinkingMap(model.thinkingLevelMap);
  }
}

/** A wire value is a short printable string. Unknown level names are refused rather than dropped. */
function assertThinkingMap(map: ThinkingLevelMap | undefined): void {
  if (map == null) return;
  if (typeof map !== 'object' || Array.isArray(map)) throw invalid('Invalid thinking levels');
  for (const [key, value] of Object.entries(map)) {
    if (!(THINKING_LEVELS as readonly string[]).includes(key)) throw invalid(`Invalid thinking level: ${key}`);
    if (value === null) continue;
    if (typeof value !== 'string' || !value.trim() || value.length > 80 || !printable(value))
      throw invalid('Invalid thinking level');
  }
}

/**
 * Fields the screen edits go over the previous entry, so cost, compat and the like stay.
 * The thinking map is written from the levels the screen set.
 */
function modelEntry(previous: JsonRecord | undefined, model: ProviderModel): JsonRecord {
  if (previous && sameModel(readModel(previous), model)) return previous;
  const next: JsonRecord = { ...previous, id: model.id };
  const put = (key: string, value: unknown, isDefault: boolean) => {
    if (!isDefault || (previous && key in previous)) next[key] = value;
  };
  if (model.name && model.name !== model.id) next.name = model.name;
  else delete next.name;
  put('reasoning', model.reasoning, !model.reasoning);
  put('input', model.imageInput ? ['text', 'image'] : ['text'], !model.imageInput);
  put('contextWindow', model.contextWindow, model.contextWindow === CONTEXT_WINDOW);
  put('maxTokens', model.maxTokens, model.maxTokens === MAX_TOKENS);
  const map = canonicalThinkingLevelMap(model.thinkingLevelMap);
  if (map) next.thinkingLevelMap = map;
  else delete next.thinkingLevelMap;
  return next;
}

function providerEntry(previous: JsonRecord | undefined, provider: ProviderSettings, managedKey: boolean): JsonRecord {
  const before = array(previous?.models).map(asRecord);
  const models = provider.models.map((model) =>
    modelEntry(
      before.find((entry) => entry.id === model.id),
      model
    )
  );
  const key = managedKey ? { apiKey: `$${providerKeyVariable(provider.id)}` } : {};
  if (!previous)
    return {
      ...(provider.name ? { name: provider.name } : {}),
      baseUrl: provider.baseUrl,
      api: provider.api,
      ...key,
      ...(provider.authHeader ? { authHeader: true } : {}),
      models,
    };
  const next: JsonRecord = { ...previous, baseUrl: provider.baseUrl, api: provider.api, ...key, models };
  if (provider.name) next.name = provider.name;
  else delete next.name;
  if (provider.authHeader || 'authHeader' in previous) next.authHeader = provider.authHeader;
  return next;
}

/** Two providers whose ids map to one key variable (`a.b` and `a-b` both give `MU_PROVIDER_A_B_API_KEY`). */
const sharedKey = (ids: string[]): KyrnError =>
  new KyrnError('sharedKey', `Providers ${ids.join(' and ')} would share a key`, { providers: ids });

export type ModelsChange = {
  models: boolean;
  pi: boolean;
  /** Credential variables to set, or to remove (undefined) because their provider is gone. */
  env: Map<string, string | undefined>;
};

/**
 * Validates everything first, then changes `document.doc` and `pi` in memory; the caller writes the files.
 * Entries this screen does not edit (overrides of built-in providers, `modelOverrides`, unknown fields) are untouched,
 * unless `removeEntries` names them: then they are deleted whole, and nothing else about them is changed.
 */
export function applyModels(
  document: ModelsDocument,
  pi: JsonRecord,
  envText: string,
  desired: { providers: ProviderSettings[]; defaults: ModelDefaults; removeEntries?: string[] },
  credentials: Credential[]
): ModelsChange {
  const change: ModelsChange = { models: false, pi: false, env: new Map() };
  if (!Array.isArray(desired.providers)) throw invalid('Invalid providers');
  const file = asRecord(document.doc.providers);
  const current = readModels(document, pi, envText);
  const known = new Map(current.providers.map((provider) => [provider.id, provider]));
  const taken = new Set(Object.keys(file));
  const seen = new Set<string>();
  for (const provider of desired.providers) {
    validateProvider(provider, !known.has(provider.id), taken);
    if (seen.has(provider.id)) throw invalid(`Duplicate provider: ${provider.id}`);
    seen.add(provider.id);
  }
  // Only a hand-written entry is removed by name; a provider of this screen is removed by leaving it out.
  const dropped = new Set<string>();
  if (desired.removeEntries !== undefined) {
    if (!Array.isArray(desired.removeEntries) || desired.removeEntries.length > 200) throw invalid('Invalid entries');
    for (const id of desired.removeEntries) {
      if (typeof id !== 'string' || !Object.hasOwn(file, id) || known.has(id))
        throw invalid(`Invalid entry to remove: ${String(id)}`);
      dropped.add(id);
    }
  }

  // A key belongs to exactly one provider of this save, under the one variable its id maps to.
  const owners = new Map<string, string[]>();
  for (const provider of desired.providers) {
    const variable = providerKeyVariable(provider.id);
    owners.set(variable, [...(owners.get(variable) ?? []), provider.id]);
  }
  const keys = new Map<string, string>();
  for (const credential of credentials) {
    const ids = owners.get(credential.name);
    if (!ids) throw invalid('Invalid credential');
    if (ids.length > 1) throw sharedKey(ids);
    keys.set(ids[0], credential.value);
  }
  const variables = new Set<string>();
  for (const [variable, ids] of owners) {
    if (!ids.some((id) => keys.has(id) || known.get(id)?.key === 'managed')) continue;
    if (ids.length > 1) throw sharedKey(ids);
    variables.add(variable);
  }

  const removed = current.providers.filter((provider) => !seen.has(provider.id));
  const touched = desired.providers.filter((provider) => {
    const before = known.get(provider.id);
    return !before || !sameProvider(before, provider) || keys.has(provider.id);
  });
  if (removed.length || touched.length || dropped.size) {
    if (document.problem)
      throw new KyrnError(
        'modelsUnreadable',
        'models.json could not be read. Repair it by hand before saving providers.'
      );
    if (document.commented)
      throw new KyrnError(
        'modelsCommented',
        'models.json contains comments, which saving from here would remove. Edit providers by hand.'
      );
    const next: JsonRecord = {};
    for (const [id, entry] of Object.entries(file)) {
      const provider = desired.providers.find((item) => item.id === id);
      if (!known.has(id)) {
        if (!dropped.has(id)) next[id] = entry;
      } else if (provider)
        next[id] = touched.includes(provider) ? providerEntry(asRecord(entry), provider, keys.has(id)) : entry;
    }
    for (const provider of touched)
      if (!(provider.id in file)) next[provider.id] = providerEntry(undefined, provider, keys.has(provider.id));
    document.doc.providers = next;
    change.models = true;
    for (const provider of removed)
      if (provider.key === 'managed' && !variables.has(providerKeyVariable(provider.id)))
        change.env.set(providerKeyVariable(provider.id), undefined);
    for (const [id, value] of keys) change.env.set(providerKeyVariable(id), value);
  }

  if (applyDefaults(pi, current.defaults, desired.defaults)) change.pi = true;
  return change;
}

/**
 * Makes `defaults` the model new sessions start on, in pi's settings (`pi`, changed in memory), when it differs from
 * `before`. Checked only when changed: a hand-written settings.json may name a model without a provider, and that is
 * pi's to read. Says whether anything changed.
 */
export function applyDefaults(pi: JsonRecord, before: ModelDefaults, defaults: ModelDefaults): boolean {
  const level = defaults.thinkingLevel;
  if (before.provider === defaults.provider && before.model === defaults.model && before.thinkingLevel === level)
    return false;
  limited(defaults.provider, 200, 'default provider');
  limited(defaults.model, 200, 'default model');
  if (Boolean(defaults.provider) !== Boolean(defaults.model))
    throw new KyrnError('pickBoth', 'Choose a provider and a model together');
  if (level !== '' && !THINKING_LEVELS.includes(level)) throw invalid('Invalid thinking level');
  const put = (key: string, value: string) => {
    if (value) pi[key] = value;
    else delete pi[key];
  };
  put('defaultProvider', defaults.provider);
  put('defaultModel', defaults.model);
  put('defaultThinkingLevel', level);
  // pi lets a per-model level win over the default one. Where one exists for this model, it follows along,
  // so that what this screen shows is what a new session starts with.
  const perModel = asRecord(pi.modelThinkingLevels);
  const entry = `${defaults.provider}/${defaults.model}`;
  if (level && defaults.model && entry in perModel && perModel[entry] !== level)
    pi.modelThinkingLevels = { ...perModel, [entry]: level };
  return true;
}

/**
 * The saved key of a provider, for the connection test only; it never leaves the main process.
 * `unavailable`: there is one, but it is a command or a composite value this app will not evaluate.
 */
export function storedKey(
  document: ModelsDocument,
  envText: string,
  id: string
): { baseUrl: string; api: string; key: string; unavailable: boolean } | undefined {
  const providers = asRecord(document.doc.providers);
  if (!(id in providers)) return undefined;
  const entry = asRecord(providers[id]);
  const apiKey = text(entry.apiKey);
  const reference = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/.exec(apiKey);
  const key = reference ? variableValue(reference[1] ?? reference[2], envText) : apiKey;
  const unavailable = apiKey.startsWith('!') || (reference ? !key : apiKey.includes('$'));
  return { baseUrl: text(entry.baseUrl), api: text(entry.api), key: unavailable ? '' : key, unavailable };
}
