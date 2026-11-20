/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import type { SupervisorTeam } from '@/common/chat/team/supervisor/supervisorCore';
import {
  askMuEngine,
  type MuEngineDeps,
  type MuEngineLlmJudge,
  type MuEngineSecrets,
} from '@process/services/team/quickDecision/muDecisionEngine';

/**
 * The engine's two-tier chain: L1 jev gated on `probabilities[choice]`
 * (act / escalate / full), L2 the runtime's own judge, and every missing
 * arm or failed call degrading safely — L1 may be wrong, never blocking,
 * and a missing L2 turns escalations into `full`.
 */

const position = (name: string, displayName: string, description: string): PositionInfo => ({
  name,
  displayName,
  description,
  body: `${displayName} 说明书。`,
});
const roster = [position('forwarder', '货代', '海运订舱'), position('video-lab', '视频实验室', '视频制作')];
const teams: SupervisorTeam[] = [
  {
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
  },
];
const judge: MuEngineLlmJudge = {
  providerId: 'zai-coding-cn',
  model: 'glm-5.3-flash',
  baseUrl: 'https://x',
  apiKey: 'k',
};
const prompt = { system: '判定器', user: '任务' };
const context = { task: '查运价', teams, roster };
const logs: string[] = [];

type Arm = { secrets: MuEngineSecrets; jev?: (payload: unknown) => Promise<unknown>; judgeRaw?: () => Promise<string> };

const depsOf = (arm: Arm): MuEngineDeps & { calls: { jev: number; judge: number } } => {
  const calls = { jev: 0, judge: 0 };
  return {
    calls,
    loadSecrets: () => arm.secrets,
    callJev: async (_token, payload) => {
      calls.jev += 1;
      return arm.jev?.(payload)?.then((answers) => ({ q: answers }));
    },
    completeJudge: async () => {
      calls.judge += 1;
      return arm.judgeRaw!();
    },
    log: (...args) => logs.push(args.join(' ')),
  };
};
const answer = (choice: string, probability: number, confidence = 0.5) => ({
  type: 'choice',
  choice,
  probabilities: { [choice]: probability },
  confidence,
});

describe('askMuEngine — L1 gate on probabilities[choice]', () => {
  it('a probability ≥0.85 short-circuits: the L1 decision JSON, tier and probability carried', async () => {
    const deps = depsOf({ secrets: { tregToken: 'tok', judge }, jev: async () => answer('reuse:t1', 0.93) });
    const asked = await askMuEngine(deps, 'supervisor-reuse', context, prompt, 2000);
    expect(asked).toEqual({
      ok: true,
      raw: JSON.stringify({ action: 'reuse', teamId: 't1', reason: 'jev 概率 0.93', confidence: 0.93 }),
      tier: 'L1',
      model: 'jev-1.13',
      probability: 0.93,
    });
    expect(deps.calls.judge).toBe(0);
  });
  it('a probability in [0.5, 0.85) escalates to L2, which answers with the ordinary judgment', async () => {
    const deps = depsOf({
      secrets: { tregToken: 'tok', judge },
      jev: async () => answer('reuse:t1', 0.7),
      judgeRaw: async () => '{"action":"full","reason":"不确定","confidence":0.9}',
    });
    const asked = await askMuEngine(deps, 'supervisor-reuse', context, prompt, 2000);
    expect(asked).toMatchObject({ ok: true, tier: 'L2', model: 'glm-5.3-flash' });
    expect(deps.calls.jev).toBe(1);
    expect(deps.calls.judge).toBe(1);
  });
  it('a probability <0.5 answers full outright, no L2 call', async () => {
    const deps = depsOf({ secrets: { tregToken: 'tok', judge }, jev: async () => answer('full', 0.3) });
    const asked = await askMuEngine(deps, 'supervisor-reuse', context, prompt, 2000);
    expect(asked).toEqual({ ok: false, reason: 'jev-low-probability' });
    expect(deps.calls.judge).toBe(0);
  });
  it('a high-probability full choice is also a short-circuit — full without the L2 call', async () => {
    const deps = depsOf({
      secrets: { tregToken: 'tok', judge },
      jev: async () => answer('full', 0.9),
      judgeRaw: async () => {
        throw new Error('must not run');
      },
    });
    const asked = await askMuEngine(deps, 'supervisor-reuse', context, prompt, 2000);
    expect(asked).toMatchObject({ ok: true, tier: 'L1' });
  });
});

