/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The quick-decision layer on the main-process side: the cheap model that
 * answers, before any full model round starts, whether the supervisor may
 * reuse an active team (point A) and whether a task is clearly outside a
 * position's domain (point B). One `route` call is one whole attempt:
 * resolve the configured model (secrets stay in the provider store — the
 * setting keeps only the provider id and model name), check the 24h cache,
 * ask the model under a 2s ceiling, parse strictly, and — on a reuse —
 * deliver the task (backend team message + the TEAMS.md lifecycle refresh,
 * `teams.cjs send` semantics) before answering. Every doubt answers `full`
 * and the ordinary flow runs unchanged: the conservative direction is the
 * product decision, not an implementation detail.
 */
import { httpRequest } from '@/common/adapter/httpBridge';
import { ClientFactory, type RotatingClient } from '@/common/api/ClientFactory';
import type { IProvider, TProviderWithModel } from '@/common/config/storage';
import { positionLabel, type PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import {
  SUPERVISOR_POSITION_NAME,
  TEAM_ID_RE,
  type SupervisorTeam,
} from '@/common/chat/team/supervisor/supervisorCore';
import {
  QUICK_DECISION_CACHE_TTL_MS,
  QUICK_DECISION_MIN_CONFIDENCE,
  QUICK_DECISION_TIMEOUT_MS,
  activeTeamsForDecision,
  buildContextStewardPrompt,
  buildDispatchHintPrompt,
  buildPositionDomainPrompt,
  buildSupervisorReusePrompt,
  buildTeamRoutePrompt,
  decisionCacheKey,
  isCacheEntryFresh,
  parseContextStewardDecision,
  parseDispatchHintDecision,
  parsePositionDomainDecision,
  parseSupervisorReuseDecision,
  parseTeamRouteDecision,
  teamMembersForRoute,
  type QuickDecisionCacheEntry,
  type QuickDecisionKind,
} from '@/common/chat/team/quickDecision/quickDecisionCore';
import type {
  QuickDecisionHintResult,
  QuickDecisionRouteParams,
  QuickDecisionRouteResult,
  QuickDecisionRouteTeamResult,
  QuickDecisionThinkingResult,
} from '@/common/chat/team/quickDecision/quickDecisionBridge';
import {
  buildThinkingLevelPrompt,
  parseThinkingLevelDecision,
  type PositionThinkingLevel,
} from '@/common/chat/team/thinkingLevel/thinkingLevelCore';
import { listSupervisorTeams, reuseSupervisorTeamIn } from '@process/services/team/supervisor';
import { POSITION_LIBRARY_DIR, scanPositionLibrary } from '@process/services/team/positions/positionService';
import { getPlatformServices } from '@/common/platform';

/** The setting's stored shape: a provider reference plus the chosen model; the api key stays in the provider store. */
export type QuickDecisionModelSetting = TProviderWithModel;

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
  /** Delivers the task to the team (the backend team message of `teams.cjs send`). */
  deliverTeamTask: (teamId: string, input: string) => Promise<void>;
  /** The index half of a reuse: the lifecycle refresh; undefined = the team id no longer names a live row. */
  refreshTeamReuse: (teamId: string, at: number) => Promise<SupervisorTeam | undefined>;
  /** The team detail a group-chat route reads; undefined = the team is gone. */
  getTeamAssistants: (
    teamId: string
  ) => Promise<Array<{ slot_id?: string; role?: string; assistant_name?: string }> | undefined>;
  /** Delivers the message to one teammate slot (the backend agent message of `sendMessageToAgent`). */
  deliverMemberMessage: (teamId: string, slotId: string, input: string) => Promise<void>;
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

/** A resolved decision model: the live provider with the setting's model. */
const resolveModel = async (deps: QuickDecisionDeps): Promise<TProviderWithModel | undefined> => {
  let setting: QuickDecisionModelSetting | undefined;
  try {
    setting = await deps.readSetting();
  } catch {
    return undefined; // An unreadable setting is an off feature, not an error surface.
  }
  if (!setting?.id || !setting.use_model) return undefined;
  const providers = await deps.listProviders();
  const provider = providers.find((candidate) => candidate.id === setting.id);
  if (!provider) return undefined; // The provider was removed: off, not broken.
  return { ...provider, use_model: setting.use_model };
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
  const model = await resolveModel(deps);
  if (!model) return { action: 'full', reason: 'no-model-configured' };

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
    delivered: { teamName: string; leadConversationId: string; teamId: string }
  ) => ({
    action: 'reuse' as const,
    ...delivered,
    reason: verdict.reason,
    confidence: verdict.confidence,
    model: model.use_model,
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
        const result = await reuseResult(verdict, true, {
          teamId: verdict.teamId,
          ...(await deliverReuse(verdict.teamId)),
        });
        counters.shortCircuits += 1;
        counters.savedTurns += 1;
        logDecision(deps, counters, {
          action: 'reuse',
          kind,
          cached: true,
          extra: `team=「${result.teamName}» model=${model.use_model} duration=${result.durationMs}ms confidence=${verdict.confidence}`,
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
      counters.shortCircuits += 1;
      counters.savedTurns += 1;
      logDecision(deps, counters, {
        action: 'reject',
        kind,
        cached: true,
        extra: `suggest=${verdict.suggest} model=${model.use_model} confidence=${verdict.confidence}`,
      });
      return {
        action: 'reject',
        suggestId: verdict.suggest,
        suggestLabel: suggested ? positionLabel(suggested) : verdict.suggest,
        reason: verdict.reason,
        confidence: verdict.confidence,
        model: model.use_model,
        durationMs: deps.now() - startedAt,
        cached: true,
      };
    }
  }

  // Miss: build the prompt, one model call under the ceiling. Point A with
  // no active team to reuse skips the call outright — nothing to decide.
  if (kind === 'supervisor-reuse') {
    if (activeTeams.length === 0) return { action: 'full', reason: 'no-active-teams' };
    const ask = await askModel(
      deps,
      counters,
      model,
      kind,
      buildSupervisorReusePrompt({ task: input, teams: activeTeams, roster }),
      startedAt
    );
    if (ask.ok === false) return { action: 'full', reason: ask.reason };
    const verdict = parseSupervisorReuseDecision(ask.raw);
    if (verdict.action === 'full') {
      counters.fallbacks += 1;
      logDecision(deps, counters, {
        action: 'full',
        kind,
        cached: false,
        extra: `reason=${verdict.reason} model=${model.use_model}`,
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
      const result = await reuseResult(verdict, false, {
        teamId: verdict.teamId,
        ...(await deliverReuse(verdict.teamId)),
      });
      counters.shortCircuits += 1;
      counters.savedTurns += 1;
      cache.set(key, { verdict, expiresAt: deps.now() + QUICK_DECISION_CACHE_TTL_MS });
      logDecision(deps, counters, {
        action: 'reuse',
        kind,
        cached: false,
        extra: `team=「${result.teamName}» model=${model.use_model} duration=${result.durationMs}ms confidence=${verdict.confidence}`,
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
  const ask = await askModel(
    deps,
    counters,
    model,
    kind,
    buildPositionDomainPrompt({ task: input, position: ownPosition, roster }),
    startedAt
  );
  if (ask.ok === false) return { action: 'full', reason: ask.reason };
  const verdict = parsePositionDomainDecision(ask.raw, roster);
  if (verdict.action === 'full') {
    counters.fallbacks += 1;
    logDecision(deps, counters, {
      action: 'full',
      kind,
      cached: false,
      extra: `reason=${verdict.reason} model=${model.use_model}`,
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
    extra: `suggest=${verdict.suggest} model=${model.use_model} duration=${deps.now() - startedAt}ms confidence=${verdict.confidence}`,
  });
  return {
    action: 'reject',
    suggestId: verdict.suggest,
    suggestLabel: suggested ? positionLabel(suggested) : verdict.suggest,
    reason: verdict.reason,
    confidence: verdict.confidence,
    model: model.use_model,
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
): Promise<{ ok: true; raw: string } | { ok: false; reason: string }> {
  try {
    const raw = await deps.complete(
      model,
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      QUICK_DECISION_TIMEOUT_MS
    );
    return { ok: true, raw };
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
  deliverTeamTask: async (teamId, input) => {
    await httpRequest('POST', `/api/teams/${teamId}/messages`, { content: input, files: [] });
  },
  getTeamAssistants: async (teamId) => {
    const team = await httpRequest<
      { assistants?: Array<{ slot_id?: string; role?: string; assistant_name?: string }> } | undefined
    >('GET', `/api/teams/${teamId}`);
    return team?.assistants;
  },
  deliverMemberMessage: async (teamId, slotId, input) => {
    await httpRequest('POST', `/api/teams/${teamId}/agents/${slotId}/messages`, { content: input, files: [] });
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

/**
 * Point C: one whole-team (group-chat) send. A `direct` verdict delivers the
 * message to that teammate's slot before answering — the window never acts
 * on a delivery that already failed — and a delivery failure evicts the
 * cache entry, so a member removed since the verdict cannot fossilize.
 */
export async function routeTeamMessageIn(
  deps: QuickDecisionDeps,
  cache: Map<string, QuickDecisionCacheEntry>,
  counters: QuickDecisionCounters,
  params: { input: string; teamId: string }
): Promise<QuickDecisionRouteTeamResult> {
  const model = await resolveModel(deps);
  if (!model) return { action: 'full', reason: 'no-model-configured' };
  const input = params.input.trim();
  if (!input) return { action: 'full', reason: 'empty-input' };
  // The wire boundary: the team id flows into backend URL paths, so it must
  // pass the same shape check every other path-carrying id passes.
  if (!TEAM_ID_RE.test(params.teamId)) return { action: 'full', reason: 'bad-team-id' };
  const key = decisionCacheKey('team-route', `team:${params.teamId}`, input);
  const startedAt = deps.now();

  const assistants = await deps.getTeamAssistants(params.teamId).catch((): undefined => undefined);
  if (!assistants) return { action: 'full', reason: 'unknown-team' };
  const members = teamMembersForRoute(assistants);
  if (members.length === 0) return { action: 'full', reason: 'no-teammates' };

  /** Delivers one direct route; the answer only follows a delivery that held. */
  const deliverDirect = (slotId: string): Promise<void> => deps.deliverMemberMessage(params.teamId, slotId, input);
  const directResult = (
    verdict: { slotId: string; reason: string; confidence: number },
    memberName: string,
    cached: boolean
  ): QuickDecisionRouteTeamResult => ({
    action: 'direct',
    slotId: verdict.slotId,
    memberName,
    reason: verdict.reason,
    confidence: verdict.confidence,
    model: model.use_model,
    durationMs: deps.now() - startedAt,
    cached,
  });

  // Cache hit: a `direct` verdict delivers again. A member removed since the
  // verdict is evicted and answered `full` this once — the next identical
  // message re-asks with the live roster.
  const hit = cache.get(key);
  if (isCacheEntryFresh(hit, deps.now()) && hit) {
    const verdict = hit.verdict;
    if (verdict.action === 'direct') {
      const member = members.find((candidate) => candidate.slotId === verdict.slotId);
      if (!member) {
        cache.delete(key);
        return { action: 'full', reason: 'member-gone' };
      }
      try {
        await deliverDirect(verdict.slotId);
        counters.shortCircuits += 1;
        counters.savedTurns += 1;
        logDecision(deps, counters, {
          action: 'direct',
          kind: 'team-route',
          cached: true,
          extra: `member=「${member.name}» slot=${verdict.slotId} model=${model.use_model} confidence=${verdict.confidence}`,
        });
        return directResult(verdict, member.name, true);
      } catch (error) {
        cache.delete(key);
        counters.fallbacks += 1;
        logDecision(deps, counters, {
          action: 'full',
          kind: 'team-route',
          cached: true,
          extra: `deliver-failed ${String(error)}`,
        });
        return { action: 'full', reason: 'deliver-failed' };
      }
    }
  }

  // Miss: one model call under the ceiling, parsed against the live members.
  const ask = await askModel(
    deps,
    counters,
    model,
    'team-route',
    buildTeamRoutePrompt({ message: input, members }),
    startedAt
  );
  if (ask.ok === false) return { action: 'full', reason: ask.reason };
  const verdict = parseTeamRouteDecision(ask.raw, members);
  if (verdict.action === 'full') {
    counters.fallbacks += 1;
    logDecision(deps, counters, {
      action: 'full',
      kind: 'team-route',
      cached: false,
      extra: `reason=${verdict.reason} model=${model.use_model}`,
    });
    return { action: 'full', reason: verdict.reason };
  }
  const member = members.find((candidate) => candidate.slotId === verdict.slotId);
  if (!member) return { action: 'full', reason: 'slot-not-member' };
  try {
    await deliverDirect(verdict.slotId);
    counters.shortCircuits += 1;
    counters.savedTurns += 1;
    cache.set(key, { verdict, expiresAt: deps.now() + QUICK_DECISION_CACHE_TTL_MS });
    logDecision(deps, counters, {
      action: 'direct',
      kind: 'team-route',
      cached: false,
      extra: `member=「${member.name}» slot=${verdict.slotId} model=${model.use_model} duration=${deps.now() - startedAt}ms confidence=${verdict.confidence}`,
    });
    return directResult(verdict, member.name, false);
  } catch (error) {
    counters.fallbacks += 1;
    logDecision(deps, counters, {
      action: 'full',
      kind: 'team-route',
      cached: false,
      extra: `deliver-failed ${String(error)}`,
    });
    return { action: 'full', reason: 'deliver-failed' };
  }
}

/**
 * Point D: the dispatch hint for one supervisor-bound task. Pure advisory —
 * nothing is delivered; the caller prefixes one wire line and the
 * supervisor re-checks it — so the only failure shape is `none` (send the
 * task untouched). A cached `hint` replays only the ids still on the
 * roster; a roster change that empties it evicts and answers `none`.
 */
export async function dispatchHintIn(
  deps: QuickDecisionDeps,
  cache: Map<string, QuickDecisionCacheEntry>,
  counters: QuickDecisionCounters,
  params: { input: string }
): Promise<QuickDecisionHintResult> {
  const model = await resolveModel(deps);
  if (!model) return { action: 'none', reason: 'no-model-configured' };
  const input = params.input.trim();
  if (!input) return { action: 'none', reason: 'empty-input' };
  const key = decisionCacheKey('dispatch-hint', SUPERVISOR_POSITION_NAME, input);
  const startedAt = deps.now();

  const roster = await deps.readRoster();
  if (roster.length === 0) return { action: 'none', reason: 'empty-roster' };

  const hintResult = (
    verdict: { positions: string[]; reason: string; confidence: number },
    cached: boolean
  ): QuickDecisionHintResult => ({
    action: 'hint',
    positions: verdict.positions.map((id) => {
      const found = roster.find((position) => position.name === id);
      return { id, label: found ? positionLabel(found) : id };
    }),
    reason: verdict.reason,
    confidence: verdict.confidence,
    model: model.use_model,
    durationMs: deps.now() - startedAt,
    cached,
  });

  // Cache hit: replay only the ids the roster still knows.
  const hit = cache.get(key);
  if (isCacheEntryFresh(hit, deps.now()) && hit) {
    const verdict = hit.verdict;
    if (verdict.action === 'hint') {
      const live = verdict.positions.filter((id) => roster.some((position) => position.name === id));
      if (live.length > 0) {
        counters.shortCircuits += 1;
        logDecision(deps, counters, {
          action: 'hint',
          kind: 'dispatch-hint',
          cached: true,
          extra: `positions=${live.join(',')} model=${model.use_model} confidence=${verdict.confidence}`,
        });
        return hintResult({ ...verdict, positions: live }, true);
      }
      cache.delete(key);
      return { action: 'none', reason: 'roster-changed' };
    }
  }

  const ask = await askModel(
    deps,
    counters,
    model,
    'dispatch-hint',
    buildDispatchHintPrompt({ task: input, roster }),
    startedAt
  );
  if (ask.ok === false) return { action: 'none', reason: ask.reason };
  const verdict = parseDispatchHintDecision(ask.raw, roster);
  if (verdict.action === 'none') {
    counters.fallbacks += 1;
    logDecision(deps, counters, {
      action: 'none',
      kind: 'dispatch-hint',
      cached: false,
      extra: `reason=${verdict.reason} model=${model.use_model}`,
    });
    return { action: 'none', reason: verdict.reason };
  }
  counters.shortCircuits += 1;
  cache.set(key, { verdict, expiresAt: deps.now() + QUICK_DECISION_CACHE_TTL_MS });
  logDecision(deps, counters, {
    action: 'hint',
    kind: 'dispatch-hint',
    cached: false,
    extra: `positions=${verdict.positions.join(',')} model=${model.use_model} duration=${deps.now() - startedAt}ms confidence=${verdict.confidence}`,
  });
  return hintResult(verdict, false);
}

/** Point E's ask: what the steward passes the engine — the live token state of one session, never a task text. */
export type ContextStewardAskParams = Parameters<typeof buildContextStewardPrompt>[0];

/** Point E's answer: the engine's own words when it decided, or why it could not. No conservative direction here — eligibility (may this conversation switch?) is a steward fact the engine cannot see. */
export type ContextStewardEngineResult =
  | { answered: true; action: 'compact' | 'switch' | 'none'; reason: string; model: string; durationMs: number }
  | { answered: false; reason: string };

/**
 * Point E: one steward question — compact or switch — under the same 2s
 * ceiling as every other quick decision. NEVER cached: the answer is a
 * function of the session's live token count, which the cache key cannot
 * carry meaningfully, and a stale verdict would be worse than no verdict.
 * The caller owns the lossless fallback for every unanswered shape.
 */
export async function contextStewardDecisionIn(
  deps: QuickDecisionDeps,
  counters: QuickDecisionCounters,
  params: ContextStewardAskParams
): Promise<ContextStewardEngineResult> {
  const model = await resolveModel(deps);
  if (!model) return { answered: false, reason: 'no-model-configured' };
  const startedAt = deps.now();
  const ask = await askModel(deps, counters, model, 'context-steward', buildContextStewardPrompt(params), startedAt);
  if (ask.ok === false) return { answered: false, reason: ask.reason };
  const verdict = parseContextStewardDecision(ask.raw);
  if (verdict === undefined) {
    counters.fallbacks += 1;
    logDecision(deps, counters, {
      action: 'full',
      kind: 'context-steward',
      cached: false,
      extra: `malformed-answer model=${model.use_model}`,
    });
    return { answered: false, reason: 'malformed-answer' };
  }
  counters.shortCircuits += 1;
  logDecision(deps, counters, {
    action: verdict.action,
    kind: 'context-steward',
    cached: false,
    extra: `conversation=「${params.goal.slice(0, 40)}» model=${model.use_model} duration=${deps.now() - startedAt}ms`,
  });
  return { answered: true, ...verdict, model: model.use_model, durationMs: deps.now() - startedAt };
}

/** The bridge entries for points C and D. */
export const routeTeamMessage = (params: { input: string; teamId: string }): Promise<QuickDecisionRouteTeamResult> =>
  routeTeamMessageIn(prodDeps(), state.cache, state.counters, params);

export const dispatchHintFor = (params: { input: string }): Promise<QuickDecisionHintResult> =>
  dispatchHintIn(prodDeps(), state.cache, state.counters, params);

/** Point E's bridge entry: the steward's one question, asked only when a session stands at its line. */
export const contextStewardDecision = (params: ContextStewardAskParams): Promise<ContextStewardEngineResult> =>
  contextStewardDecisionIn(prodDeps(), state.counters, params);

/**
 * Point F: one task's complexity as one of the four thinking levels, cached
 * like the hint — the answer is a function of the task text alone, so a
 * replayed verdict is as good as a fresh one. `keep` is the majority answer
 * by design: no model, a malformed answer or a confidence under the bar all
 * leave the conversation's current level untouched.
 */
export async function thinkingLevelIn(
  deps: QuickDecisionDeps,
  cache: Map<string, QuickDecisionCacheEntry>,
  counters: QuickDecisionCounters,
  params: { input: string }
): Promise<QuickDecisionThinkingResult> {
  const model = await resolveModel(deps);
  if (!model) return { action: 'keep', reason: 'no-model-configured' };
  const input = params.input.trim();
  if (!input) return { action: 'keep', reason: 'empty-input' };
  const key = decisionCacheKey('thinking-level', 'task', input);
  const startedAt = deps.now();

  const setResult = (
    verdict: { level: PositionThinkingLevel; reason: string; confidence: number },
    cached: boolean
  ): QuickDecisionThinkingResult => ({
    action: 'set',
    level: verdict.level,
    reason: verdict.reason,
    confidence: verdict.confidence,
    model: model.use_model,
    durationMs: deps.now() - startedAt,
    cached,
  });

  // Cache hit: the answer is a function of the task text alone, so a fresh
  // replay is as good as a fresh ask (and costs no round).
  const hit = cache.get(key);
  if (isCacheEntryFresh(hit, deps.now()) && hit && hit.verdict.action === 'set') {
    counters.shortCircuits += 1;
    logDecision(deps, counters, {
      action: 'set',
      kind: 'thinking-level',
      cached: true,
      extra: `level=${hit.verdict.level} model=${model.use_model}`,
    });
    return setResult(hit.verdict, true);
  }

  const ask = await askModel(deps, counters, model, 'thinking-level', buildThinkingLevelPrompt(input), startedAt);
  if (ask.ok === false) return { action: 'keep', reason: ask.reason };
  const decision = parseThinkingLevelDecision(ask.raw, { minConfidence: QUICK_DECISION_MIN_CONFIDENCE });
  if (decision.action === 'keep') {
    counters.fallbacks += 1;
    logDecision(deps, counters, {
      action: 'full',
      kind: 'thinking-level',
      cached: false,
      extra: `reason=${decision.reason} model=${model.use_model}`,
    });
    return { action: 'keep', reason: decision.reason };
  }
  counters.shortCircuits += 1;
  cache.set(key, { verdict: decision, expiresAt: deps.now() + QUICK_DECISION_CACHE_TTL_MS });
  logDecision(deps, counters, {
    action: 'set',
    kind: 'thinking-level',
    cached: false,
    extra: `level=${decision.level} model=${model.use_model} duration=${deps.now() - startedAt}ms confidence=${decision.confidence}`,
  });
  return setResult(decision, false);
}

/** Point F's bridge entry: the send box asks right before a position-bound send. */
export const thinkingLevelFor = (params: { input: string }): Promise<QuickDecisionThinkingResult> =>
  thinkingLevelIn(prodDeps(), state.cache, state.counters, params);
