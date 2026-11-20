/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import { buildTeamsFile, type SupervisorTeam } from '@/common/chat/team/supervisor/supervisorCore';
import type { QuickDecisionCacheEntry } from '@/common/chat/team/quickDecision/quickDecisionCore';
import {
  routeQuickDecisionIn,
  type QuickDecisionCounters,
  type QuickDecisionDeps,
} from '@process/services/team/quickDecision';
import { reuseSupervisorTeamIn } from '@process/services/team/supervisor';

/**
 * The quick-decision service: the route a send takes through the cheap
 * model. Fake deps for everything (no HTTP, no model, no real clock); the
 * assertion spine is the conservative direction — every doubt lands on
 * `full` with the ordinary flow unchanged — plus the cache and the
 * `teams.cjs send` semantics of a reuse delivery.
 */

const dirs: string[] = [];
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mu-quick-decision-')));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const position = (name: string, displayName: string, description: string): PositionInfo => ({
  name,
  displayName,
  description,
  body: `${displayName} 说明书。`,
});

const roster = [
  position('supervisor-x', '主管替身', '不匹配'),
  position('forwarder', '货代', '海运订舱'),
  position('video-lab', '视频实验室', '视频制作'),
];

const team = (over: Partial<SupervisorTeam> = {}): SupervisorTeam => ({
  name: '货代小队',
  positions: ['forwarder'],
  createdAt: 1,
  lastUsedAt: 2,
  expiresAt: 1_000_000,
  ttlDays: 7,
  permanent: false,
  deletedAt: undefined,
  teamId: 't1',
  leadConversationId: 'c1',
  ...over,
});

type DepsOverrides = Partial<QuickDecisionDeps>;

/** Fake deps plus the call log the tests assert on. */
type FakeDeps = QuickDecisionDeps & { calls: { complete: number; deliver: string[]; refresh: string[] } };

const baseDeps = (over: DepsOverrides = {}): FakeDeps => {
  const calls = { complete: 0 as number, deliver: [] as string[], refresh: [] as string[] };
  const deps: FakeDeps = {
    now: () => 1000,
    readSetting: async () => ({
      id: 'p1',
      platform: 'openai',
      name: 'P',
      base_url: '',
      api_key: '',
      use_model: 'cheap',
    }),
    listProviders: async () => [
      { id: 'p1', platform: 'openai', name: 'P', base_url: 'https://x', api_key: 'k', models: ['cheap'] },
    ],
    listTeams: async () => [team()],
    readRoster: async () => roster,
    complete: async () => {
      calls.complete += 1;
      return '{"action":"full","reason":"不确定","confidence":0.9}';
    },
    askEngine: async () => ({ ok: false, reason: 'engine-not-asked' }), // The provider-path default; engine tests override it.
    deliverTeamTask: async (teamId) => {
      calls.deliver.push(teamId);
    },
    refreshTeamReuse: async (teamId) => {
      calls.refresh.push(teamId);
      return team({ teamId, name: '货代小队' });
    },
    log: () => {},
    calls,
  };
  return { ...deps, ...over };
};

const run = (deps: QuickDecisionDeps, params: { input: string; positionMarker?: string }) =>
  routeQuickDecisionIn(
    deps,
    new Map<string, QuickDecisionCacheEntry>(),
    { shortCircuits: 0, fallbacks: 0, savedTurns: 0 },
    { input: params.input, positionMarker: params.positionMarker ?? 'supervisor' }
  );

