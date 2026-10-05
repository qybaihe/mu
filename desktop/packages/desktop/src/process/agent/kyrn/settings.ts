import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CLM_DEFAULT_MODEL, CLM_KEY_VARIABLE } from '../../../common/kyrn/clm';
import { KyrnError } from '../../../common/kyrn/errors';
import { DECISION_MODES, type DecisionMode, type FeatureState } from '../../../common/kyrn/manifest';
import type { Credential, JudgeSettings, JudgeType, KyrnSettings, SaveSettings } from '../../../common/kyrn/types';
import { configPath } from './naming';
import { array, asRecord, text } from './piRpc';
import { atomic, hasVariable, parseObject, readOptional, serialise, withVariables } from './config/files';
import { applyDecisionModes, applyFeatures, loadManifest, readDecisionModes, readFeatures } from './config/features';
import { applyModels, assertEndpoint, parseModels, readModels, storedKey } from './config/models';
import {
  dropConfiguredBoardModel,
  isBoardModel,
  permissionModes,
  permissionsFile,
  readBoardModel,
  readPermissionDefault,
  withBoardModel,
} from './config/muState';

const defaults: Record<string, Partial<JudgeSettings>> = {
  jev: { type: 'jev', model: 'jev-latest', apiKeyEnv: 'TYPESAFE_API_KEY' },
  'jev-direct': { type: 'typesafe', model: 'jev-latest', apiKeyEnv: 'TYPESAFE_API_KEY' },
  // OpenRouter serves Jev over the same System One protocol, with a key kept for Jev alone.
  'jev-openrouter': {
    type: 'typesafe',
    baseUrl: 'https://openrouter.ai/api/v1/systemone',
    model: '~typesafe/jev-latest',
    apiKeyEnv: 'MU_JUDGE_OPENROUTER_API_KEY',
  },
  'jev-gateway': { type: 'gateway', model: 'typesafe-ai/jev', apiKeyEnv: 'AI_GATEWAY_API_KEY' },
  laya: { type: 'local', baseUrl: 'http://127.0.0.1:47823' },
  // CLM on a server of one's own; no address is clm-serve's default on this machine (common/kyrn/clm.ts).
  clm: { type: 'clm', model: CLM_DEFAULT_MODEL, apiKeyEnv: CLM_KEY_VARIABLE },
  // Classifier models of mu's catalog, reached with the provider's own key (OPENCODE_API_KEY, CLOUDFLARE_API_KEY and
  // CLOUDFLARE_ACCOUNT_ID, or a sign-in in mu). Jev 1.13 free on OpenCode Zen needs no key, for a limited time.
  'jev-opencode': { type: 'classifier', model: 'opencode/jev-1.13' },
  'jev-opencode-free': { type: 'classifier', model: 'opencode/jev-1.13-free' },
  'jev-cloudflare': { type: 'classifier', model: 'cloudflare-workers-ai/typesafe/jev' },
  clef: { type: 'classifier', model: 'cloudflare-workers-ai/@cf/cloudflare/clef' },
  'clef-flash': { type: 'classifier', model: 'cloudflare-workers-ai/@cf/cloudflare/clef-flash' },
  mock: { type: 'mock' },
};
const types = new Set(['jev', 'typesafe', 'clm', 'gateway', 'local', 'http', 'llm', 'classifier', 'mock']);
const modes = new Set<string>(DECISION_MODES);
/** What a judge may name as its credential. A provider's key is deliberately not among them. */
const variable = /^(?:TYPESAFE_API_KEY|AI_GATEWAY_API_KEY|(?:MU|KYRN)_JUDGE_[A-Z0-9_]+)$/;
/**
 * The provider variables a classifier judge of this page is reached with. They are saved and reported like a judge's
 * key, but never named as one (`apiKeyEnv`): mu gives them to their own provider only.
 */
