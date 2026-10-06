import {
  isPrivateNetworkHost,
  isSafeEndpoint,
  PROVIDER_ID,
  RESERVED_PROVIDER_IDS,
  suggestProviderId,
  type EndpointType,
  type ProviderTestResult,
} from '@/common/kyrn/models';
import type { KyrnSettings } from '@/common/kyrn/types';
import type { Draft } from '@/renderer/pages/settings/KyrnSettings/draft';
import { blankModel, blankProvider } from '@/renderer/pages/settings/KyrnSettings/providers/endpoints';
import type { ModelService } from './services';

/**
 * The first-run guide: a model, a permission mode, a judge, done. It is shown once, to someone who has no startup model yet; it is
 * marked seen when it is finished or skipped, and can be opened again from the models settings.
 */
export const ONBOARDING_KEY = 'mu.onboarding.v1';

export function onboardingSeen(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): boolean {
  try {
    return Boolean(storage?.getItem(ONBOARDING_KEY));
  } catch {
    // No storage (a locked-down profile): never nag.
    return true;
  }
}

export function markOnboardingSeen(storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(ONBOARDING_KEY, new Date().toISOString());
  } catch {
    // Nothing to do: the guide just shows again next time.
  }
}

/** Someone new: nothing tells mu which model to start with. */
export const needsOnboarding = (settings: KyrnSettings): boolean => !settings.models.defaults.provider;

/**
 * The wire formats the guide asks about for an address typed in (OpenAI's two, Anthropic's); Google's is in the
 * provider settings, and a service of the key tile brings its own.
 */
export type GuideApi = Extract<EndpointType, 'openai-completions' | 'openai-responses' | 'anthropic-messages'>;

export type ApiModel = { api: EndpointType; baseUrl: string; key: string; model: string };

const isLoopback = (baseUrl: string): boolean => {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
};

/** What is wrong with the typed endpoint, or undefined. A key may stay empty only for a service on this machine. */
export function apiModelProblem(input: ApiModel): 'baseUrl' | 'key' | 'model' | undefined {
  if (!isSafeEndpoint(input.baseUrl.trim())) return 'baseUrl';
  if (!input.key.trim() && !isLoopback(input.baseUrl.trim())) return 'key';
  if (!input.model.trim()) return 'model';
  return undefined;
}

/** The word of a host a provider is named after: `deepseek` of `api.deepseek.com`, or '' when it has none. */
function hostWord(hostname: string): string {
  const label = hostname.split('.').find((part) => !['api', 'www'].includes(part));
  const word = suggestProviderId(label ?? '');
  return word && PROVIDER_ID.test(word) ? word : '';
}

/**
 * `word` itself when no provider has it, else `word-custom`, `word-custom-2`, …: pi's built-in providers have their
 * ids already (a models.json entry under a built-in id reroutes it instead of adding one).
 */
export function freeIdFrom(word: string, taken: ReadonlySet<string>): string {
  const free = (id: string) => !taken.has(id) && !RESERVED_PROVIDER_IDS.has(id) && PROVIDER_ID.test(id);
  if (free(word)) return word;
  for (let n = 1; ; n += 1) {
    const id = n === 1 ? `${word}-custom` : `${word}-custom-${n}`;
    if (free(id)) return id;
  }
}

/**
 * A readable id from the address: `https://api.deepseek.com/v1` -> `deepseek`, or `deepseek-custom` when pi has a
 * built-in provider of that name.
 */
export function providerIdFor(baseUrl: string, taken: ReadonlySet<string>): string {
  let base = 'custom';
  try {
    const host = new URL(baseUrl).hostname;
    // A numeric LAN address is not a name (`192` of 192.168.x.x). Call it local, and show the host as the label.
    if (isLoopback(baseUrl) || isPrivateNetworkHost(host)) base = 'local';
    else base = hostWord(host) || base;
  } catch {
    // An address that does not parse is caught by the check before this is ever called.
  }
  return freeIdFrom(base, taken);
}

/**
 * The display name of the provider the guide adds, which the provider settings and the guide's summary show: the id
 * when it is the address's own word (`moonshot`), else the address's host (`localhost:11434`, or `api.deepseek.com`
 * beside pi's own deepseek). An id like `local` or `deepseek-custom` is English words, and a name is read in any
 * language.
 */
export function providerNameFor(baseUrl: string, id: string): string {
  try {
    const url = new URL(baseUrl);
    if (!isLoopback(baseUrl) && id === hostWord(url.hostname)) return id;
    // The store takes a name of at most 80 characters.
    return url.host.slice(0, 80) || id;
  } catch {
    return id;
  }
}

/**
 * The draft with the typed endpoint as a new provider and its model as the startup model. `previous` is the id the
 * guide added the last time through (going back and changing the address must not leave a second provider behind).
 * `named`: a known service, whose id the provider's is made from and whose name it takes.
 */