describe('askMuEngine — degradation and failure', () => {
  it('no treg token: L1 never runs, L2 answers alone', async () => {
    const deps = depsOf({
      secrets: { judge },
      jev: async () => {
        throw new Error('must not run');
      },
      judgeRaw: async () => '{"action":"full","reason":"x","confidence":0.9}',
    });
    const asked = await askMuEngine(deps, 'supervisor-reuse', context, prompt, 2000);
    expect(asked).toMatchObject({ ok: true, tier: 'L2' });
    expect(deps.calls.jev).toBe(0);
  });
  it('a treg timeout or error escalates to L2 — L1 may be wrong, never blocking', async () => {
    for (const error of [new Error('treg http 500'), new Error('The operation was aborted')]) {
      const deps = depsOf({
        secrets: { tregToken: 'tok', judge },
        jev: async () => Promise.reject(error),
        judgeRaw: async () => '{"action":"full","reason":"x","confidence":0.9}',
      });
      const asked = await askMuEngine(deps, 'supervisor-reuse', context, prompt, 2000);
      expect(asked).toMatchObject({ ok: true, tier: 'L2' });
    }
  });
  it('an answer without usable probabilities escalates rather than guessing', async () => {
    const deps = depsOf({
      secrets: { tregToken: 'tok', judge },
      jev: async () => ({ type: 'choice', choice: 'reuse:t1', confidence: 0.99 }),
      judgeRaw: async () => '{"action":"full","reason":"x","confidence":0.9}',
    });
    expect(await askMuEngine(deps, 'supervisor-reuse', context, prompt, 2000)).toMatchObject({ ok: true, tier: 'L2' });
  });
  it('no callable judge: every escalation reads full, L1 still short-circuits', async () => {
    const escalate = depsOf({
      secrets: { tregToken: 'tok' },
      jev: async () => answer('reuse:t1', 0.6),
    });
    expect(await askMuEngine(escalate, 'supervisor-reuse', context, prompt, 2000)).toEqual({
      ok: false,
      reason: 'engine-judge-unavailable',
    });
    const act = depsOf({ secrets: { tregToken: 'tok' }, jev: async () => answer('reuse:t1', 0.95) });
    expect(await askMuEngine(act, 'supervisor-reuse', context, prompt, 2000)).toMatchObject({ ok: true, tier: 'L1' });
  });
  it('an L2 timeout or error answers full', async () => {
    const deps = depsOf({
      secrets: { tregToken: 'tok', judge },
      jev: async () => answer('reuse:t1', 0.6),
      judgeRaw: async () => Promise.reject(new Error('quick-decision-timeout')),
    });
    expect(await askMuEngine(deps, 'supervisor-reuse', context, prompt, 2000)).toEqual({
      ok: false,
      reason: 'l2-timeout',
    });
  });
});

describe('askMuEngine — the sanitized wire and the position kind', () => {
  it('L1 sends state sanitized and questions as built', async () => {
    let seen: { state: Record<string, unknown>; questions: unknown } | undefined;
    const deps = depsOf({
      secrets: { tregToken: 'tok', judge },
      jev: async (payload) => {
        seen = payload as { state: Record<string, unknown>; questions: unknown };
        return answer('reuse:t1', 0.9);
      },
    });
    await askMuEngine(deps, 'supervisor-reuse', { ...context, task: '联系 a@acme.com' }, prompt, 2000);
    expect(seen!.state.task as string).toContain('[EMAIL]');
    expect(seen!.questions).toHaveProperty('q.criteria');
  });
  it('point B builds reject choices for the other roster positions', async () => {
    let seen: { questions: { q: { criteria: Record<string, string> } } } | undefined;
    const deps = depsOf({
      secrets: { tregToken: 'tok', judge },
      jev: async (payload) => {
        seen = payload as never;
        return answer('reject:video-lab', 0.9);
      },
    });
    const asked = await askMuEngine(deps, 'position-domain', { ...context, position: roster[0]! }, prompt, 2000);
    expect(Object.keys(seen!.questions.q.criteria)).toEqual(['reject:video-lab', 'full']);
    expect(asked).toMatchObject({ ok: true, tier: 'L1', probability: 0.9 });
  });
});