const classifierVariables = ['OPENCODE_API_KEY', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID'];
const saved = (name: string): boolean => variable.test(name) || classifierVariables.includes(name);
/**
 * Keys for a service other than TypeSafe: Jev on OpenRouter or at an address of one's own, and a CLM server. The
 * harness refuses a System One judge keyed by one of them that has no address of its own (KEYS_FOR_ELSEWHERE in
 * kyrn-judge's registry), so such a key never goes to TypeSafe.
 */
const keysForElsewhere = new Set(['MU_JUDGE_OPENROUTER_API_KEY', 'MU_JUDGE_CUSTOM_API_KEY', CLM_KEY_VARIABLE]);
/** Keys of custom model providers, referenced from models.json as `"$MU_PROVIDER_<ID>_API_KEY"`. */
const providerVariable = /^MU_PROVIDER_[A-Z0-9_]{1,80}_API_KEY$/;
/** The .env is sourced by a shell (`kyrn/bin/mu`), so nothing a shell would interpret may get into a value. */
const secret = /^[A-Za-z0-9_./+=:@-]{1,4096}$/;
/** The context cap: 0 (follow the model), or a number of tokens in this range. */
const CONTEXT_MIN = 8192;
const CONTEXT_MAX = 10000000;

const sameJudge = (a: JudgeSettings | undefined, b: JudgeSettings): boolean =>
  a !== undefined &&
  a.type === b.type &&
  a.model === b.model &&
  a.baseUrl === b.baseUrl &&
  a.apiKeyEnv === b.apiKeyEnv &&
  a.timeoutMs === b.timeoutMs;

/**
 * Shares the CLI configuration: the harness config (mu.json), pi's settings.json and pi's models.json, plus two
 * settings mu keeps in `<agentDir>/mu/` (the permission default and the board's model, see config/muState.ts).
 * Keys are write-only and remain in the harness .env. A save only rewrites what it changes, so hand-written
 * parts keep their form and defaults that nobody overrode keep following upstream.
 */
export class SettingsStore {
  private agentDir: string;
  private root: string;
  private envPath: string;
  private manifestPath?: string;
  private piPath: string;
  private modelsPath: string;
  private permissionsPath: string;
  private boardPath: string;
  /** @param files where the harness keeps its keys and its manifest, when not where a checkout does (see harness.ts) */
  constructor(agentDir: string, root: string, files: { env?: string; manifest?: string } = {}) {
    this.agentDir = agentDir;
    this.root = root;
    this.envPath = files.env ?? join(root, '.env');
    this.manifestPath = files.manifest;
    this.piPath = join(agentDir, 'settings.json');
    this.modelsPath = join(agentDir, 'models.json');
    this.permissionsPath = join(agentDir, 'mu', 'permissions.json');
    this.boardPath = join(agentDir, 'mu', 'board.json');
  }
  /** Looked up on every use: the file is renamed from kyrn.json to mu.json when the home is moved. */
  private get path(): string {
    return configPath(this.agentDir);
  }
  private load() {
    const raw = readOptional(this.path);
    const piRaw = readOptional(this.piPath);
    const modelsRaw = readOptional(this.modelsPath);
    const permissionsRaw = readOptional(this.permissionsPath);
    const boardRaw = readOptional(this.boardPath);
    const config = parseObject(raw, this.path);
    const harness = loadManifest(this.root, this.manifestPath);
    const manifest = harness.status === 'ok' ? harness.manifest : undefined;
    const board = readBoardModel(manifest, config, boardRaw);
    return {
      raw,
      piRaw,
      modelsRaw,
      permissionsRaw,
      boardRaw,
      board,
      env: readOptional(this.envPath),
      config,
      pi: parseObject(piRaw, this.piPath),
      models: parseModels(modelsRaw),
      harness,
      // board.json also holds each project's switch, which changes all the time: only its model counts.
      revision: createHash('sha256')
        .update(JSON.stringify([raw, piRaw, modelsRaw, permissionsRaw, board.model]))
        .digest('hex'),
    };
  }
  read(): KyrnSettings {
    return this.state(this.load());
  }
  private state(files: ReturnType<SettingsStore['load']>): KyrnSettings {
    const { config, pi, env, harness } = files;
    const compaction = asRecord(pi.compaction);
    const judges: Record<string, JudgeSettings> = {};
    for (const [name, value] of Object.entries({ ...defaults, ...asRecord(config.judges) })) {
      const judge = asRecord(value);
      judges[name] = {
        type: (text(judge.type) || 'jev') as JudgeType,
        model: text(judge.model),
        baseUrl: text(judge.baseUrl),
        apiKeyEnv: text(judge.apiKeyEnv),
        timeoutMs: typeof judge.timeoutMs === 'number' ? judge.timeoutMs : 10000,
      };
    }
    const keys: Record<string, boolean> = {};
    for (const name of ['TYPESAFE_API_KEY', 'AI_GATEWAY_API_KEY', ...Object.values(judges).map((j) => j.apiKeyEnv)]) {
      if (variable.test(name)) keys[name] = hasVariable(name, env);
    }
    for (const name of classifierVariables) keys[name] = hasVariable(name, env);
    const compression = asRecord(config.features).compaction;
    const mode = text(asRecord(config.modes).default) || 'active';
    const manifest = harness.status === 'ok' ? harness.manifest : undefined;
    const features = manifest ? readFeatures(manifest, config) : {};
    return {
      revision: files.revision,
      tiers: array(config.tiers).length ? array(config.tiers).map(text) : ['jev'],
      judges,
      mode: (modes.has(mode) ? mode : 'active') as DecisionMode,
      keys,
      betaCompression: compression === true || asRecord(compression).enabled === true,
      autoCompaction: compaction.enabled !== false,
      maxContextTokens: typeof compaction.maxContextTokens === 'number' ? compaction.maxContextTokens : 0,
      harness,
      decisionModes: manifest ? readDecisionModes(manifest, config) : {},
      features,
      models: readModels(files.models, pi, env),
      permissions: readPermissionDefault(manifest, config, features, files.permissionsRaw),
      boardModel: files.board,
    };
  }
  save(input: SaveSettings): KyrnSettings {
    const files = this.load();
    if (input.revision !== files.revision) throw new KyrnError('stale', 'Configuration changed. Reload before saving.');
    const current = this.state(files);
    const { config, pi, harness } = files;
    const changed = { config: false, pi: false, models: false };

    if (!modes.has(input.mode) || typeof input.betaCompression !== 'boolean')
      throw new KyrnError('invalid', 'Invalid mode');
    if (
      typeof input.autoCompaction !== 'boolean' ||
      !Number.isSafeInteger(input.maxContextTokens) ||
      (input.maxContextTokens !== 0 && (input.maxContextTokens < CONTEXT_MIN || input.maxContextTokens > CONTEXT_MAX))
    )
      throw new KyrnError(
        'contextLimit',
        `Context threshold must be 0 or an integer between ${CONTEXT_MIN} and ${CONTEXT_MAX}`,
        { min: CONTEXT_MIN, max: CONTEXT_MAX }
      );
    if (
      !Array.isArray(input.tiers) ||
      input.tiers.length === 0 ||
      input.tiers.length > 8 ||
      input.tiers.some((name) => typeof name !== 'string' || !(name in input.judges))
    )
      throw new KyrnError('invalid', 'Invalid judge tiers');
    for (const [name, judge] of Object.entries(input.judges)) {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name) || !types.has(judge.type))
        throw new KyrnError('invalid', 'Invalid judge');
      if (typeof judge.model !== 'string' || judge.model.length > 200) throw new KyrnError('invalid', 'Invalid model');
      if (!Number.isFinite(judge.timeoutMs) || judge.timeoutMs < 100 || judge.timeoutMs > 120000)
        throw new KyrnError('invalid', 'Invalid timeout');
      if (judge.apiKeyEnv && !variable.test(judge.apiKeyEnv))
        throw new KyrnError('keyVariable', 'Invalid credential variable', { name: judge.apiKeyEnv });
      if (judge.baseUrl) assertEndpoint(judge.baseUrl);
    }
    // A judge this save puts in the order, or changes there, must be one the harness runs. One the order already had
    // as it is stays the business of whoever wrote it: refusing it would block every other change.
    for (const name of input.tiers) {
      const judge = input.judges[name];
      if (current.tiers.includes(name) && sameJudge(current.judges[name], judge)) continue;
      if (judge.type === 'classifier' && !/^[^/\s]+\/\S+$/.test(judge.model))
        throw new KyrnError('invalid', 'Invalid model');
      if (judge.type === 'typesafe' && keysForElsewhere.has(judge.apiKeyEnv) && !judge.baseUrl)
        throw new KyrnError('judgeEndpoint', `Judge ${name} has no base URL, and its key is not sent to TypeSafe`, {
          name,
        });
    }
    const credentials: Credential[] = [...(input.credential ? [input.credential] : []), ...(input.credentials ?? [])];
    for (const credential of credentials) {
      const named = typeof credential?.name === 'string' && typeof credential.value === 'string';
      if (!named || !(saved(credential.name) || providerVariable.test(credential.name)))
        throw new KyrnError('invalid', 'Invalid credential');
      if (!secret.test(credential.value)) throw new KyrnError('credential', 'Invalid credential');
    }
    const providerKeys = credentials.filter((credential) => providerVariable.test(credential.name));
    if (providerKeys.length && !input.models) throw new KyrnError('invalid', 'Invalid credential');

    // Judges: only the ones that were changed are written, so a built-in one nobody touched is not frozen into the file.
    const previous = asRecord(config.judges);
    const judges = { ...previous };
    for (const [name, judge] of Object.entries(input.judges)) {
      if (sameJudge(current.judges[name], judge)) continue;
      judges[name] = {
        ...asRecord(previous[name]),
        // Preserve Laya's measured capability profile when materialising a built-in.
        ...(name === 'laya' && !previous[name]
          ? { profile: { capabilities: { relate: false, rate: false, meta: false } } }
          : {}),
        ...judge,
        model: judge.model || undefined,
        baseUrl: judge.baseUrl || undefined,
        apiKeyEnv: judge.apiKeyEnv || undefined,
      };
      changed.config = true;
    }
    for (const name of Object.keys(previous)) {
      if (name in input.judges) continue;
      delete judges[name];
      changed.config = true;
    }
    if (changed.config) config.judges = judges;
    if (input.tiers.join('\n') !== current.tiers.join('\n')) {
      config.tiers = input.tiers;
      changed.config = true;
    }
    if (input.mode !== current.mode) {
      config.modes = { ...asRecord(config.modes), default: input.mode };
      changed.config = true;
    }

    // The old beta switch and `features.compaction` say the same thing; whichever of the two was changed counts.
    let features: Record<string, FeatureState> | undefined = input.features;
    const described = harness.status === 'ok' && harness.manifest.features.some((item) => item.name === 'compaction');
    if (input.betaCompression !== current.betaCompression) {
      if (described) {
        const state = features?.compaction ?? current.features.compaction;
        features = { ...features, compaction: { ...state, enabled: input.betaCompression } };
      } else {
        const all = asRecord(config.features);
        config.features = { ...all, compaction: { ...asRecord(all.compaction), enabled: input.betaCompression } };
        changed.config = true;
      }
    }
    if (harness.status === 'ok') {
      if (input.decisionModes && applyDecisionModes(harness.manifest, config, input.decisionModes))
        changed.config = true;
      if (features && applyFeatures(harness.manifest, config, features)) changed.config = true;
    } else if (Object.keys(input.decisionModes ?? {}).length || Object.keys(features ?? {}).length) {
      throw new KyrnError('harnessOld', 'This harness does not describe its decisions and features. Update it first.');
    }

    if (input.autoCompaction !== current.autoCompaction || input.maxContextTokens !== current.maxContextTokens) {
      pi.compaction = {
        ...asRecord(pi.compaction),
        enabled: input.autoCompaction,
        maxContextTokens: input.maxContextTokens,
      };
      changed.pi = true;
    }

    // The permission default and the board's model: mu's own files, written only when they change.
    const own: [string, string][] = [];
    if (input.permissions && input.permissions.mode !== current.permissions.mode) {
      const manifest = harness.status === 'ok' ? harness.manifest : undefined;
      if (!permissionModes(manifest).includes(input.permissions.mode))
        throw new KyrnError('invalid', 'Invalid permission mode');
      own.push([this.permissionsPath, permissionsFile(input.permissions.mode)]);
    }
    const boardModel = input.boardModel?.model;
    if (boardModel !== undefined && boardModel !== current.boardModel.model) {
      if (!current.boardModel.supported)
        throw new KyrnError('harnessOld', 'This harness cannot be told which model writes the board. Update it first.');
      if (typeof boardModel !== 'string' || !isBoardModel(boardModel))
        throw new KyrnError('invalid', 'Invalid board model');
      own.push([this.boardPath, withBoardModel(files.boardRaw, boardModel)]);
      // mu reads mu.json's `features.board.model` first: left there, it would win over the model picked here.
      if (dropConfiguredBoardModel(config)) changed.config = true;
    }

    const env = new Map<string, string | undefined>();
    if (input.models) {
      const change = applyModels(files.models, pi, files.env, input.models, providerKeys);
      changed.models = change.models;
      changed.pi ||= change.pi;
      for (const [name, value] of change.env) env.set(name, value);
    }
    for (const credential of credentials) if (saved(credential.name)) env.set(credential.name, credential.value);

    // Everything above only checked and prepared. The key goes first: a provider must never point at a missing one.
    if (env.size) atomic(this.envPath, withVariables(files.env, env));
    for (const [path, value] of own) atomic(path, value);
    if (changed.config) atomic(this.path, serialise(config, files.raw));
    if (changed.pi) atomic(this.piPath, serialise(pi, files.piRaw));
    if (changed.models) atomic(this.modelsPath, serialise(files.models.doc, files.modelsRaw));
    return this.read();
  }
  /** For the connection test: the saved key of a provider, which stays inside the main process. */
  storedKey(id: string): ReturnType<typeof storedKey> {
    return storedKey(parseModels(readOptional(this.modelsPath)), readOptional(this.envPath), id);
  }
}
