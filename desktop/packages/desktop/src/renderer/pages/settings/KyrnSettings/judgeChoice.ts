import { CLM_KEY_VARIABLE } from '@/common/kyrn/clm';
import type { JudgeSettings, JudgeType, KyrnSettings } from '@/common/kyrn/types';

/**
 * The three kinds of judge a person chooses between: Jev, Laya on this machine, or CLM on a server of their own. The
 * profiles behind them (jev, jev-direct, jev-openrouter, jev-gateway, jev-opencode, jev-opencode-free, jev-cloudflare,
 * jev-custom, laya, clm) are how the config keeps them; the tiers page shows them by these three names, and a Jev
 * profile by the service it reaches Jev through. Anything else (another classifier model such as Clef, a model as
 * judge, a mock, a self-hosted HTTP judge) is only named there, by the name it was given.
 */
export type JudgeChoice = 'jev' | 'local' | 'clm';

export const JUDGE_CHOICES: readonly JudgeChoice[] = ['jev', 'local', 'clm'];
/** The choices of the first-run guide. CLM needs a server with a GPU someone already runs: it waits in the settings. */
export const GUIDE_CHOICES: readonly JudgeChoice[] = ['jev', 'local'];

/** The kind of each type; a classifier model is Jev when it is Jev's (see serviceOf), else of no kind. */
const KIND_OF: Record<Exclude<JudgeType, 'classifier'>, JudgeChoice | undefined> = {
  jev: 'jev',
  typesafe: 'jev',
  gateway: 'jev',
  local: 'local',
  clm: 'clm',
  llm: undefined,
  http: undefined,
  mock: undefined,
};

/** The profile a choice prefers when several of its kind exist: the built-in names. */
const PREFERRED: Record<JudgeChoice, string> = { jev: 'jev', local: 'laya', clm: 'clm' };

/** Which of the three a profile is; undefined for a model as judge, a self-hosted HTTP judge or the mock. */
export function kindOf(judge: JudgeSettings | undefined): JudgeChoice | undefined {
  if (!judge) return undefined;
  if (judge.type === 'classifier') return serviceOf(judge) ? 'jev' : undefined;
  return KIND_OF[judge.type];
}

/**
 * The services Jev is reached through, each kept as a profile of its own: chosen by the key that is set (see the auto
 * help text), OpenCode Zen's free Jev (no key, for a limited time), TypeSafe directly, OpenRouter, the Vercel AI
 * Gateway, OpenCode Zen with a key, Cloudflare Workers AI, or an address of the person's own that speaks TypeSafe's
 * System One protocol. A profile's service follows from its type, its model and the variable of its key; nothing
 * stores it.
 */
export const JEV_SERVICES = [
  'auto',
  'opencodeFree',
  'typesafe',
  'openrouter',
  'gateway',
  'opencode',
  'cloudflare',
  'custom',
] as const;
export type JevService = (typeof JEV_SERVICES)[number];

/** Where the key of a Jev profile is kept when the profile names none. */
export const JEV_KEY_VARIABLE = 'TYPESAFE_API_KEY';
const OPENROUTER_KEY_VARIABLE = 'MU_JUDGE_OPENROUTER_API_KEY';
const CUSTOM_KEY_VARIABLE = 'MU_JUDGE_CUSTOM_API_KEY';
/** The variables pi reads for OpenCode Zen and Cloudflare Workers AI: a classifier judge there goes with them. */
const OPENCODE_KEY_VARIABLE = 'OPENCODE_API_KEY';
export const CLOUDFLARE_KEY_VARIABLE = 'CLOUDFLARE_API_KEY';
export const CLOUDFLARE_ACCOUNT_VARIABLE = 'CLOUDFLARE_ACCOUNT_ID';

type Preset = Omit<JudgeSettings, 'timeoutMs'>;

/**
 * Each service's profile: the store's and the harness's built-in one under its name, or for a custom service
 * jev-custom, which this page makes when it is first chosen. A missing profile is made from the preset.
 */
const SERVICE_PROFILES: Record<JevService, { name: string; preset: Preset }> = {
  auto: { name: 'jev', preset: { type: 'jev', model: 'jev-latest', baseUrl: '', apiKeyEnv: JEV_KEY_VARIABLE } },
  typesafe: {
    name: 'jev-direct',
    preset: { type: 'typesafe', model: 'jev-latest', baseUrl: '', apiKeyEnv: JEV_KEY_VARIABLE },
  },
  openrouter: {
    name: 'jev-openrouter',
    preset: {
      type: 'typesafe',
      model: '~typesafe/jev-latest',
      baseUrl: 'https://openrouter.ai/api/v1/systemone',
      apiKeyEnv: OPENROUTER_KEY_VARIABLE,
    },
  },
  gateway: {
    name: 'jev-gateway',
    preset: { type: 'gateway', model: 'typesafe-ai/jev', baseUrl: '', apiKeyEnv: 'AI_GATEWAY_API_KEY' },
  },
  opencodeFree: {
    name: 'jev-opencode-free',
    preset: { type: 'classifier', model: 'opencode/jev-1.13-free', baseUrl: '', apiKeyEnv: '' },
  },
  opencode: {
    name: 'jev-opencode',
    preset: { type: 'classifier', model: 'opencode/jev-1.13', baseUrl: '', apiKeyEnv: '' },
  },
  cloudflare: {
    name: 'jev-cloudflare',
    preset: { type: 'classifier', model: 'cloudflare-workers-ai/typesafe/jev', baseUrl: '', apiKeyEnv: '' },
  },
  custom: {
    name: 'jev-custom',
    preset: { type: 'typesafe', model: 'jev-latest', baseUrl: '', apiKeyEnv: CUSTOM_KEY_VARIABLE },
  },
};

