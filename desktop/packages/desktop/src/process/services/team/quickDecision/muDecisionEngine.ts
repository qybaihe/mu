/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The MU decision engine, process side: the two-tier ask under the service's
 * cache and delivery. L1 is `typesafe/jev-1.13` over treg's System One
 * decide endpoint, gated on `probabilities[choice]` (muEngineCore); L2 is
 * the mu agent runtime's own judge — `~/.mu/agent/mu.json` tiers, first
 * `llm` entry, key from `~/.mu/agent/auth.json`, called with thinking
 * disabled because the zai coding endpoint thinks by default and a thinking
 * L2 cannot fit the ceiling. Both arms are optional: a missing treg token
 * degrades to L2-only, a missing judge to L1+full, and every failure at
 * either tier escalates or answers `full` — the engine may save a round,
 * never spend the send. Secrets are read once per process, live in memory
 * only and never reach the settings store, a file of ours, or a log line.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OpenAIRotatingClient } from '@/common/api/OpenAIRotatingClient';
import { ClientFactory } from '@/common/api/ClientFactory';
import type { TProviderWithModel } from '@/common/config/storage';
import type { PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import type { SupervisorTeam } from '@/common/chat/team/supervisor/supervisorCore';
import type { QuickDecisionKind } from '@/common/chat/team/quickDecision/quickDecisionCore';
import {
  buildPositionDomainAsk,
  buildSupervisorReuseAsk,
  choicesOfAsk,
  jevChoiceToDecisionJson,
  jevGate,
  JEV_MODEL_LABEL,
  MU_ENGINE_ESCALATE_PROBABILITY,
  parseJevChoice,
  sanitizeEngineState,
  type MuEngineAskPayload,
} from '@/common/chat/team/quickDecision/muEngineCore';

/** treg's System One decide endpoint; the token rides the `x-treg-token` header. */
const TREG_DECIDE_URL = 'https://treg.to/call/openrouter.ai-judge.decide';
const TREG_MODEL = 'typesafe/jev-1.13';

/** decision-rsi-kernel's apis.env — TREG_TOKEN's authoritative store; the env override mirrors the kernel's own names. */
const apisEnvPath = (): string => process.env.DECISION_RSI_APIS_ENV || join(homedir(), '.agents', 'apis.env');

/** The mu agent runtime's config dir, where the judge tiers and their keys live. */
const muAgentConfigDir = (): string => join(homedir(), '.mu', 'agent');

/**
 * OpenAI-compatible endpoints of the providers `mu.json` tiers may name.
 * The desktop knows no pi provider catalog; a tier naming an unknown
 * provider simply leaves L2 unavailable (L1 and the full flow stand).
 */
const JUDGE_ENDPOINTS: Record<string, string> = {
  'zai-coding-cn': 'https://open.bigmodel.cn/api/coding/paas/v4',
};

/** The L2 judge as the bridge resolved it: everything one completion needs, in memory only. */
export type MuEngineLlmJudge = { providerId: string; model: string; baseUrl: string; apiKey: string };

/** What the engine found on disk: either arm may be absent, and absence only narrows the chain. */
export type MuEngineSecrets = { tregToken?: string; judge?: MuEngineLlmJudge };

const readJsonFile = (path: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined; // An unreadable config is an unavailable arm, not an error surface.
  }
};

/** The treg token out of apis.env, or undefined — quotes stripped, exactly the kernel's parse. */
const tregTokenFromEnvFile = (path: string): string | undefined => {
  try {
    const match = readFileSync(path, 'utf8').match(/^TREG_TOKEN\s*=\s*(.+)\s*$/m);
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : undefined;
  } catch {
    return undefined;
  }
};

/** The first `llm` tier of mu.json as a callable judge, or undefined when no known provider backs it. */
const judgeFromMuConfig = (): MuEngineLlmJudge | undefined => {
  const config = readJsonFile(join(muAgentConfigDir(), 'mu.json'));
  const tiers = config?.tiers;
  const judges = config?.judges;
  if (!Array.isArray(tiers) || typeof judges !== 'object' || judges === null) return undefined;
  for (const tier of tiers) {
    if (typeof tier !== 'string') continue;
    const judge = (judges as Record<string, unknown>)[tier];
    if (typeof judge !== 'object' || judge === null) continue;
    const record = judge as Record<string, unknown>;
    if (record.type !== 'llm' || typeof record.model !== 'string') continue;
    const separator = record.model.indexOf('/');
    if (separator <= 0) continue;
    const providerId = record.model.slice(0, separator);
    const model = record.model.slice(separator + 1);
    const baseUrl = JUDGE_ENDPOINTS[providerId];
    if (!baseUrl) continue;
    const auth = readJsonFile(join(muAgentConfigDir(), 'auth.json'))?.[providerId];
    const apiKey =
      typeof auth === 'object' && auth !== null && typeof (auth as Record<string, unknown>).key === 'string'
        ? ((auth as Record<string, unknown>).key as string)
        : undefined;
    if (!apiKey) continue;
    return { providerId, model, baseUrl, apiKey };
  }
  return undefined;
};

