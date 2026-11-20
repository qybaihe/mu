/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The quick-decision layer on the main-process side: the cheap source that
 * answers, before any full model round starts, whether the supervisor may
 * reuse an active team (point A) and whether a task is clearly outside a
 * position's domain (point B). The source is one of two shapes: a
 * configured provider model, or the MU decision engine — L1 jev over treg
 * gated on `probabilities[choice]`, escalating to L2 (the runtime's own
 * glm-flash judge, thinking off), every remaining doubt `full`. One `route`
 * call is one whole attempt: resolve the setting (secrets stay in the
 * provider store and the engine's in-memory secrets — the setting keeps
 * only the provider id and model name, or the engine tag), check the 24h
 * cache, ask under a 2s ceiling, parse strictly, and — on a reuse —
 * deliver the task (backend team message + the TEAMS.md lifecycle refresh,
 * `teams.cjs send` semantics) before answering. Every doubt answers `full`
 * and the ordinary flow runs unchanged: the conservative direction is the
 * product decision, not an implementation detail.
 */
import { httpRequest } from '@/common/adapter/httpBridge';
import { ClientFactory, type RotatingClient } from '@/common/api/ClientFactory';
import type { IProvider, TProviderWithModel } from '@/common/config/storage';
import { positionLabel, type PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import { SUPERVISOR_POSITION_NAME, type SupervisorTeam } from '@/common/chat/team/supervisor/supervisorCore';
import {
  QUICK_DECISION_CACHE_TTL_MS,
  QUICK_DECISION_TIMEOUT_MS,
  activeTeamsForDecision,
  buildPositionDomainPrompt,
  buildSupervisorReusePrompt,
  decisionCacheKey,
  isCacheEntryFresh,
  parsePositionDomainDecision,
  parseSupervisorReuseDecision,
  type QuickDecisionCacheEntry,
  type QuickDecisionKind,
} from '@/common/chat/team/quickDecision/quickDecisionCore';
import { MU_ENGINE_LABEL } from '@/common/chat/team/quickDecision/muEngineCore';
import { askMuEngine, prodMuEngineDeps, type MuEngineAskOutcome, type MuEngineContext } from './muDecisionEngine';
import type {
  QuickDecisionRouteParams,
  QuickDecisionRouteResult,
} from '@/common/chat/team/quickDecision/quickDecisionBridge';
import { listSupervisorTeams, reuseSupervisorTeamIn } from '@process/services/team/supervisor';
import { POSITION_LIBRARY_DIR, scanPositionLibrary } from '@process/services/team/positions/positionService';
import { getPlatformServices } from '@/common/platform';

/** The setting's stored shape: a provider reference plus the chosen model (the api key stays in the provider store), or the built-in MU decision engine — the jev + glm three-tier chain. */
export type QuickDecisionModelSetting = TProviderWithModel | { engine: 'mu' };

/** What the setting resolved to: one configured provider, the MU engine, or nothing (the feature is off). */
export type QuickDecisionSelection = { kind: 'provider'; model: TProviderWithModel } | { kind: 'mu' };

/** Everything injectable, so tests run no HTTP, no model and no clock. */
export type QuickDecisionDeps = {
  now: () => number;
  /** Reads `tools.quickDecisionModel`; undefined (or a throw) = the feature is off. */
  readSetting: () => Promise<QuickDecisionModelSetting | undefined>;
  /** The live provider list, secrets included — the setting's id resolves against it. */
  listProviders: () => Promise<IProvider[]>;
  listTeams: () => Promise<SupervisorTeam[]>;
  readRoster: () => Promise<PositionInfo[]>;
  /** One completion: the prompt's messages in, the model's raw text out; must honor the timeout itself. */
  complete: (
    provider: TProviderWithModel,
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    timeoutMs: number
  ) => Promise<string>;
  /** One MU-engine ask: the L1 (jev) / L2 (glm) chain; injected so tests run no treg, no judge and no disk. */
  askEngine: (
    kind: QuickDecisionKind,
    context: MuEngineContext,
    prompt: { system: string; user: string }
  ) => Promise<MuEngineAskOutcome>;
  /** Delivers the task to the team (the backend team message of `teams.cjs send`). */
  deliverTeamTask: (teamId: string, input: string) => Promise<void>;
  /** The index half of a reuse: the lifecycle refresh; undefined = the team id no longer names a live row. */
  refreshTeamReuse: (teamId: string, at: number) => Promise<SupervisorTeam | undefined>;
  log: (...args: unknown[]) => void;
};

/** Running totals for the dev log: what short-circuited, what fell back, what it saved. */
export type QuickDecisionCounters = { shortCircuits: number; fallbacks: number; savedTurns: number };

/** The one-line dev log every decision writes, with the running totals. */
const logDecision = (
  deps: QuickDecisionDeps,
  counters: QuickDecisionCounters,
  fields: { action: string; kind: QuickDecisionKind | 'disabled'; cached: boolean; extra: string }
): void => {
  deps.log(
    `[quickDecision] action=${fields.action} kind=${fields.kind} cached=${fields.cached} ${fields.extra} | totals: short-circuited=${counters.shortCircuits} fallback=${counters.fallbacks} savedTurns=${counters.savedTurns}`
  );
};

/** What a decisive result reports: which model decided, and — engine mode — which tier and at what probability. */
export type DecisionBasis = { model: string; tier?: 'L1' | 'L2'; probability?: number };

/** One ask's outcome, provider path and engine path alike. */
type AskOutcome =
  | { ok: true; raw: string; model: string; tier?: 'L1' | 'L2'; probability?: number }
  | { ok: false; reason: string };

/** A resolved decision source: the live provider with the setting's model, or the MU engine. */
const resolveSelection = async (deps: QuickDecisionDeps): Promise<QuickDecisionSelection | undefined> => {
  let setting: QuickDecisionModelSetting | undefined;
  try {
    setting = await deps.readSetting();
  } catch {
    return undefined; // An unreadable setting is an off feature, not an error surface.
  }
  if (!setting) return undefined;
  if ('engine' in setting) {
    if (setting.engine === 'mu') return { kind: 'mu' };
    return undefined; // An unknown engine tag is an off feature, not a guess.
  }
  if (!setting.id || !setting.use_model) return undefined;
  const providers = await deps.listProviders();
  const provider = providers.find((candidate) => candidate.id === setting.id);
  if (!provider) return undefined; // The provider was removed: off, not broken.
  return { kind: 'provider', model: { ...provider, use_model: setting.use_model } };
};

/**
 * Routes one send. The unit of work: disabled → `full` without a sound;
 * cache hit → the cached verdict ACTS again (a reuse re-delivers); miss →
 * one model call under the ceiling, parsed strictly. Only decisive verdicts
 * are cached — a cached `full` would save nothing (the full round dominates)
 * and could go stale against a changed roster or team set.
 */
export async function routeQuickDecisionIn(
  deps: QuickDecisionDeps,
  cache: Map<string, QuickDecisionCacheEntry>,
  counters: QuickDecisionCounters,
  params: QuickDecisionRouteParams
): Promise<QuickDecisionRouteResult> {
  const selection = await resolveSelection(deps);
  if (!selection) return { action: 'full', reason: 'no-model-configured' };
  const providerModel = selection.kind === 'provider' ? selection.model : undefined;
  /** The basis a cache replay reports: the replay runs no tier, so it names the configured source, not a model. */
  const cachedBasis = (): DecisionBasis => ({
    model: providerModel !== undefined ? providerModel.use_model : MU_ENGINE_LABEL,
  });

  const input = params.input.trim();
  if (!input) return { action: 'full', reason: 'empty-input' };
  const kind: QuickDecisionKind =
    params.positionMarker === SUPERVISOR_POSITION_NAME ? 'supervisor-reuse' : 'position-domain';
  const key = decisionCacheKey(kind, params.positionMarker, input);
  const startedAt = deps.now();

  // The context both the prompt and the validation read: the shared index and the roster.
  const [teams, roster] = await Promise.all([deps.listTeams(), deps.readRoster()]);
  const position = roster.find((candidate) => candidate.name === params.positionMarker);
  if (kind === 'position-domain' && !position) return { action: 'full', reason: 'unknown-position' };
  const activeTeams = activeTeamsForDecision(teams, deps.now());

  /** Delivers one reuse: the team message first, then the lifecycle refresh — a task in the team with a stale row is recoverable, the reverse would lie about a delivery that failed. */
  const deliverReuse = async (teamId: string): Promise<{ teamName: string; leadConversationId: string }> => {
    await deps.deliverTeamTask(teamId, input);
    const refreshed = await deps.refreshTeamReuse(teamId, deps.now());
    if (!refreshed) throw new Error(`team row vanished: ${teamId}`);
    return { teamName: refreshed.name, leadConversationId: refreshed.leadConversationId };
  };
  const reuseResult = async (
    verdict: { reason: string; confidence: number },
    cached: boolean,
    delivered: { teamName: string; leadConversationId: string; teamId: string },
    basis: DecisionBasis
  ) => ({
    action: 'reuse' as const,
    ...delivered,
    reason: verdict.reason,
    confidence: verdict.confidence,
    model: basis.model,
    ...(basis.tier !== undefined ? { tier: basis.tier } : {}),
    ...(basis.probability !== undefined ? { probability: basis.probability } : {}),
    durationMs: deps.now() - startedAt,
    cached,
  });

  // Cache hit: the verdict acts again, zero model calls. The kind checks are
  // narrowing, not defense — only a matching kind's decisive verdict was ever
  // cached under this key. A reuse hit whose delivery fails evicts the entry
  // and falls back — the cache must not fossilize a team the user has since
  // deleted.
  const hit = cache.get(key);
  if (isCacheEntryFresh(hit, deps.now()) && hit) {
    const verdict = hit.verdict;
    if (kind === 'supervisor-reuse' && verdict.action === 'reuse') {
      try {
        const result = await reuseResult(
          verdict,
          true,
          {
            teamId: verdict.teamId,
            ...(await deliverReuse(verdict.teamId)),
          },
          cachedBasis()
        );
        counters.shortCircuits += 1;
        counters.savedTurns += 1;
        logDecision(deps, counters, {
          action: 'reuse',
          kind,
          cached: true,
          extra: `team=「${result.teamName}» model=${result.model} duration=${result.durationMs}ms confidence=${verdict.confidence}`,
        });
        return result;
      } catch (error) {
        cache.delete(key);
        counters.fallbacks += 1;
        logDecision(deps, counters, { action: 'full', kind, cached: true, extra: `deliver-failed ${String(error)}` });
        return { action: 'full', reason: 'deliver-failed' };
      }
    }
    if (kind === 'position-domain' && verdict.action === 'reject') {
      const suggested = roster.find((candidate) => candidate.name === verdict.suggest);
      const basis = cachedBasis();
      counters.shortCircuits += 1;
      counters.savedTurns += 1;
      logDecision(deps, counters, {
        action: 'reject',
        kind,
        cached: true,
        extra: `suggest=${verdict.suggest} model=${basis.model} confidence=${verdict.confidence}`,
      });
      return {
        action: 'reject',
        suggestId: verdict.suggest,
        suggestLabel: suggested ? positionLabel(suggested) : verdict.suggest,
        reason: verdict.reason,
        confidence: verdict.confidence,
        model: basis.model,
        durationMs: deps.now() - startedAt,
        cached: true,
      };
    }
  }

  // Miss: build the prompt, one ask under the ceiling. Point A with
  // no active team to reuse skips the call outright — nothing to decide.
  /** One ask through whichever source is configured: the provider's one model, or the engine's L1→L2 chain. */
  const askConfigured = async (
    kind: QuickDecisionKind,
    prompt: { system: string; user: string },
    context: MuEngineContext
  ): Promise<AskOutcome> => {
    if (providerModel !== undefined) return askModel(deps, counters, providerModel, kind, prompt, startedAt);
    const asked = await deps.askEngine(kind, context, prompt);
    if (asked.ok === false) {
      // The engine logged its own line; this is only the counters half of the same fallback.
      counters.fallbacks += 1;
      logDecision(deps, counters, { action: 'full', kind, cached: false, extra: `reason=${asked.reason} engine` });
    }
    return asked;
  };
  /** The basis the log line carries for a decisive ask: tier and probability only exist in engine mode. */
  const basisExtra = (basis: DecisionBasis): string =>
    `model=${basis.model}${basis.tier !== undefined ? ` tier=${basis.tier}` : ''}${
      basis.probability !== undefined ? ` prob=${basis.probability.toFixed(2)}` : ''
    }`;

  if (kind === 'supervisor-reuse') {
    if (activeTeams.length === 0) return { action: 'full', reason: 'no-active-teams' };
    const ask = await askConfigured(kind, buildSupervisorReusePrompt({ task: input, teams: activeTeams, roster }), {
      task: input,
      teams: activeTeams,
      roster,
    });
    if (ask.ok === false) return { action: 'full', reason: ask.reason };
    const basis: DecisionBasis = { model: ask.model, tier: ask.tier, probability: ask.probability };
    const verdict = parseSupervisorReuseDecision(ask.raw);
    if (verdict.action === 'full') {
      counters.fallbacks += 1;
      logDecision(deps, counters, {
        action: 'full',
        kind,
        cached: false,
        extra: `reason=${verdict.reason} ${basisExtra(basis)}`,
      });
      return { action: 'full', reason: verdict.reason };
    }
    if (!activeTeams.some((team) => team.teamId === verdict.teamId)) {
      counters.fallbacks += 1;
      logDecision(deps, counters, {
        action: 'full',
        kind,
        cached: false,
        extra: `team-not-active id=${verdict.teamId}`,
      });
      return { action: 'full', reason: 'team-not-active' };
    }
    try {
      const result = await reuseResult(
        verdict,
        false,
        {
          teamId: verdict.teamId,
          ...(await deliverReuse(verdict.teamId)),
        },
        basis
      );
      counters.shortCircuits += 1;
      counters.savedTurns += 1;
      cache.set(key, { verdict, expiresAt: deps.now() + QUICK_DECISION_CACHE_TTL_MS });
      logDecision(deps, counters, {
        action: 'reuse',
        kind,
        cached: false,
        extra: `team=「${result.teamName}» ${basisExtra(basis)} duration=${result.durationMs}ms confidence=${verdict.confidence}`,
      });
      return result;
    } catch (error) {
      counters.fallbacks += 1;
      logDecision(deps, counters, { action: 'full', kind, cached: false, extra: `deliver-failed ${String(error)}` });
      return { action: 'full', reason: 'deliver-failed' };
    }
  }

  // kind === 'position-domain'. The guard above already returned when the
  // marker names no roster position; the restatement is only the local that
  // narrows the type for the prompt below.
  const ownPosition = position;
  if (ownPosition === undefined) return { action: 'full', reason: 'unknown-position' };
  const ask = await askConfigured(kind, buildPositionDomainPrompt({ task: input, position: ownPosition, roster }), {
    task: input,
    teams: activeTeams,
    roster,
    position: ownPosition,
  });
  if (ask.ok === false) return { action: 'full', reason: ask.reason };
  const basis: DecisionBasis = { model: ask.model, tier: ask.tier, probability: ask.probability };
  const verdict = parsePositionDomainDecision(ask.raw, roster);
  if (verdict.action === 'full') {
    counters.fallbacks += 1;
    logDecision(deps, counters, {
      action: 'full',
      kind,
      cached: false,
      extra: `reason=${verdict.reason} ${basisExtra(basis)}`,
    });
    return { action: 'full', reason: verdict.reason };
  }
  const suggested = roster.find((candidate) => candidate.name === verdict.suggest);
  counters.shortCircuits += 1;
  counters.savedTurns += 1;
  cache.set(key, { verdict, expiresAt: deps.now() + QUICK_DECISION_CACHE_TTL_MS });
  logDecision(deps, counters, {
    action: 'reject',
    kind,
    cached: false,
    extra: `suggest=${verdict.suggest} ${basisExtra(basis)} duration=${deps.now() - startedAt}ms confidence=${verdict.confidence}`,
  });
  return {
    action: 'reject',
    suggestId: verdict.suggest,
    suggestLabel: suggested ? positionLabel(suggested) : verdict.suggest,
    reason: verdict.reason,
    confidence: verdict.confidence,
    model: basis.model,
    ...(basis.tier !== undefined ? { tier: basis.tier } : {}),
    ...(basis.probability !== undefined ? { probability: basis.probability } : {}),
    durationMs: deps.now() - startedAt,
    cached: false,
  };
}

/** One model call under the ceiling; the failure shape carries the reason the fallback already logged. */
async function askModel(
  deps: QuickDecisionDeps,
  counters: QuickDecisionCounters,
  model: TProviderWithModel,
  kind: QuickDecisionKind,
  prompt: { system: string; user: string },
  startedAt: number
): Promise<AskOutcome> {
  try {
    const raw = await deps.complete(
      model,
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      QUICK_DECISION_TIMEOUT_MS
    );
    return { ok: true, raw, model: model.use_model };
  } catch (error) {
    counters.fallbacks += 1;
    const text = String(error);
    const lowered = text.toLowerCase();
    const reason = lowered.includes('timeout') || lowered.includes('abort') ? 'timeout' : 'model-error';
    logDecision(deps, counters, {
      action: 'full',
      kind,
      cached: false,
      extra: `${reason} model=${model.use_model} after=${deps.now() - startedAt}ms ${text.slice(0, 140)}`,
    });
    return { ok: false, reason };
  }
}

/**
 * The production model call. The rotating clients only PRE-check an abort
 * signal — the Gemini and Anthropic adapters never see it mid-flight — so
 * the ceiling is enforced here, as a race the caller always wins or loses
 * within `timeoutMs`. The AbortController still cancels an OpenAI-family
 * request in flight; the race covers every other adapter.
 */
const completeUnderCeiling = async (
  provider: TProviderWithModel,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  timeoutMs: number
): Promise<string> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const client: RotatingClient = await ClientFactory.createRotatingClient(provider, {
      // 1 = one attempt, no retries: the ceiling is ours, not the adapter's.
      // (0 would make executeWithRetry's `for (attempt < maxRetries)` loop
      // run zero times and `throw lastError` — which is undefined.)
      rotatingOptions: { maxRetries: 1 },
    });
    const completion = await Promise.race([
      client.createChatCompletion(
        { model: provider.use_model, messages },
        { signal: controller.signal, timeout: timeoutMs }
      ),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('quick-decision-timeout')), timeoutMs);
      }),
    ]);
    return completion.choices[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
};