/** The timeout the store reads for a profile that names none. */
const TIMEOUT_MS = 10000;

/** What the first judge asked is: the choice shown as selected. Undefined for a mock or a self-hosted judge. */
export function choiceOf(settings: KyrnSettings): JudgeChoice | undefined {
  return kindOf(settings.judges[settings.tiers[0]]);
}

/**
 * The profile a choice stands for: the one of that kind the order already asks (so Jev's key is the one its service
 * needs), else the one with the built-in name, else the first of that kind.
 */
export function profileFor(settings: KyrnSettings, choice: JudgeChoice): string | undefined {
  const asked = settings.tiers.find((name) => kindOf(settings.judges[name]) === choice);
  if (asked) return asked;
  if (kindOf(settings.judges[PREFERRED[choice]]) === choice) return PREFERRED[choice];
  return Object.keys(settings.judges).find((name) => kindOf(settings.judges[name]) === choice);
}

/**
 * The settings with `choice` as the one judge. A cascade someone built by hand is replaced: the simple view has one
 * judge, the advanced view has the order.
 */
export function choose(settings: KyrnSettings, choice: JudgeChoice): KyrnSettings {
  const existing = profileFor(settings, choice);
  return existing ? { ...settings, tiers: [existing] } : settings;
}

/**
 * The service a Jev profile reaches Jev through, read from its type, its model and the variable of its key: a System
 * One profile keyed for OpenRouter or for a service of the person's own is that one, any other is TypeSafe; a
 * classifier model is Jev on OpenCode Zen (free when its id says so) or on Cloudflare. Undefined for a judge that is
 * not Jev.
 */
export function serviceOf(judge: JudgeSettings | undefined): JevService | undefined {
  if (judge?.type === 'jev') return 'auto';
  if (judge?.type === 'gateway') return 'gateway';
  if (judge?.type === 'classifier') {
    if (judge.model.startsWith('opencode/')) return judge.model.endsWith('-free') ? 'opencodeFree' : 'opencode';
    return judge.model.startsWith('cloudflare-workers-ai/typesafe/') ? 'cloudflare' : undefined;
  }
  if (judge?.type !== 'typesafe') return undefined;
  if (judge.apiKeyEnv === OPENROUTER_KEY_VARIABLE) return 'openrouter';
  return judge.apiKeyEnv === CUSTOM_KEY_VARIABLE ? 'custom' : 'typesafe';
}

/** The model a service's own profile starts with: shown where the model is typed while it is empty. */
export const defaultModelOf = (service: JevService): string => SERVICE_PROFILES[service].preset.model;

/**
 * The settings with the judge at `index` of the order reaching Jev through `service`: that service's profile takes its
 * place (the built-in one, else the first of that service, else one made from the service's preset), and is not asked
 * twice. Nothing of the profile it replaces comes along: an address and a key belong to their own service (a TypeSafe
 * URL is no OpenRouter URL, and an OpenRouter key goes to OpenRouter only).
 */
export function withJevService(settings: KyrnSettings, index: number, service: JevService): KyrnSettings {
  const current = settings.tiers[index];
  if (current === undefined || serviceOf(settings.judges[current]) === service) return settings;
  const { name: builtIn, preset } = SERVICE_PROFILES[service];
  const fits = (name: string) => serviceOf(settings.judges[name]) === service;
  const existing = fits(builtIn) ? builtIn : Object.keys(settings.judges).find(fits);
  if (existing) return askedAt(settings, index, existing);
  // Made under the built-in name, unless a profile of another service written by hand has it: that one stays as it is.
  let name = builtIn;
  for (let number = 2; name in settings.judges; number++) name = `${builtIn}-${number}`;
  const judges = { ...settings.judges, [name]: { ...preset, timeoutMs: TIMEOUT_MS } };
  return askedAt({ ...settings, judges }, index, name);
}

/** The settings with `profile` asked at `index` of the order, and nowhere else. */
function askedAt(settings: KyrnSettings, index: number, profile: string): KyrnSettings {
  const tiers = settings.tiers.map((name, at) => (at === index ? profile : name));
  return { ...settings, tiers: tiers.filter((name, at) => tiers.indexOf(name) === at) };
}

/**
 * What a classifier model of OpenCode Zen or Cloudflare needs set, Jev or not (Clef): the provider's key, with
 * Cloudflare the account too. Nothing for the free Jev, nor for a model mu reaches another way (a sign-in in mu, the
 * provider's variable set elsewhere).
 */
export function classifierVariables(judge: JudgeSettings): string[] {
  if (judge.model.startsWith('cloudflare-workers-ai/')) return [CLOUDFLARE_KEY_VARIABLE, CLOUDFLARE_ACCOUNT_VARIABLE];
  if (judge.model.startsWith('opencode/') && !judge.model.endsWith('-free')) return [OPENCODE_KEY_VARIABLE];
  return [];
}

/** What a Jev profile needs set: its service's key, with Cloudflare its account too; nothing for the free Jev. */
export function jevVariables(judge: JudgeSettings | undefined): string[] {
  if (judge?.type === 'classifier') return classifierVariables(judge);
  return [judge?.apiKeyEnv || JEV_KEY_VARIABLE];
}

/** The variable a Jev profile's key lives in; undefined for OpenCode Zen's free Jev, which needs none. */
export const jevKeyVariable = (judge: JudgeSettings | undefined): string | undefined => jevVariables(judge)[0];

/** The variable a CLM profile's key lives in: needed only by a server started with CLM_API_KEY. */
export const clmKeyVariable = (judge: JudgeSettings | undefined): string => judge?.apiKeyEnv || CLM_KEY_VARIABLE;
