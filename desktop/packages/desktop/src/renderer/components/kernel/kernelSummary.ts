/**
 * What the kernel bar and the home page say about the judgment kernel, read from mu's settings: which judge answers,
 * through which service, and how many decision points act on its verdicts.
 */
import type { DecisionMode } from '@/common/kyrn/manifest';
import type { KyrnSettings } from '@/common/kyrn/types';

export type KernelSummary = {
  /** The judge's name: "Jev", "Laya", or a model id. */
  judge: string;
  /** Where it runs: a service name, "local", or '' when there is nothing to add. */
  via: string;
  /** The free Jev on OpenCode Zen answers because no key is set. */
  free: boolean;
  /** How many more judges follow the first in the cascade. */
  fallbacks: number;
  /** The default mode of every decision point. */
  mode: DecisionMode;
  /** Decision points whose verdicts change what happens: active, with their feature on. */
  active: number;
  /** Decision points that only record (shadow). */
  shadow: number;
  /** Decision points the harness has. */
  total: number;
};

/** The Jev services in the order mu tries them when a tier is plain `jev`, each with the keys it needs. */
const JEV_SERVICES: ReadonlyArray<{ via: string; keys: readonly string[] }> = [
  { via: 'TypeSafe', keys: ['TYPESAFE_API_KEY'] },
  { via: 'OpenRouter', keys: ['MU_JUDGE_OPENROUTER_API_KEY'] },
  { via: 'Vercel AI Gateway', keys: ['AI_GATEWAY_API_KEY'] },
  { via: 'OpenCode Zen', keys: ['OPENCODE_API_KEY'] },
  { via: 'Cloudflare', keys: ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID'] },
];

const NAMED_JEV: Record<string, string> = {
  'jev-direct': 'TypeSafe',
  'jev-openrouter': 'OpenRouter',
  'jev-gateway': 'Vercel AI Gateway',
  'jev-opencode': 'OpenCode Zen',
  'jev-cloudflare': 'Cloudflare',
};

/** The judge and service a tier id names. */
export function describeTier(
  tier: string,
  keys: Record<string, boolean>
): Pick<KernelSummary, 'judge' | 'via' | 'free'> {
  if (tier === 'jev') {
    const service = JEV_SERVICES.find((entry) => entry.keys.every((key) => keys[key]));
    return service
      ? { judge: 'Jev', via: service.via, free: false }
      : { judge: 'Jev', via: 'OpenCode Zen', free: true };
  }
  if (tier === 'jev-opencode-free') return { judge: 'Jev', via: 'OpenCode Zen', free: true };
  if (NAMED_JEV[tier]) return { judge: 'Jev', via: NAMED_JEV[tier], free: false };
  if (tier === 'laya') return { judge: 'Laya', via: 'local', free: false };
  if (tier === 'clef' || tier === 'clef-flash')
    return { judge: tier === 'clef' ? 'Clef' : 'Clef Flash', via: 'Cloudflare', free: false };
  if (tier === 'mock') return { judge: 'Mock judge', via: '', free: false };
  const model = /^(?:classifier|llm):(?:[^/]+\/)?(.+)$/.exec(tier);
  if (model) return { judge: model[1], via: '', free: false };
  return { judge: tier, via: '', free: false };
}

export function summarize(settings: KyrnSettings): KernelSummary {
  const tiers = settings.tiers.length > 0 ? settings.tiers : ['jev'];
  const first = describeTier(tiers[0], settings.keys);
  const decisions = settings.harness.status === 'ok' ? settings.harness.manifest.decisions : [];
  let active = 0;
  let shadow = 0;
  for (const decision of decisions) {
    const feature = decision.feature ? settings.features[decision.feature] : undefined;
    if (feature && !feature.enabled) continue;
    const mode = settings.decisionModes[decision.id] ?? settings.mode;
    if (mode === 'active') active += 1;
    else if (mode === 'shadow') shadow += 1;
  }
  return { ...first, fallbacks: tiers.length - 1, mode: settings.mode, active, shadow, total: decisions.length };
}
