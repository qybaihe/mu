/**
 * Model providers as the settings screen edits them. They live in pi's `<agentDir>/models.json`; the startup
 * model and thinking level live in pi's `<agentDir>/settings.json`. API keys never come back from the main process:
 * the screen only learns how a provider's key is configured and whether a value is present.
 */

/** The wire formats pi can speak to a custom provider (`api` in models.json). */
export const ENDPOINT_TYPES = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
] as const;
export type EndpointType = (typeof ENDPOINT_TYPES)[number];

/** pi's thinking levels, weakest first. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * `null` turns a level off. A string is the value sent on the wire
 * (`reasoning.effort`, for OpenAI-compatible APIs).
 */
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

/** `xhigh` and `max` count as supported only when the map names them. The others are on unless mapped to null. */
const EXPLICIT_LEVELS: ReadonlySet<ThinkingLevel> = new Set(['xhigh', 'max']);

/** Known levels only, and only a string or null. Anything else in the file is ignored until the model is rewritten. */
export function readThinkingLevelMap(value: unknown): ThinkingLevelMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const map: ThinkingLevelMap = {};
  for (const level of THINKING_LEVELS) {
    const mapped = record[level];
    if (mapped === null) map[level] = null;
    else if (typeof mapped === 'string') map[level] = mapped;
  }
  return map;
}

/**
 * The map as models.json should store it. A standard level mapped to its own name is the default, so it is left out.
 * An unsupported `xhigh` or `max` (missing or null) is left out too.
 */
export function canonicalThinkingLevelMap(map: ThinkingLevelMap | undefined): ThinkingLevelMap | undefined {
  if (!map) return undefined;
  const next: ThinkingLevelMap = {};
  for (const level of THINKING_LEVELS) {
    const mapped = map[level];
    if (mapped === undefined) continue;
    if (EXPLICIT_LEVELS.has(level)) {
      if (typeof mapped === 'string' && mapped.length > 0) next[level] = mapped;
      continue;
    }
    if (mapped === null) next[level] = null;
    else if (mapped !== level && mapped.length > 0) next[level] = mapped;
  }
  return Object.keys(next).length ? next : undefined;
}

/**
 * Turn one level on or off. Turning it on keeps a wire value that is already a string; otherwise the wire value is
 * the level's own name. The result is the map models.json would store.
 */
export function withThinkingLevel(
  map: ThinkingLevelMap | undefined,
  level: ThinkingLevel,
  on: boolean
): ThinkingLevelMap {
  const next: ThinkingLevelMap = { ...map };
  if (on) {
    if (typeof next[level] !== 'string' || next[level] === '') next[level] = level;
  } else {
    next[level] = null;
  }
  return canonicalThinkingLevelMap(next) ?? {};
}

export type ProviderModel = {
  id: string;
  name: string;
  reasoning: boolean;
  imageInput: boolean;
  contextWindow: number;
  maxTokens: number;
  /**
   * Wire values for the thinking levels. `null` turns a level off. A missing standard level stays on;
   * `xhigh` and `max` stay off until the map names them. The screen edits this; `thinkingLevels` is derived from it.
   */
  thinkingLevelMap: ThinkingLevelMap;
  /** Thinking levels the model takes, from `reasoning` and `thinkingLevelMap`. */
  thinkingLevels: ThinkingLevel[];
};

/**
 * `none`: no key in models.json. `managed`: `"$MU_PROVIDER_<ID>_API_KEY"`, with the value in the harness `.env`,
 * written from this screen. `manual`: anything else a person wrote (a literal, `!command`, another variable):
 * kept as it is and never read back.
 */
export type ProviderKeyState = 'none' | 'managed' | 'manual';

export type ProviderSettings = {
  id: string;
  name: string;
  api: EndpointType;
  baseUrl: string;
  /** Adds `Authorization: Bearer <key>` for proxies that want it on top of the endpoint's own header. */
  authHeader: boolean;
  models: ProviderModel[];
  /** Read-only. */
  key: ProviderKeyState;
  /** Read-only: for `managed`, whether the variable has a value; for `manual`, true. */
  keySet: boolean;
  /** Read-only: names of hand-written extra headers. Their values are secrets and stay in the file. */
  headerNames: string[];
  /**
   * Set by the screen on a provider that was added and not saved yet, whose id can still be typed. The store does
   * not read it: there, a provider is new when models.json has no entry under its id.
   */
  isNew?: boolean;
};

/** An entry of models.json this screen shows but does not edit: an override of a built-in provider, or an unknown `api`. */
export type ForeignProvider = { id: string; name: string; api: string; baseUrl: string; modelCount: number };