/** The production wiring: backend settings and providers over the app's own wire, the shared index and the roster from disk. */
const prodDeps = (): QuickDecisionDeps => ({
  now: Date.now,
  readSetting: async () => {
    const data = await httpRequest<Record<string, QuickDecisionModelSetting | undefined>>(
      'GET',
      `/api/settings/client?keys=${encodeURIComponent('tools.quickDecisionModel')}`
    );
    return data?.['tools.quickDecisionModel'];
  },
  listProviders: () => httpRequest<IProvider[]>('GET', '/api/providers'),
  listTeams: () => listSupervisorTeams(),
  readRoster: () => scanPositionLibrary(POSITION_LIBRARY_DIR),
  complete: completeUnderCeiling,
  askEngine: (kind, context, prompt) =>
    askMuEngine(prodMuEngineDeps(), kind, context, prompt, QUICK_DECISION_TIMEOUT_MS),
  deliverTeamTask: async (teamId, input) => {
    await httpRequest('POST', `/api/teams/${teamId}/messages`, { content: input, files: [] });
  },
  refreshTeamReuse: (teamId, at) =>
    reuseSupervisorTeamIn({ dataDir: getPlatformServices().paths.getDataDir() }, { teamId, at }),
  log: (...args) => console.log(...args),
});

// The singletons one app run shares: the cache and the counters live as long
// as the process does. The state object is swapped only by tests.
const state = {
  cache: new Map<string, QuickDecisionCacheEntry>(),
  counters: { shortCircuits: 0, fallbacks: 0, savedTurns: 0 } as QuickDecisionCounters,
};

export const resetQuickDecisionStateForTest = (): void => {
  state.cache = new Map();
  state.counters = { shortCircuits: 0, fallbacks: 0, savedTurns: 0 };
};

/** The bridge's entry: one send, one route call. */
export const routeQuickDecision = (params: QuickDecisionRouteParams): Promise<QuickDecisionRouteResult> =>
  routeQuickDecisionIn(prodDeps(), state.cache, state.counters, params);
