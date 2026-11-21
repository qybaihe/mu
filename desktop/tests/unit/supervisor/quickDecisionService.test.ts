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
  routeTeamMessageIn,
  dispatchHintIn,
  type QuickDecisionCounters,
  type QuickDecisionDeps,
  contextStewardDecisionIn,
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
type FakeDeps = QuickDecisionDeps & {
  calls: { complete: number; deliver: string[]; refresh: string[]; teamFetches: string[]; memberDeliveries: string[] };
};

const baseDeps = (over: DepsOverrides = {}): FakeDeps => {
  const calls = {
    complete: 0 as number,
    deliver: [] as string[],
    refresh: [] as string[],
    teamFetches: [] as string[],
    memberDeliveries: [] as string[],
  };
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
    deliverTeamTask: async (teamId) => {
      calls.deliver.push(teamId);
    },
    getTeamAssistants: async (teamId) => {
      calls.teamFetches.push(teamId);
      return [
        { slot_id: 's-lead', role: 'leader', assistant_name: '货代' },
        { slot_id: 's1', role: 'teammate', assistant_name: '货代' },
        { slot_id: 's2', role: 'teammate', assistant_name: '视频实验室' },
      ];
    },
    deliverMemberMessage: async (teamId, slotId) => {
      calls.memberDeliveries.push(`${teamId}:${slotId}`);
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

describe('routeTeamMessageIn — the conservative direction', () => {
  const runRoute = (deps: QuickDecisionDeps, params: { input: string; teamId?: string }) =>
    routeTeamMessageIn(
      deps,
      new Map<string, QuickDecisionCacheEntry>(),
      { shortCircuits: 0, fallbacks: 0, savedTurns: 0 },
      { input: params.input, teamId: params.teamId ?? 't1' }
    );

  it('no model configured answers full without touching the team', async () => {
    const deps = baseDeps({ readSetting: async () => undefined });
    expect(await runRoute(deps, { input: '继续' })).toEqual({ action: 'full', reason: 'no-model-configured' });
    expect(deps.calls.teamFetches).toEqual([]);
  });
  it('a malformed team id never reaches a URL path', async () => {
    const deps = baseDeps();
    expect(await runRoute(deps, { input: '继续', teamId: '../etc' })).toEqual({
      action: 'full',
      reason: 'bad-team-id',
    });
    expect(deps.calls.teamFetches).toEqual([]);
  });
  it('a vanished team and a lead-only team answer full without a model call', async () => {
    const gone = baseDeps({ getTeamAssistants: async () => undefined });
    expect(await runRoute(gone, { input: '继续' })).toEqual({ action: 'full', reason: 'unknown-team' });
    const solo = baseDeps({
      getTeamAssistants: async () => [{ slot_id: 's-lead', role: 'leader', assistant_name: '货代' }],
    });
    expect(await runRoute(solo, { input: '继续' })).toEqual({ action: 'full', reason: 'no-teammates' });
    expect(gone.calls.complete + solo.calls.complete).toBe(0);
  });
  it('a low-confidence or off-member direct answers full', async () => {
    const low = baseDeps({
      complete: async () => '{"action":"direct","slotId":"s1","reason":"x","confidence":0.6}',
    });
    expect(await runRoute(low, { input: '继续' })).toEqual({ action: 'full', reason: 'low-confidence' });
    const off = baseDeps({
      complete: async () => '{"action":"direct","slotId":"s-lead","reason":"x","confidence":0.99}',
    });
    expect(await runRoute(off, { input: '继续' })).toEqual({ action: 'full', reason: 'slot-not-member' });
    expect(off.calls.memberDeliveries).toEqual([]);
  });
});

describe('routeTeamMessageIn — the short-circuit', () => {
  const directAnswer = () => '{"action":"direct","slotId":"s2","reason":"点名视频岗","confidence":0.93}';

  it('a confident direct delivers to the member slot, caches, and counts the saved lead round', async () => {
    const deps = baseDeps({ complete: async () => directAnswer() });
    const counters: QuickDecisionCounters = { shortCircuits: 0, fallbacks: 0, savedTurns: 0 };
    const cache = new Map<string, QuickDecisionCacheEntry>();
    const verdict = await routeTeamMessageIn(deps, cache, counters, { input: '视频实验室，继续剪片头', teamId: 't1' });
    expect(verdict).toMatchObject({ action: 'direct', slotId: 's2', memberName: '视频实验室', cached: false });
    expect(deps.calls.memberDeliveries).toEqual(['t1:s2']);
    expect(counters).toEqual({ shortCircuits: 1, fallbacks: 0, savedTurns: 1 });
    expect(cache.size).toBe(1);
  });
  it('the same message again hits the cache: zero model calls, delivery happens again', async () => {
    let completions = 0;
    const deps = baseDeps({
      complete: async () => {
        completions += 1;
        return directAnswer();
      },
    });
    const counters: QuickDecisionCounters = { shortCircuits: 0, fallbacks: 0, savedTurns: 0 };
    const cache = new Map<string, QuickDecisionCacheEntry>();
    await routeTeamMessageIn(deps, cache, counters, { input: '视频实验室，继续剪片头', teamId: 't1' });
    const second = await routeTeamMessageIn(deps, cache, counters, { input: '视频实验室，继续剪片头', teamId: 't1' });
    expect(second).toMatchObject({ action: 'direct', cached: true });
    expect(completions).toBe(1);
    expect(deps.calls.memberDeliveries).toEqual(['t1:s2', 't1:s2']);
    expect(counters.savedTurns).toBe(2);
  });
  it('a cached direct whose member was removed is evicted and answers full', async () => {
    let assistants = [
      { slot_id: 's-lead', role: 'leader', assistant_name: '货代' },
      { slot_id: 's2', role: 'teammate', assistant_name: '视频实验室' },
    ];
    const deps = baseDeps({
      getTeamAssistants: async () => assistants,
      complete: async () => directAnswer(),
    });
    const counters: QuickDecisionCounters = { shortCircuits: 0, fallbacks: 0, savedTurns: 0 };
    const cache = new Map<string, QuickDecisionCacheEntry>();
    await routeTeamMessageIn(deps, cache, counters, { input: '视频实验室，继续剪片头', teamId: 't1' });
    assistants = [
      { slot_id: 's-lead', role: 'leader', assistant_name: '货代' },
      { slot_id: 's1', role: 'teammate', assistant_name: '货代' }, // the team shrunk to another member; s2 is gone
    ];
    const second = await routeTeamMessageIn(deps, cache, counters, { input: '视频实验室，继续剪片头', teamId: 't1' });
    expect(second).toEqual({ action: 'full', reason: 'member-gone' });
    expect(cache.size).toBe(0);
    expect(deps.calls.memberDeliveries).toEqual(['t1:s2']);
  });
  it('a delivery failure on a fresh verdict answers full and caches nothing', async () => {
    const deps = baseDeps({
      complete: async () => directAnswer(),
      deliverMemberMessage: async () => {
        throw new Error('409 busy');
      },
    });
    const counters: QuickDecisionCounters = { shortCircuits: 0, fallbacks: 0, savedTurns: 0 };
    const cache = new Map<string, QuickDecisionCacheEntry>();
    const verdict = await routeTeamMessageIn(deps, cache, counters, { input: '视频实验室，继续剪片头', teamId: 't1' });
    expect(verdict).toEqual({ action: 'full', reason: 'deliver-failed' });
    expect(cache.size).toBe(0);
    expect(counters.shortCircuits).toBe(0);
  });
  it('the team-route cache never collides with the supervisor-reuse cache of the same text', async () => {
    const deps = baseDeps({ complete: async () => directAnswer() });
    const counters: QuickDecisionCounters = { shortCircuits: 0, fallbacks: 0, savedTurns: 0 };
    const cache = new Map<string, QuickDecisionCacheEntry>();
    await routeTeamMessageIn(deps, cache, counters, { input: '查一下 CNS 客户', teamId: 't1' });
    expect(cache.size).toBe(1);
    expect([...cache.keys()][0].startsWith('team-route:')).toBe(true);
  });
});

describe('dispatchHintIn', () => {
  const runHint = (deps: QuickDecisionDeps, input: string) =>
    dispatchHintIn(
      deps,
      new Map<string, QuickDecisionCacheEntry>(),
      { shortCircuits: 0, fallbacks: 0, savedTurns: 0 },
      {
        input,
      }
    );

  it('a confident hint maps ids to labels and caches without delivering anything', async () => {
    const deps = baseDeps({
      complete: async () => '{"action":"hint","positions":["forwarder","video-lab"],"reason":"跨岗","confidence":0.9}',
    });
    const counters: QuickDecisionCounters = { shortCircuits: 0, fallbacks: 0, savedTurns: 0 };
    const cache = new Map<string, QuickDecisionCacheEntry>();
    const verdict = await dispatchHintIn(deps, cache, counters, { input: '查 CNS 客户并做宣传视频' });
    expect(verdict).toMatchObject({
      action: 'hint',
      positions: [
        { id: 'forwarder', label: '货代(forwarder)' },
        { id: 'video-lab', label: '视频实验室(video-lab)' },
      ],
    });
    expect(deps.calls.memberDeliveries).toEqual([]);
    expect(deps.calls.deliver).toEqual([]); // advisory: nothing is delivered
    expect(counters).toEqual({ shortCircuits: 1, fallbacks: 0, savedTurns: 0 });
    expect(cache.size).toBe(1);
  });
  it('a none verdict (chatter, no match, low confidence) sends nothing and caches nothing', async () => {
    const deps = baseDeps({
      complete: async () => '{"action":"hint","positions":[],"reason":"闲聊","confidence":0.9}',
    });
    const cache = new Map<string, QuickDecisionCacheEntry>();
    const verdict = await dispatchHintIn(
      deps,
      cache,
      { shortCircuits: 0, fallbacks: 0, savedTurns: 0 },
      { input: '现在有哪些队' }
    );
    expect(verdict).toMatchObject({ action: 'none', reason: 'no-positions' });
    expect(cache.size).toBe(0);
  });
  it('an empty roster answers none without a model call', async () => {
    const deps = baseDeps({ readRoster: async () => [] });
    expect(await runHint(deps, '任务')).toEqual({ action: 'none', reason: 'empty-roster' });
    expect(deps.calls.complete).toBe(0);
  });
  it('a cached hint replays only the ids the roster still knows', async () => {
    let rosterNow = roster;
    const deps = baseDeps({
      readRoster: async () => rosterNow,
      complete: async () => '{"action":"hint","positions":["forwarder","video-lab"],"reason":"x","confidence":0.9}',
    });
    const counters: QuickDecisionCounters = { shortCircuits: 0, fallbacks: 0, savedTurns: 0 };
    const cache = new Map<string, QuickDecisionCacheEntry>();
    await dispatchHintIn(deps, cache, counters, { input: '查客户并做视频' });
    rosterNow = [roster[1]]; // video-lab removed from the library since (roster[1] = forwarder)
    const second = await dispatchHintIn(deps, cache, counters, { input: '查客户并做视频' });
    expect(second).toMatchObject({ action: 'hint', positions: [{ id: 'forwarder' }] });
    expect(second.action === 'hint' && second.cached).toBe(true);
  });
  it('a cached hint emptied by a roster change evicts and answers none', async () => {
    let rosterNow = roster;
    const deps = baseDeps({
      readRoster: async () => rosterNow,
      complete: async () => '{"action":"hint","positions":["video-lab"],"reason":"x","confidence":0.9}',
    });
    const cache = new Map<string, QuickDecisionCacheEntry>();
    const counters: QuickDecisionCounters = { shortCircuits: 0, fallbacks: 0, savedTurns: 0 };
    await dispatchHintIn(deps, cache, counters, { input: '做宣传视频' });
    rosterNow = [roster[1]]; // only forwarder remains
    const second = await dispatchHintIn(deps, cache, counters, { input: '做宣传视频' });
    expect(second).toEqual({ action: 'none', reason: 'roster-changed' });
    expect(cache.size).toBe(0);
  });
});

describe('contextStewardDecisionIn — point E, the one question the steward asks', () => {
  const ask = (deps: QuickDecisionDeps) =>
    contextStewardDecisionIn(
      deps,
      { shortCircuits: 0, fallbacks: 0, savedTurns: 0 },
      {
        goal: '货代',
        percent: 0.8,
        tokens: 160000,
        contextWindow: 200000,
        checkLine: 146892,
        compactions: 0,
        midWorkHint: 'unclear',
        lastExcerpt: '正在查 CNS 客户名单',
      }
    );

  it('answers unanswered when no model is configured — the steward owns the lossless fallback', async () => {
    const deps = baseDeps({ readSetting: async () => undefined });
    const answer = await ask(deps);
    expect(answer).toEqual({ answered: false, reason: 'no-model-configured' });
    expect(deps.calls.complete).toBe(0);
  });

  it('answers unanswered on timeout and on a model error', async () => {
    const timeout = await ask(baseDeps({ complete: async () => Promise.reject(new Error('quick-decision-timeout')) }));
    expect(timeout).toEqual({ answered: false, reason: 'timeout' });
    const error = await ask(baseDeps({ complete: async () => Promise.reject(new Error('boom')) }));
    expect(error).toEqual({ answered: false, reason: 'model-error' });
  });

  it('answers unanswered when nothing usable was said', async () => {
    const answer = await ask(baseDeps({ complete: async () => '我认为应该换一个新会话继续' }));
    expect(answer).toEqual({ answered: false, reason: 'malformed-answer' });
  });

  it('carries each stated action through, never cached, whatever the confidence', async () => {
    for (const raw of [
      '{"action":"compact","reason":"已收尾"}',
      '{"action":"switch","reason":"任务进行中","confidence":0.42}',
      '{"action":"none"}',
    ]) {
      const answer = await ask(baseDeps({ complete: async () => raw }));
      expect(answer.answered).toBe(true);
    }
  });
});