/** Reads both arms once; memoized so the process pays the file reads a single time. */
const loadMuEngineSecrets = (): MuEngineSecrets => ({
  tregToken: tregTokenFromEnvFile(apisEnvPath()),
  judge: judgeFromMuConfig(),
});

let secretsMemo: MuEngineSecrets | undefined;
const muEngineSecrets = (): MuEngineSecrets => (secretsMemo ??= loadMuEngineSecrets());

/**
 * Parses the engine's secrets at main-process startup, before any send
 * needs them, and says in one log line what the chain will run without —
 * the degradation note the operator would otherwise have to discover.
 * Never logs the secrets themselves.
 */
export const warmMuEngineSecrets = (log: (...args: unknown[]) => void): void => {
  const secrets = muEngineSecrets();
  if (!secrets.tregToken)
    log('[quickDecision] engine degraded: no TREG_TOKEN in apis.env, L1 (jev) off — L2 + full remain');
  if (!secrets.judge)
    log('[quickDecision] engine degraded: no callable mu.json llm tier, L2 (glm) off — L1 + full remain');
};

/** One L1 call on the already-sanitized payload; throws on HTTP error, malformed answers or timeout — every throw is the caller's escalate. */
export async function callJevOnTreg(token: string, payload: MuEngineAskPayload, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(TREG_DECIDE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-treg-token': token },
      body: JSON.stringify({ model: TREG_MODEL, state: payload.state, questions: payload.questions }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`treg http ${response.status}`);
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || typeof (body as Record<string, unknown>).answers !== 'object') {
      throw new Error('treg malformed answers');
    }
    return (body as Record<string, unknown>).answers;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One L2 completion under the ceiling. The judge provider rides the same
 * rotating-client machinery as the configured quick-decision model, plus the
 * zai `thinking: {type: "disabled"}` body field — the coding endpoint thinks
 * by default and a thinking L2 cannot fit the 2s ceiling (the runtime's own
 * `thinking: "off"` tier config says the same; the body field is how the
 * shipped adapters land it). The AbortController plus the race is the same
 * double ceiling the provider path uses: adapters that never see the signal
 * still lose the race within `timeoutMs`.
 */
export async function completeEngineJudge(
  judge: MuEngineLlmJudge,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  timeoutMs: number
): Promise<string> {
  const provider: TProviderWithModel = {
    id: `mu-engine-${judge.providerId}`,
    platform: judge.providerId,
    name: 'MU decision engine judge',
    base_url: judge.baseUrl,
    api_key: judge.apiKey,
    use_model: judge.model,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // The endpoints table lists OpenAI-compatible providers only, so the
    // factory returns the OpenAI rotating client; the cast says what the
    // table already guarantees.
    const client = (await ClientFactory.createRotatingClient(provider, {
      rotatingOptions: { maxRetries: 1 }, // One attempt: the ceiling is ours, not the adapter's.
    })) as OpenAIRotatingClient;
    // The OpenAI SDK passes unknown body fields through; the cast adds the
    // zai thinking switch the params type does not model.
    const params = {
      model: judge.model,
      messages,
      thinking: { type: 'disabled' },
    } as Parameters<OpenAIRotatingClient['createChatCompletion']>[0] & { thinking?: { type: 'disabled' } };
    const completion = await Promise.race([
      client.createChatCompletion(params, { signal: controller.signal, timeout: timeoutMs }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('quick-decision-timeout')), timeoutMs);
      }),
    ]);
    return completion.choices[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}

/** Everything injectable, so tests run no HTTP, no model and no disk. */
export type MuEngineDeps = {
  loadSecrets: () => MuEngineSecrets;
  /** One L1 call on the sanitized payload; throws on HTTP error, malformed answers or timeout. */
  callJev: (token: string, payload: MuEngineAskPayload, timeoutMs: number) => Promise<unknown>;
  completeJudge: (
    judge: MuEngineLlmJudge,
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    timeoutMs: number
  ) => Promise<string>;
  log: (...args: unknown[]) => void;
};

/** The context both tiers judge: the same facts the L2 prompt lists. */
export type MuEngineContext = {
  task: string;
  teams: readonly SupervisorTeam[];
  roster: readonly PositionInfo[];
  position?: Pick<PositionInfo, 'name' | 'displayName' | 'description' | 'body'>;
};

