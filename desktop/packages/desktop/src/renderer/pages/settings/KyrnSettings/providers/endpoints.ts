import {
  ENDPOINT_TYPES,
  PROVIDER_ID,
  RESERVED_PROVIDER_IDS,
  isSafeEndpoint,
  supportedThinkingLevels,
  type EndpointType,
  type ListedModel,
  type ModelsSettings,
  type ProviderModel,
  type ProviderSettings,
} from '@/common/kyrn/models';
import { providerDisplayName } from '@/renderer/utils/model/providerName';

/** What a base URL of each wire format looks like. Anthropic clients add `/v1` themselves; the others expect it given. */
export const ENDPOINT_PLACEHOLDER: Record<EndpointType, string> = {
  'openai-completions': 'https://api.example.com/v1',
  'openai-responses': 'https://api.example.com/v1',
  'anthropic-messages': 'https://api.example.com',
  'google-generative-ai': 'https://generativelanguage.googleapis.com/v1beta',
};

export const blankModel = (id = ''): ProviderModel => ({
  id,
  name: '',
  reasoning: false,
  imageInput: false,
  contextWindow: 128000,
  maxTokens: 16384,
  thinkingLevelMap: {},
  thinkingLevels: ['off'],
});

/**
 * A new model row for a model an endpoint listed: what the list stated about it (#23), the defaults for the rest. A
 * model the list says thinks offers the thinking levels a thinking model does.
 */
export function listedModel(id: string, facts: ListedModel = {}): ProviderModel {
  const model = { ...blankModel(id), ...facts };
  return { ...model, thinkingLevels: supportedThinkingLevels(model.reasoning, model.thinkingLevelMap) };
}

export const blankProvider = (id: string): ProviderSettings => ({
  id,
  name: '',
  api: 'openai-completions',
  baseUrl: '',
  authHeader: false,
  models: [],
  key: 'none',
  keySet: false,
  headerNames: [],
  isNew: true,
});

/**
 * The API format an add-provider link means by its `platform`: one of the formats by name, else the vendor whose format
 * it is, else OpenAI compatible, which is what one-api style links (`new-api`, `one-api`, `openai`) point at.
 */
export function endpointOfLink(platform = ''): EndpointType {
  const name = platform.trim().toLowerCase();
  const known = ENDPOINT_TYPES.find((type) => type === name);
  if (known) return known;
  if (/anthropic|claude/.test(name)) return 'anthropic-messages';
  if (/gemini|google/.test(name)) return 'google-generative-ai';
  return 'openai-completions';
}

/**
 * What a custom provider is called on screen: its name, else its id. A new one with no name yet is a "new provider"
 * in the reader's language rather than the placeholder id it was given (`custom`, which is English).
 */
export const customProviderName = (t: (key: string) => string, provider: ProviderSettings): string =>
  provider.name || (provider.isNew ? t('mu.providers.new') : provider.id);

/**
 * A provider by the name it goes by in these settings: a custom provider's own, a hand-written entry's, a
 * subscription's (ChatGPT for `openai-codex`), a built-in provider's (Vercel AI Gateway), or else its id.
 */
export function providerLabel(
  t: (key: string) => string,
  models: Pick<ModelsSettings, 'providers' | 'foreign'>,
  id: string
): string {
  const own = models.providers.find((provider) => provider.id === id);
  if (own) return customProviderName(t, own);
  const entry = models.foreign.find((candidate) => candidate.id === id);
  if (entry?.name) return entry.name;
  return providerDisplayName(t, id);
}

/** A free id of the form `custom`, `custom-2`, …: a new provider needs one before it has a name. */
export function freeProviderId(taken: Set<string>): string {
  for (let n = 1; ; n += 1) {
    const id = n === 1 ? 'custom' : `custom-${n}`;
    if (!taken.has(id)) return id;
  }
}

export type ProviderProblems = {
  id?: 'format' | 'reserved' | 'taken';
  baseUrl?: 'empty' | 'unsafe';
  models?: 'emptyId' | 'duplicate';
};

/** The same rules the store enforces, checked while typing so the reason is next to the field. */
export function providerProblems(provider: ProviderSettings, isNew: boolean, others: Set<string>): ProviderProblems {
  const problems: ProviderProblems = {};
  if (isNew) {
    if (!PROVIDER_ID.test(provider.id)) problems.id = 'format';
    else if (RESERVED_PROVIDER_IDS.has(provider.id)) problems.id = 'reserved';
    else if (others.has(provider.id)) problems.id = 'taken';
  }
  if (!provider.baseUrl.trim()) problems.baseUrl = 'empty';
  else if (!isSafeEndpoint(provider.baseUrl)) problems.baseUrl = 'unsafe';
  const ids = provider.models.map((model) => model.id.trim());
  if (ids.some((id) => !id)) problems.models = 'emptyId';
  else if (new Set(ids).size !== ids.length) problems.models = 'duplicate';
  return problems;
}

/** `openai-completions` -> `openaiCompletions`: wire names and result codes as i18n key segments. */
export const camel = (code: string): string =>
  code.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