export type ModelDefaults = { provider: string; model: string; thinkingLevel: ThinkingLevel | '' };
/** A send box's "make default": the model new sessions start on, and their thinking level when one comes with it. */
export type DefaultModelChange = { provider: string; model: string; thinkingLevel?: ThinkingLevel };

export type ModelsSettings = {
  providers: ProviderSettings[];
  foreign: ForeignProvider[];
  defaults: ModelDefaults;
  /** models.json has comments or trailing commas (pi accepts them). Saving providers would lose them, so it is refused. */
  commented: boolean;
  /** models.json could not be parsed. Providers are then neither shown nor saved. */
  problem: string;
};

/**
 * The thinking levels each model a conversation's session can switch to takes, keyed by the model's
 * `provider/model-id` (the value of the session's `model` option), weakest first. Recorded by the adapter from pi's
 * own model list, so it covers built-in logins and custom providers alike.
 */
export type ModelThinkingLevels = Record<string, ThinkingLevel[]>;

/** What a running mu last reported as usable: built-in logins and custom providers alike. A snapshot, not live. */
export type AvailableModels = {
  providers: { id: string; models: { id: string; name: string }[] }[];
  thinkingLevels: string[];
};

export type ProviderTestInput = {
  id: string;
  api: EndpointType;
  baseUrl: string;
  authHeader: boolean;
  /** Used for the one-token request when the endpoint has no model list. */
  model: string;
  /** A key typed but not saved yet. Without it the saved key is used, and only against the saved base URL. */
  apiKey?: string;
};

export type ProviderTestCode =
  | 'ok-models'
  | 'ok-completion'
  | 'auth'
  | 'not-found'
  | 'http'
  | 'timeout'
  | 'network'
  | 'redirect'
  | 'invalid-response'
  | 'key-unavailable'
  | 'url-changed';

export type ProviderTestResult = {
  ok: boolean;
  code: ProviderTestCode;
  status?: number;
  latencyMs: number;
  /** Model ids the endpoint listed, for filling in the model table. */
  models: string[];
  /** A short message from the endpoint, with the key removed. */
  detail: string;
};

/** New provider ids: a slug, so the id maps to exactly one credential variable. */
export const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * pi's built-in providers (its `packages/ai/src/providers`, 2026-09). A models.json entry under one of these ids
 * is not a new provider: it reroutes the built-in one and merges into its models. So a new provider may not take
 * such an id. The list can lag behind pi; the screen also refuses ids the running mu reports.
 */
export const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set(
  (
    'amazon-bedrock ant-ling anthropic azure-openai-responses baseten cerebras cloudflare-ai-gateway ' +
    'cloudflare-workers-ai deepseek fireworks github-copilot google-vertex google groq huggingface kimi-coding ' +
    'minimax-cn minimax mistral moonshotai-cn moonshotai nvidia openai-codex openai opencode-go opencode openrouter ' +
    'qwen-token-plan-cn qwen-token-plan-individual qwen-token-plan radius together vercel-ai-gateway xai ' +
    'xiaomi-token-plan-ams xiaomi-token-plan-cn xiaomi-token-plan-sgp xiaomi zai-coding-cn zai llama-cpp'
  ).split(' ')
);

/**
 * What pi's built-in providers are called, by id: the names their makers use, so a menu reads "Vercel AI Gateway", not
 * `vercel-ai-gateway`. Brands are not translated; a region shows as its code. A subscription goes by its product
 * instead (ChatGPT for `openai-codex`), from the sign-in screens' words; an id missing here is shown as it is.
 */