/** One engine ask's outcome: the raw decision JSON (the service's strict parsers finish it) plus the observability basis. */
export type MuEngineAskOutcome =
  | { ok: true; raw: string; tier: 'L1' | 'L2'; model: string; probability?: number }
  | { ok: false; reason: string };

/**
 * The two-tier chain. L1 answers decisively at probability ≥0.85, escalates
 * to L2 between 0.5 and 0.85 (and on any failure or timeout — L1 may be
 * wrong, never blocking), and reads `full` outright below 0.5. L2 answers
 * with the ordinary judgment prompt and its own strict parse downstream; an
 * unavailable L2 turns every would-be escalation into `full`. The `ok: false`
 * outcomes (and only they) are the full-flow answers, so the caller counts
 * them as fallbacks exactly like a provider-path failure.
 */
export async function askMuEngine(
  deps: MuEngineDeps,
  kind: QuickDecisionKind,
  context: MuEngineContext,
  prompt: { system: string; user: string },
  timeoutMs: number
): Promise<MuEngineAskOutcome> {
  const secrets = deps.loadSecrets();

  // ---- L1: jev over treg, gated on probabilities[choice] ----
  if (secrets.tregToken) {
    const payload =
      kind === 'supervisor-reuse'
        ? buildSupervisorReuseAsk(context)
        : // The service already answered `unknown-position` before asking when the marker names no roster row.
          buildPositionDomainAsk({ ...context, position: context.position! });
    try {
      // The privacy gate before anything leaves the machine: state sanitized
      // here — the policy layer — so every transport carries the redacted form.
      const answers = await deps.callJev(
        secrets.tregToken,
        { state: sanitizeEngineState(payload.state), questions: payload.questions },
        timeoutMs
      );
      const verdict = parseJevChoice(
        typeof answers === 'object' && answers !== null ? (answers as Record<string, unknown>).q : undefined,
        choicesOfAsk(payload)
      );
      if (verdict === undefined) {
        deps.log(`[quickDecision] engine L1 jev: no usable probabilities[choice], escalating to L2`);
      } else {
        const gate = jevGate(verdict.probability);
        if (gate === 'full') {
          deps.log(
            `[quickDecision] engine L1 jev: probability ${verdict.probability.toFixed(2)} < ${MU_ENGINE_ESCALATE_PROBABILITY} → full`
          );
          return { ok: false, reason: 'jev-low-probability' };
        }
        if (gate === 'escalate') {
          deps.log(`[quickDecision] engine L1 jev: probability ${verdict.probability.toFixed(2)} in [0.5, 0.85) → L2`);
        } else {
          const raw = jevChoiceToDecisionJson(kind, verdict.choice, verdict.probability);
          if (raw !== undefined) {
            deps.log(
              `[quickDecision] engine L1 jev: choice=${verdict.choice} probability=${verdict.probability.toFixed(2)} → short-circuit`
            );
            return { ok: true, raw, tier: 'L1', model: JEV_MODEL_LABEL, probability: verdict.probability };
          }
          deps.log(
            `[quickDecision] engine L1 jev: choice ${verdict.choice} names no ${kind} verdict, escalating to L2`
          );
        }
      }
    } catch (error) {
      const text = String(error);
      const reason =
        text.toLowerCase().includes('timeout') || text.toLowerCase().includes('abort') ? 'timeout' : 'error';
      deps.log(`[quickDecision] engine L1 jev ${reason}, escalating to L2: ${text.slice(0, 140)}`);
    }
  }

  // ---- L2: the runtime's own judge (glm-flash, thinking off), the accuracy tier ----
  if (!secrets.judge) {
    deps.log('[quickDecision] engine L2 unavailable: no callable mu.json llm tier → full');
    return { ok: false, reason: 'engine-judge-unavailable' };
  }
  try {
    const raw = await deps.completeJudge(
      secrets.judge,
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      timeoutMs
    );
    return { ok: true, raw, tier: 'L2', model: secrets.judge.model };
  } catch (error) {
    const text = String(error);
    const reason =
      text.toLowerCase().includes('timeout') || text.toLowerCase().includes('abort') ? 'timeout' : 'model-error';
    deps.log(`[quickDecision] engine L2 ${reason}: ${text.slice(0, 140)}`);
    return { ok: false, reason: `l2-${reason}` };
  }
}

/** The production wiring: the memoized disk secrets and the two real transports. */
export const prodMuEngineDeps = (): MuEngineDeps => ({
  loadSecrets: muEngineSecrets,
  callJev: callJevOnTreg,
  completeJudge: completeEngineJudge,
  log: (...args) => console.log(...args),
});