describe('routeQuickDecisionIn — the conservative direction', () => {
  it('no model configured answers full, quietly, without reading anything else', async () => {
    const deps = baseDeps({ readSetting: async () => undefined });
    const verdict = await run(deps, { input: '任务' });
    expect(verdict).toEqual({ action: 'full', reason: 'no-model-configured' });
    expect(deps.calls.complete).toBe(0);
  });
  it('a provider that disappeared from the store reads as off', async () => {
    const deps = baseDeps({ listProviders: async () => [] });
    expect(await run(deps, { input: '任务' })).toEqual({ action: 'full', reason: 'no-model-configured' });
  });
  it('a timeout or model error answers full and counts a fallback', async () => {
    const deps = baseDeps({ complete: async () => Promise.reject(new Error('quick-decision-timeout')) });
    const verdict = await run(deps, { input: '任务' });
    expect(verdict).toEqual({ action: 'full', reason: 'timeout' });
  });
  it('a malformed answer answers full', async () => {
    const deps = baseDeps({ complete: async () => '我不想输出 JSON' });
    expect(await run(deps, { input: '任务' })).toEqual({ action: 'full', reason: 'malformed-answer' });
  });
  it('a low-confidence reuse answers full', async () => {
    const deps = baseDeps({ complete: async () => '{"action":"reuse","teamId":"t1","reason":"x","confidence":0.5}' });
    expect(await run(deps, { input: '任务' })).toEqual({ action: 'full', reason: 'low-confidence' });
  });
  it('a reuse naming an inactive or unknown team answers full', async () => {
    const deps = baseDeps({
      complete: async () => '{"action":"reuse","teamId":"别的队","reason":"x","confidence":0.95}',
    });
    expect(await run(deps, { input: '任务' })).toEqual({ action: 'full', reason: 'team-not-active' });
  });
  it('an off-roster suggestion answers full', async () => {
    const deps = baseDeps({
      complete: async () => '{"action":"reject","suggest":"编造岗","reason":"x","confidence":0.99}',
    });
    const verdict = await run(deps, { input: '任务', positionMarker: 'forwarder' });
    expect(verdict).toEqual({ action: 'full', reason: 'suggestion-off-roster' });
  });
  it('a position marker naming no roster position answers full without a model call', async () => {
    const deps = baseDeps();
    expect(await run(deps, { input: '任务', positionMarker: '幽灵岗' })).toEqual({
      action: 'full',
      reason: 'unknown-position',
    });
    expect(deps.calls.complete).toBe(0);
  });
  it('no active team to reuse skips the model call entirely', async () => {
    const deps = baseDeps({ listTeams: async () => [team({ deletedAt: 100 })] });
    expect(await run(deps, { input: '任务' })).toEqual({ action: 'full', reason: 'no-active-teams' });
    expect(deps.calls.complete).toBe(0);
  });
});

describe('routeQuickDecisionIn — the short-circuits', () => {
  it('a confident reuse delivers the task, refreshes the row, caches the verdict', async () => {
    const deps = baseDeps({
      complete: async () => '{"action":"reuse","teamId":"t1","reason":"同域","confidence":0.95}',
    });
    const counters: QuickDecisionCounters = { shortCircuits: 0, fallbacks: 0, savedTurns: 0 };
    const cache = new Map<string, QuickDecisionCacheEntry>();
    const verdict = await routeQuickDecisionIn(deps, cache, counters, {
      input: '查一下 CNS 客户',
      positionMarker: 'supervisor',
    });
    expect(verdict.action).toBe('reuse');
    expect(deps.calls.deliver).toEqual(['t1']);
    expect(deps.calls.refresh).toEqual(['t1']);
    expect(counters).toEqual({ shortCircuits: 1, fallbacks: 0, savedTurns: 1 });
    expect(cache.size).toBe(1);
  });
  it('the same task again hits the cache: zero model calls, delivery happens again', async () => {
    let completions = 0;
    const deps = baseDeps({
      complete: async () => {
        completions += 1;
        return '{"action":"reuse","teamId":"t1","reason":"同域","confidence":0.95}';
      },
    });
    const counters: QuickDecisionCounters = { shortCircuits: 0, fallbacks: 0, savedTurns: 0 };
    const cache = new Map<string, QuickDecisionCacheEntry>();
    const first = await routeQuickDecisionIn(deps, cache, counters, {
      input: '查一下 CNS 客户',
      positionMarker: 'supervisor',
    });
    const second = await routeQuickDecisionIn(deps, cache, counters, {
      input: '查一下  CNS 客户',
      positionMarker: 'supervisor',
    });
    expect(completions).toBe(1); // whitespace normalization made them one task
    expect(first.action).toBe('reuse');
    expect(second.action).toBe('reuse');
    if (second.action === 'reuse') {
      expect(second.cached).toBe(true);
      expect(second.teamName).toBe('货代小队');
    }
    expect(counters.shortCircuits).toBe(2);
    expect(counters.savedTurns).toBe(2);
    expect(deps.calls.deliver).toEqual(['t1', 't1']); // a cached reuse re-delivers
  });
  it('a cache hit whose delivery fails evicts the entry and falls back', async () => {
    const deps = baseDeps({
      complete: async () => '{"action":"reuse","teamId":"t1","reason":"同域","confidence":0.95}',
    });
    const counters: QuickDecisionCounters = { shortCircuits: 0, fallbacks: 0, savedTurns: 0 };
    const cache = new Map<string, QuickDecisionCacheEntry>();
    await routeQuickDecisionIn(deps, cache, counters, { input: '查一下 CNS 客户', positionMarker: 'supervisor' });
    // The team is deleted between the two sends: the cached verdict must not fossilize.
    const changed = baseDeps({
      listTeams: async () => [team({ deletedAt: 999 })],
      deliverTeamTask: async () => {
        throw new Error('404');
      },
    });
    const verdict = await routeQuickDecisionIn(changed, cache, counters, {
      input: '查一下 CNS 客户',
      positionMarker: 'supervisor',
    });
    expect(verdict).toEqual({ action: 'full', reason: 'deliver-failed' });
    expect(cache.size).toBe(0);
  });
  it('a fresh delivery failure on the model path also falls back', async () => {
    const deps = baseDeps({
      complete: async () => '{"action":"reuse","teamId":"t1","reason":"同域","confidence":0.95}',
      deliverTeamTask: async () => {
        throw new Error('boom');
      },
    });
    const counters: QuickDecisionCounters = { shortCircuits: 0, fallbacks: 0, savedTurns: 0 };
    const cache = new Map<string, QuickDecisionCacheEntry>();
    const verdict = await routeQuickDecisionIn(deps, cache, counters, { input: '任务', positionMarker: 'supervisor' });
    expect(verdict).toEqual({ action: 'full', reason: 'deliver-failed' });
    expect(counters.shortCircuits).toBe(0);
    expect(counters.fallbacks).toBe(1);
    expect(cache.size).toBe(0);
  });
  it('a confident reject names the suggested position by its roster label', async () => {
    const deps = baseDeps({
      complete: async () => '{"action":"reject","suggest":"video-lab","reason":"视频域","confidence":0.95}',
    });
    const verdict = await run(deps, { input: '做一个宣传片', positionMarker: 'forwarder' });
    expect(verdict).toEqual({
      action: 'reject',
      suggestId: 'video-lab',
      suggestLabel: '视频实验室(video-lab)',
      reason: '视频域',
      confidence: 0.95,
      model: 'cheap',
      durationMs: 0,
      cached: false,
    });
  });
  it('the dev log carries the verdict and the running totals', async () => {
    const lines: string[] = [];
    const deps = baseDeps({
      complete: async () => '{"action":"reuse","teamId":"t1","reason":"同域","confidence":0.95}',
      log: (...args: unknown[]) => lines.push(args.join(' ')),
    });
    const counters: QuickDecisionCounters = { shortCircuits: 0, fallbacks: 0, savedTurns: 0 };
    await routeQuickDecisionIn(deps, new Map(), counters, { input: '任务', positionMarker: 'supervisor' });
    expect(
      lines.some(
        (line) => line.includes('[quickDecision]') && line.includes('action=reuse') && line.includes('savedTurns=1')
      )
    ).toBe(true);
  });
});