export const BUILTIN_PROVIDER_NAMES: Readonly<Record<string, string>> = {
  'amazon-bedrock': 'Amazon Bedrock',
  'ant-ling': 'Ant Ling',
  anthropic: 'Anthropic',
  'azure-openai-responses': 'Azure OpenAI',
  baseten: 'Baseten',
  cerebras: 'Cerebras',
  'cloudflare-ai-gateway': 'Cloudflare AI Gateway',
  'cloudflare-workers-ai': 'Cloudflare Workers AI',
  deepseek: 'DeepSeek',
  fireworks: 'Fireworks',
  'github-copilot': 'GitHub Copilot',
  'google-vertex': 'Google Vertex AI',
  google: 'Google Gemini',
  groq: 'Groq',
  huggingface: 'Hugging Face',
  'kimi-coding': 'Kimi Coding',
  'minimax-cn': 'MiniMax CN',
  minimax: 'MiniMax',
  mistral: 'Mistral',
  'moonshotai-cn': 'Moonshot AI CN',
  moonshotai: 'Moonshot AI',
  nvidia: 'NVIDIA',
  'openai-codex': 'OpenAI Codex',
  openai: 'OpenAI',
  'opencode-go': 'OpenCode Go',
  opencode: 'OpenCode',
  openrouter: 'OpenRouter',
  'qwen-token-plan-cn': 'Qwen Token Plan CN',
  'qwen-token-plan-individual': 'Qwen Token Plan Individual',
  'qwen-token-plan': 'Qwen Token Plan',
  radius: 'Radius',
  together: 'Together AI',
  'vercel-ai-gateway': 'Vercel AI Gateway',
  xai: 'xAI',
  'xiaomi-token-plan-ams': 'Xiaomi Token Plan AMS',
  'xiaomi-token-plan-cn': 'Xiaomi Token Plan CN',
  'xiaomi-token-plan-sgp': 'Xiaomi Token Plan SGP',
  xiaomi: 'Xiaomi MiMo',
  'zai-coding-cn': 'Z.ai Coding CN',
  zai: 'Z.ai',
  'llama-cpp': 'llama.cpp',
};

/**
 * Built-in providers pi reports as usable that nobody set up to talk to. The judge (Jev) takes its key from
 * `AI_GATEWAY_API_KEY`, which is also the variable pi reads for the Vercel AI Gateway, so with the judge set up that
 * way pi lists the gateway and its models. The key has to stay (the judge needs it), so the app does not offer the
 * gateway: not as another built-in provider, not as a model to start with or switch to.
 */
export const UNOFFERED_PROVIDER_IDS: ReadonlySet<string> = new Set(['vercel-ai-gateway']);

/** The credential variable of a provider: `my-proxy` -> `MU_PROVIDER_MY_PROXY_API_KEY`. */
export function providerKeyVariable(id: string): string {
  return `MU_PROVIDER_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

/**
 * pi's rule (`getSupportedThinkingLevels`): a model without reasoning only takes `off`; a level mapped to null is
 * not supported; `xhigh` and `max` only when the map names them.
 */
export function supportedThinkingLevels(reasoning: boolean, map?: Record<string, unknown>): ThinkingLevel[] {
  if (!reasoning) return ['off'];
  return THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return typeof mapped === 'string';
    return true;
  });
}

/** Turns a display name into an id suggestion: "My Proxy (EU)" -> "my-proxy-eu". */
export function suggestProviderId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * The rule for every address this app sends a key to: HTTPS, or plain HTTP to this machine or a private-network
 * address, and nothing that smuggles a credential or a second destination. Shared by the store (which enforces it)
 * and the screen (which explains it).
 *
 * Private-network HTTP is a literal address only (10/8, 172.16/12, 192.168/16, IPv6 unique-local fc00::/7, and an
 * IPv4-mapped form of those). A name is not accepted over HTTP: this check does not resolve DNS.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function ipv4Private(octets: readonly number[]): boolean {
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function parseIpv4(text: string): number[] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!match) return undefined;
  return match.slice(1).map((part) => Number(part));
}

/** Eight groups of an IPv6 literal, or undefined when `address` is not one. Brackets already removed. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address;
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const octets = parseIpv4(dotted[2]);
    if (!octets || octets.some((n) => n > 255)) return undefined;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    text = dotted[1] + high + ':' + low;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const group = /^[0-9a-f]{1,4}$/;
  if (head.some((part) => !group.test(part)) || tail.some((part) => !group.test(part))) return undefined;
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined;
  const all = [...head, ...Array<string>(fill).fill('0'), ...tail].map((part) => Number.parseInt(part, 16));
  return all.length === 8 ? all : undefined;
}

/** A literal private-network host: RFC1918, IPv6 unique-local, or an IPv4-mapped form of either. */
export function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host.includes('%')) return false;
  const v4 = parseIpv4(host);
  if (v4) return ipv4Private(v4);
  const parts = ipv6Groups(host);
  if (!parts) return false;
  const zeroPrefix = parts.slice(0, 5).every((part) => part === 0);
  if (zeroPrefix && parts[5] === 0xffff) {
    return ipv4Private([parts[6] >> 8, parts[6] & 0xff, parts[7] >> 8, parts[7] & 0xff]);
  }
  return (parts[0] & 0xfe00) === 0xfc00;
}

export function isSafeEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const httpAllowed =
    url.protocol === 'http:' && (LOOPBACK_HOSTS.has(url.hostname) || isPrivateNetworkHost(url.hostname));
  return !url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || httpAllowed);
}