export function withApiModel(
  draft: Draft,
  input: ApiModel,
  previous?: string,
  named?: Pick<ModelService, 'id' | 'name'>
): { draft: Draft; id: string } {
  const models = draft.settings.models;
  const kept = models.providers.filter((provider) => !(provider.isNew && provider.id === previous));
  // A hand-written entry keeps its id in models.json too: a new provider under it would be refused on save.
  const taken = new Set([...kept.map((provider) => provider.id), ...models.foreign.map((entry) => entry.id)]);
  const id = named ? freeIdFrom(named.id, taken) : providerIdFor(input.baseUrl.trim(), taken);
  const provider = {
    ...blankProvider(id),
    name: named ? named.name : providerNameFor(input.baseUrl.trim(), id),
    api: input.api,
    baseUrl: input.baseUrl.trim(),
    models: [{ ...blankModel(input.model.trim()), name: input.model.trim() }],
  };
  const { [previous ?? '']: _dropped, ...providerKeys } = draft.providerKeys;
  return {
    id,
    draft: {
      ...draft,
      providerKeys: input.key.trim() ? { ...providerKeys, [id]: input.key.trim() } : providerKeys,
      settings: {
        ...draft.settings,
        models: {
          ...models,
          providers: [...kept, provider],
          defaults: { ...models.defaults, provider: id, model: input.model.trim() },
        },
      },
    },
  };
}

/** The draft with a model of an account mu is already signed in to as the startup model. */
export function withSignedInModel(draft: Draft, provider: string, model: string, previous?: string): Draft {
  const models = draft.settings.models;
  const kept = models.providers.filter((entry) => !(entry.isNew && entry.id === previous));
  const { [previous ?? '']: _dropped, ...providerKeys } = draft.providerKeys;
  return {
    ...draft,
    providerKeys,
    settings: {
      ...draft.settings,
      models: { ...models, providers: kept, defaults: { ...models.defaults, provider, model } },
    },
  };
}

/** The permission modes the guide knows how to describe, in the order it shows them. */
export const GUIDE_PERMISSION_MODES = ['jev', 'full', 'ask'] as const;
export type GuidePermissionMode = (typeof GUIDE_PERMISSION_MODES)[number];

/** The permission modes this harness offers that the guide can describe; none when it has no permission modes. */
export function permissionModesOf(settings: KyrnSettings): GuidePermissionMode[] {
  const manifest = settings.harness.status === 'ok' ? settings.harness.manifest : undefined;
  const option = manifest?.features
    .find((feature) => feature.name === 'permissions')
    ?.options.find((entry) => entry.key === 'mode');
  if (!settings.permissions.mode || option?.kind !== 'choice') return [];
  const offered = new Set(option.choices.map((choice) => choice.value));
  return GUIDE_PERMISSION_MODES.filter((mode) => offered.has(mode));
}

/**
 * The settings with `mode` as the permission mode new conversations start in: the permission modes feature's own
 * option, where the settings set it. mu's last pick (from /permissions or a send box) wins over that option, so when
 * there is one it moves along with it; `toSave` writes it then.
 */
export function withPermissionMode(settings: KyrnSettings, mode: string): KyrnSettings {
  const feature = settings.features.permissions;
  return {
    ...settings,
    ...(feature
      ? { features: { ...settings.features, permissions: { ...feature, options: { ...feature.options, mode } } } }
      : {}),
    permissions: { ...settings.permissions, mode },
  };
}

/**
 * What a key check came to, in the words of the key tile. The key works (`ok`, or `empty` when the service lists no
 * model for it), the service answered without a model list (`unlisted`), or why not: the key (`wrongKey`), the
 * account's balance or quota (`quota`), the way there (`unreachable`, `region`), the address (`wrongAddress`), the
 * service itself, busy or in trouble (`down`: try again in a moment). `other` is worded by the connection test's own
 * texts.
 */
export type KeyOutcome =
  | 'ok'
  | 'empty'
  | 'unlisted'
  | 'wrongKey'
  | 'quota'
  | 'unreachable'
  | 'region'
  | 'wrongAddress'
  | 'down'
  | 'other';

// How services word a refusal (their answers seen 2026-09): Google and xAI turn a wrong key down with a 400, SiliconFlow
// an empty account with a 403, OpenAI and Anthropic a region they do not serve with a 403.
const REGION =
  /country, region|unsupported_country|region is not supported|location is not supported|not available in your (country|region)|request not allowed/i;
const QUOTA =
  /insufficient[_ ](balance|quota|funds|credits?)|balance is insufficient|account balance|credit balance|exceeded[_ ](your[_ ])?current[_ ]quota|quota[_ ]exceeded|(no|any) credits|余额|欠费/i;
const WRONG_KEY =
  /(invalid|incorrect|not valid|wrong).{0,20}(api[ _-]?key|token)|(api[ _-]?key|token).{0,20}(invalid|incorrect|not valid)/i;

export function keyOutcome(result: ProviderTestResult): KeyOutcome {
  if (result.ok) return result.models.length || result.code === 'ok-completion' ? 'ok' : 'empty';
  const { code, status, detail } = result;
  if (REGION.test(detail)) return 'region';
  // A 429 alone is too many requests: a model list rarely looks at the balance, so only the words say quota.
  if (status === 402 || QUOTA.test(detail)) return 'quota';
  if (code === 'auth' || (status === 400 && WRONG_KEY.test(detail))) return 'wrongKey';
  if (code === 'network' || code === 'timeout') return 'unreachable';
  // The services' addresses are known to answer: no list there is a service without one, not a wrong address.
  if (code === 'not-found' || status === 405 || status === 501) return 'unlisted';
  if (code === 'redirect' || code === 'invalid-response') return 'wrongAddress';
  if (status === 429 || (status !== undefined && status >= 500)) return 'down';
  return 'other';
}