describe('routeQuickDecisionIn — the MU decision engine (jev L1 → glm L2 → full)', () => {
  const engineDeps = (over: DepsOverrides = {}) => baseDeps({ readSetting: async () => ({ engine: 'mu' }), ...over });
  const l1Reuse = {
    ok: true as const,
    raw: '{"action":"reuse","teamId":"t1","reason":"同域","confidence":0.93}',
    tier: 'L1' as const,
    model: 'jev-1.13',
    probability: 0.93,
  };

  it('the engine tag alone selects the engine: no provider resolution happens', async () => {
    const deps = engineDeps({ listProviders: async () => Promise.reject(new Error('must not resolve providers')) });
    await run(deps, { input: '任务' });
  });
  it('an L1 verdict short-circuits: delivered, tier and probability carried, cached for the next send', async () => {
    const cache = new Map<string, QuickDecisionCacheEntry>();
    const deps = engineDeps({ askEngine: async () => l1Reuse });
    const verdict = await routeQuickDecisionIn(
      deps,
      cache,
      { shortCircuits: 0, fallbacks: 0, savedTurns: 0 },
      {
        input: '查一下 CNS 客户',
        positionMarker: 'supervisor',
      }
    );
    expect(verdict).toMatchObject({
      action: 'reuse',
      teamId: 't1',
      tier: 'L1',
      probability: 0.93,
      model: 'jev-1.13',
      cached: false,
    });
    expect(deps.calls.complete).toBe(0);
    expect(deps.calls.deliver).toEqual(['t1']);
    expect(cache.size).toBe(1);
  });
  it('a second identical send replays from the cache: zero engine calls, the receipt names the engine', async () => {
    const cache = new Map<string, QuickDecisionCacheEntry>();
    let asks = 0;
    const deps = engineDeps({
      askEngine: async () => {
        asks += 1;
        return l1Reuse;
      },
    });
    await routeQuickDecisionIn(
      deps,
      cache,
      { shortCircuits: 0, fallbacks: 0, savedTurns: 0 },
      {
        input: '查一下 CNS 客户',
        positionMarker: 'supervisor',
      }
    );
    const verdict = await routeQuickDecisionIn(
      deps,
      cache,
      { shortCircuits: 0, fallbacks: 0, savedTurns: 0 },
      {
        input: '查一下 CNS 客户',
        positionMarker: 'supervisor',
      }
    );
    if (verdict.action !== 'reuse') throw new Error('expected a reuse replay');
    expect(verdict).toMatchObject({ action: 'reuse', cached: true, model: 'MU 决策引擎' });
    expect(verdict.tier).toBeUndefined(); // A replay runs no tier.
    expect(asks).toBe(1);
    expect(deps.calls.deliver).toEqual(['t1', 't1']);
  });
  it('an escalated L2 full verdict answers full and counts one fallback', async () => {
    const deps = engineDeps({
      askEngine: async () => ({
        ok: true,
        raw: '{"action":"full","reason":"不确定","confidence":0.9}',
        tier: 'L2',
        model: 'glm-5.3-flash',
      }),
    });
    const counters: QuickDecisionCounters = { shortCircuits: 0, fallbacks: 0, savedTurns: 0 };
    const verdict = await routeQuickDecisionIn(deps, new Map(), counters, {
      input: '模糊任务',
      positionMarker: 'supervisor',
    });
    expect(verdict).toEqual({ action: 'full', reason: '不确定' });
    expect(counters).toEqual({ shortCircuits: 0, fallbacks: 1, savedTurns: 0 });
  });
  it('an engine failure outcome answers full with the engine reason', async () => {
    const deps = engineDeps({ askEngine: async () => ({ ok: false, reason: 'l2-timeout' }) });
    expect(await run(deps, { input: '任务' })).toEqual({ action: 'full', reason: 'l2-timeout' });
  });
  it('an L1 reject on the position kind carries tier and probability too', async () => {
    const deps = engineDeps({
      askEngine: async () => ({
        ok: true,
        raw: '{"action":"reject","suggest":"video-lab","reason":"域外","confidence":0.91}',
        tier: 'L1',
        model: 'jev-1.13',
        probability: 0.91,
      }),
    });
    const verdict = await run(deps, { input: '剪视频', positionMarker: 'forwarder' });
    expect(verdict).toMatchObject({
      action: 'reject',
      suggestId: 'video-lab',
      tier: 'L1',
      probability: 0.91,
      model: 'jev-1.13',
    });
  });
  it('an L1 verdict naming an inactive team still answers full — the engine gets no pass on validation', async () => {
    const deps = engineDeps({
      askEngine: async () => ({
        ok: true,
        raw: '{"action":"reuse","teamId":"别的队","reason":"x","confidence":0.95}',
        tier: 'L1',
        model: 'jev-1.13',
        probability: 0.95,
      }),
    });
    expect(await run(deps, { input: '任务' })).toEqual({ action: 'full', reason: 'team-not-active' });
  });
});

