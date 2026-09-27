import type { EndpointType } from '@/common/kyrn/models';

/**
 * The services someone connects with nothing but an API key. The first-run guide recognises the service by the shape
 * of the key, checks the key with one model-list request to that service alone, and starts on a model from what the
 * service lists. The same table as the CLI's `mu setup`: keep the two alike.
 */
export const SERVICE_IDS = [
  'deepseek',
  'qwen',
  'kimi',
  'glm',
  'siliconflow',
  'stepfun',
  'openrouter',
  'openai',
  'anthropic',
  'google',
  'xai',
  'ollama',
] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];

export type ModelService = {
  id: ServiceId;
  /** The name as the vendor writes it: the provider's name once added. The app's words around it are i18n's. */
  name: string;
  /**
   * Where the service answers. A vendor with a second region lists its address after the first: a key made in one
   * region works only there, so a key the first address turns down is tried at the next one, of the same vendor.
   */
  baseUrls: readonly [string, ...string[]];
  api: EndpointType;
  /**
   * The model to start with: the first of these the service lists, where `name*` is the newest listed id that starts
   * with `name`. When none of them is listed, the service's first listed model.
   */
  models: readonly string[];
  /** What its keys look like. Without one the service is only chosen by name. */
  keyShape?: RegExp;
  /** Where a key is made: the vendor's console page. */
  keyPage?: string;
  /** A service on this machine, which needs no key. */
  keyless?: boolean;
  /** Its model list answers any key, a wrong one too (seen 2026-09-27): it shows the service is there, not the key. */
  openList?: boolean;
};

export const MODEL_SERVICES: readonly ModelService[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrls: ['https://api.deepseek.com'],
    api: 'openai-completions',
    models: ['deepseek-v4-pro', 'deepseek-chat'],
    keyShape: /^sk-[0-9a-f]{32}$/,
    keyPage: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'qwen',
    name: 'Qwen',
    baseUrls: ['https://dashscope.aliyuncs.com/compatible-mode/v1'],
    api: 'openai-completions',
    models: ['qwen3-coder-plus', 'qwen3-max', 'qwen-plus'],
    // The same shape as DeepSeek's: such a key is asked about, never tried on both.
    keyShape: /^sk-[0-9a-f]{32}$/,
    keyPage: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key',
  },
  {
    id: 'kimi',
    name: 'Kimi',
    baseUrls: ['https://api.moonshot.cn/v1', 'https://api.moonshot.ai/v1'],
    api: 'openai-completions',
    models: ['kimi-k2.6'],
    // 48 letters and digits, but not SiliconFlow's 48 lowercase letters nor an OpenAI key (its T3BlbkFJ).
    keyShape: /^sk-(?![a-z]{48}$)(?![A-Za-z0-9]*T3BlbkFJ)[A-Za-z0-9]{48}$/,
    // platform.moonshot.cn/console/api-keys redirects here.
    keyPage: 'https://platform.kimi.com/console/api-keys',
  },
  {
    id: 'glm',
    name: 'GLM',
    baseUrls: ['https://open.bigmodel.cn/api/paas/v4'],
    api: 'openai-completions',
    models: ['glm-*'],
    keyShape: /^[0-9a-f]{32}\.[A-Za-z0-9]{16}$/,
    keyPage: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    baseUrls: ['https://api.siliconflow.cn/v1'],
    api: 'openai-completions',
    models: ['deepseek-ai/DeepSeek-V3*', 'moonshotai/Kimi-K2*', 'Qwen/Qwen3-Coder*'],
    keyShape: /^sk-[a-z]{48}$/,
    keyPage: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'stepfun',
    name: 'StepFun',
    baseUrls: ['https://api.stepfun.com/v1'],
    api: 'openai-completions',
    models: ['step-*'],
    keyPage: 'https://platform.stepfun.com/interface-key',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrls: ['https://openrouter.ai/api/v1'],
    api: 'openai-completions',
    models: ['moonshotai/kimi-k2.6'],
    keyShape: /^sk-or-/,
    keyPage: 'https://openrouter.ai/keys',
    openList: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrls: ['https://api.openai.com/v1'],
    api: 'openai-responses',
    models: ['gpt-5.5'],
    keyShape: /^sk-(?:proj-|svcacct-|admin-|(?!ant-|or-)[A-Za-z0-9_-]*T3BlbkFJ)/,
    keyPage: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrls: ['https://api.anthropic.com'],
    api: 'anthropic-messages',
    models: ['claude-opus-4-8'],
    keyShape: /^sk-ant-/,
    // console.anthropic.com/settings/keys redirects here.
    keyPage: 'https://platform.claude.com/settings/keys',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    baseUrls: ['https://generativelanguage.googleapis.com/v1beta'],
    api: 'google-generative-ai',
    models: ['gemini-3.1-pro-preview'],
    keyShape: /^AIza[0-9A-Za-z_-]{35}$/,
    keyPage: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'xai',
    name: 'xAI',
    baseUrls: ['https://api.x.ai/v1'],
    api: 'openai-completions',
    models: ['grok-4.7'],
    keyShape: /^xai-/,
    keyPage: 'https://console.x.ai',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    baseUrls: ['http://localhost:11434/v1'],
    api: 'openai-completions',
    models: [],
    keyless: true,
  },
];

export const isServiceId = (value: unknown): value is ServiceId => (SERVICE_IDS as readonly unknown[]).includes(value);

export const serviceById = (id: ServiceId): ModelService =>
  MODEL_SERVICES.find((service) => service.id === id) ?? MODEL_SERVICES[0];

/**
 * The services a key has the shape of, in the table's order: none for a key no shape fits, two for a key that fits
 * two vendors alike (`sk-` and 32 hex digits: DeepSeek or Qwen). Such a key is sent nowhere until the person says
 * which service it is from.
 */
export function servicesForKey(key: string): ModelService[] {
  const typed = key.trim();
  return typed ? MODEL_SERVICES.filter((service) => service.keyShape?.test(typed)) : [];
}

/** The version an id carries: its first run of digits and dots, `glm-4.6-air` -> [4, 6]; none: []. */
function versionOf(id: string): number[] {
  const found = /\d+(?:\.\d+)*/.exec(id);
  return found ? found[0].split('.').map(Number) : [];
}

/** Newer first: the higher version (4.6 before 4.5, 5 before 4.6, 4.5 before 4), then the plainer, shorter id. */
function newerFirst(a: string, b: string): number {
  const [x, y] = [versionOf(a), versionOf(b)];
  for (let part = 0; part < Math.max(x.length, y.length); part += 1) {
    if (x[part] === undefined) return 1;
    if (y[part] === undefined) return -1;
    if (x[part] !== y[part]) return y[part] - x[part];
  }
  return a.length - b.length;
}

/** The model a service starts with, from the ids it listed (see {@link ModelService.models}); none when it listed none. */
export function startModel(service: ModelService, listed: readonly string[]): string | undefined {
  for (const wanted of service.models) {
    if (!wanted.endsWith('*')) {
      if (listed.includes(wanted)) return wanted;
      continue;
    }
    const prefix = wanted.slice(0, -1);
    const newest = listed.filter((id) => id.startsWith(prefix)).toSorted(newerFirst)[0];
    if (newest) return newest;
  }
  return listed[0];
}

/** The model a service is known to start with when it lists none: its first model named in full, or none. */
export const namedModel = (service: ModelService): string | undefined =>
  service.models.find((wanted) => !wanted.endsWith('*'));