describe('reuseSupervisorTeamIn — teams.cjs send semantics on the index', () => {
  const writeIndex = (dataDir: string, teams: SupervisorTeam[]): void => {
    mkdirSync(join(dataDir, 'positions', '_shared'), { recursive: true });
    writeFileSync(join(dataDir, 'positions', '_shared', 'TEAMS.md'), `${buildTeamsFile(teams, 0)}\n`, 'utf8');
  };
  const dataDir = (): string => {
    const dir = temp();
    mkdirSync(join(dir, 'positions'), { recursive: true });
    return dir;
  };

  it('refreshes lastUsedAt and extends the lease with the team own ttlDays', async () => {
    const dir = dataDir();
    writeIndex(dir, [team({ lastUsedAt: 0, expiresAt: 10, ttlDays: 3 })]);
    const refreshed = await reuseSupervisorTeamIn({ dataDir: dir }, { teamId: 't1', at: 1000 });
    expect(refreshed?.lastUsedAt).toBe(1000);
    expect(refreshed?.expiresAt).toBe(1000 + 3 * 24 * 60 * 60 * 1000);
  });
  it('a permanent team keeps its recorded expiry', async () => {
    const dir = dataDir();
    writeIndex(dir, [team({ permanent: true, expiresAt: 42 })]);
    const refreshed = await reuseSupervisorTeamIn({ dataDir: dir }, { teamId: 't1', at: 1000 });
    expect(refreshed?.expiresAt).toBe(42);
    expect(refreshed?.lastUsedAt).toBe(1000);
  });
  it('a soft-deleted or unknown id refreshes nothing', async () => {
    const dir = dataDir();
    writeIndex(dir, [team({ deletedAt: 5 })]);
    expect(await reuseSupervisorTeamIn({ dataDir: dir }, { teamId: 't1', at: 1000 })).toBeUndefined();
    expect(await reuseSupervisorTeamIn({ dataDir: dir }, { teamId: '别的', at: 1000 })).toBeUndefined();
  });
  it('a retired row still refreshes — a delivered task is a reuse whatever the clock said', async () => {
    const dir = dataDir();
    writeIndex(dir, [team({ expiresAt: 1, ttlDays: 7 })]); // retired at `now`=1000
    const refreshed = await reuseSupervisorTeamIn({ dataDir: dir }, { teamId: 't1', at: 1000 });
    expect(refreshed?.expiresAt).toBe(1000 + 7 * 24 * 60 * 60 * 1000);
  });
});
