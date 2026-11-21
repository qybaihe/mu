/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  runContextStewardIn,
  type ContextStewardDeps,
  type StewardConversation,
} from '@process/services/team/contextSteward/contextStewardService';
import { freshStewardMemory, type StewardMemory } from '@/common/chat/team/contextSteward/contextStewardCore';
import type { ContextStewardRunResult } from '@/common/chat/team/contextSteward/contextStewardBridge';
import type { ContextStewardEngineResult } from '@process/services/team/quickDecision';

/**
 * The context steward's pipeline with everything faked (no HTTP, no
 * telemetry, no model). The assertion spine is the lossless direction —
 * every undecidable case switches where it may and compacts where it may
 * not — plus the hysteresis that keeps one action from repeating on its own
 * tail, and the in-flight guard that collapses a turn burst into one check.
 */

type Call = string;

const conversation = (over: Partial<StewardConversation> = {}): StewardConversation => ({
  name: '货代',
  assistantId: 'as-1',
  position: 'forwarder',
  ...over,
});

const overLineUsage = { tokens: 160_000, contextWindow: 200_000, percent: 0.8 };

const baseDeps = (over: Partial<ContextStewardDeps> = {}): ContextStewardDeps & { calls: Call[] } => {
  const calls: Call[] = [];
  const deps: ContextStewardDeps = {
    now: () => 1_000,
    readEnabled: async () => undefined,
    readRatio: async () => undefined,
    getConversation: async () => conversation(),
    readUsage: async () => ({ usage: overLineUsage, cursor: 10 }),
    lastAssistantExcerpt: async () => '正在查 CNS 客户名单，稍后回报。',
    askEngine: async () => ({ answered: true, action: 'switch', reason: '任务进行中', model: 'test', durationMs: 3 }),
    sendCompact: async () => {
      calls.push('compact');
    },
    createPart: async () => {
      calls.push('createPart');
      return { id: 'new-part' };
    },
    listConversationTitles: async () => [],
    renameConversation: async (_id, name) => {
      calls.push(`rename:${name}`);
    },
    log: () => {},
    ...over,
  };
  return { ...deps, calls };
};

const run = (
  deps: ContextStewardDeps,
  states: Map<string, StewardMemory>,
  conversationId = 'conv-1'
): Promise<ContextStewardRunResult> =>
  runContextStewardIn(deps, states, new Map<string, Promise<ContextStewardRunResult>>(), conversationId);

describe('eligibility and the line', () => {
  it('answers skip and touches nothing while disabled, gone, unstewarded, unreadable or below the line', async () => {
    const states = new Map<string, StewardMemory>();
    for (const over of [
      { readEnabled: async () => false },
      { getConversation: async (): Promise<StewardConversation | undefined> => undefined },
      { getConversation: async () => conversation({ position: undefined, teamId: undefined }) },
      { readUsage: async () => ({ usage: undefined, cursor: 0 }) },
      { readUsage: async () => ({ usage: { tokens: null, contextWindow: 200_000, percent: null }, cursor: 0 }) },
      { readUsage: async () => ({ usage: { tokens: 10_000, contextWindow: 200_000, percent: 0.05 }, cursor: 0 }) },
    ]) {
      const deps = baseDeps(over);
      const answer = await run(deps, states);
      expect(answer.action).toBe('skip');
      expect(deps.calls).toEqual([]);
    }
    // Nothing crossed the line: no state carries a watermark, nothing was asked.
    for (const memory of states.values()) expect(memory.watermark).toBeUndefined();
  });

  it('honors the ratio override the E2E uses to move the line', async () => {
    const states = new Map<string, StewardMemory>();
    const deps = baseDeps({
      readRatio: async () => 0.01,
      readUsage: async () => ({ usage: { tokens: 2_500, contextWindow: 200_000, percent: 0.0125 }, cursor: 3 }),
    });
    const answer = await run(deps, states);
    expect(answer.action).toBe('switch'); // 2500 > 1836: over a 1% line, under the default one.
  });
});

describe('the decision and its lossless direction', () => {
  it('acts on the engine answer: a switch creates the part, renames the old one, and returns the chain', async () => {
    const states = new Map<string, StewardMemory>();
    const deps = baseDeps();
    const answer = await run(deps, states, 'conv-1');
    expect(answer).toMatchObject({
      action: 'switch',
      oldConversationId: 'conv-1',
      newConversationId: 'new-part',
      oldTitle: '货代 (part 1)',
      newTitle: '货代',
      part: 1,
    });
    expect(deps.calls).toEqual(['createPart', 'rename:货代 (part 1)']);
    expect(states.get('conv-1')?.watermark).toBe(160_000);
    expect(states.has('new-part')).toBe(false); // The fresh part starts with fresh memory.
  });

  it('bumps the old part number past a title another conversation already holds', async () => {
    const states = new Map<string, StewardMemory>();
    const deps = baseDeps({ listConversationTitles: async () => ['货代', '货代 (part 1)'] });
    const answer = await run(deps, states, 'conv-1');
    expect(answer).toMatchObject({ action: 'switch', oldTitle: '货代 (part 2)', part: 2 });
    expect(deps.calls).toEqual(['createPart', 'rename:货代 (part 2)']);
  });

  it('still switches with plain numbering when the title listing fails', async () => {
    const states = new Map<string, StewardMemory>();
    const deps = baseDeps({
      listConversationTitles: async () => {
        throw new Error('list down');
      },
    });
    const answer = await run(deps, states);
    expect(answer).toMatchObject({ action: 'switch', oldTitle: '货代 (part 1)', part: 1 });
    expect(deps.calls).toEqual(['createPart', 'rename:货代 (part 1)']);
  });

  it('switches when the engine cannot answer at all — the lossless fallback', async () => {
    const states = new Map<string, StewardMemory>();
    const deps = baseDeps({
      askEngine: async (): Promise<ContextStewardEngineResult> => ({ answered: false, reason: 'no-model-configured' }),
    });
    const answer = await run(deps, states);
    expect(answer.action).toBe('switch');
    expect(deps.calls).toEqual(['createPart', 'rename:货代 (part 1)']);
  });

  it('compacts when the engine cannot answer AND the conversation cannot switch (team thread)', async () => {
    const states = new Map<string, StewardMemory>();
    const deps = baseDeps({
      getConversation: async () => conversation({ position: undefined, teamId: 'team-9' }),
      askEngine: async (): Promise<ContextStewardEngineResult> => ({ answered: false, reason: 'timeout' }),
    });
    const answer = await run(deps, states);
    expect(answer.action).toBe('compact');
    expect(deps.calls).toEqual(['compact']);
  });

  it('narrows an engine switch on a team thread to compact — the slots must not be stranded', async () => {
    const states = new Map<string, StewardMemory>();
    const deps = baseDeps({ getConversation: async () => conversation({ position: undefined, teamId: 'team-9' }) });
    const answer = await run(deps, states);
    expect(answer.action).toBe('compact');
    expect(deps.calls).toEqual(['compact']);
    expect(states.get('conv-1')?.compactions).toBe(1);
  });

  it('compacts on the engine word and counts it', async () => {
    const states = new Map<string, StewardMemory>();
    const deps = baseDeps({
      askEngine: async () => ({ answered: true, action: 'compact', reason: '已收尾', model: 'test', durationMs: 1 }),
    });
    const answer = await run(deps, states);
    expect(answer).toMatchObject({ action: 'compact', reason: '已收尾', tokens: 160_000 });
    expect(deps.calls).toEqual(['compact']);
    expect(states.get('conv-1')?.compactions).toBe(1);
  });

  it('holds on none without losing the hysteresis — the same turn does not re-ask', async () => {
    const states = new Map<string, StewardMemory>();
    const deps = baseDeps({
      askEngine: async () => ({ answered: true, action: 'none', reason: '刚压过', model: 'test', durationMs: 1 }),
    });
    const answer = await run(deps, states);
    expect(answer).toEqual({ action: 'none', reason: '刚压过' });
    expect(states.get('conv-1')?.watermark).toBe(160_000);
    const again = await run(
      baseDeps({
        askEngine: async () => {
          throw new Error('must not ask');
        },
      }),
      states
    );
    expect(again).toMatchObject({ action: 'skip', reason: 'below-line' });
  });
});

describe('failure surfaces', () => {
  it('a failed compact leaves the watermark untouched so the next turn re-asks', async () => {
    const states = new Map<string, StewardMemory>();
    const deps = baseDeps({
      getConversation: async () => conversation({ position: undefined, teamId: 'team-9' }),
      askEngine: async (): Promise<ContextStewardEngineResult> => ({ answered: false, reason: 'timeout' }),
      sendCompact: async () => {
        throw new Error('backend down');
      },
    });
    const answer = await run(deps, states);
    expect(answer).toMatchObject({ action: 'skip', reason: 'compact-failed' });
    expect(states.get('conv-1')?.compactions).toBe(0);
    expect(states.get('conv-1')?.watermark).toBeUndefined();
  });

  it('a failed part creation skips the rename — a name without a part is not a chain', async () => {
    const states = new Map<string, StewardMemory>();
    const deps = baseDeps({
      createPart: async () => {
        throw new Error('create failed');
      },
    });
    const answer = await run(deps, states);
    expect(answer).toMatchObject({ action: 'skip', reason: 'part-creation-failed' });
    expect(deps.calls).toEqual([]);
  });

  it('a failed rename after a created part keeps the switch — the chain holds, only the label failed', async () => {
    const states = new Map<string, StewardMemory>();
    const deps = baseDeps({
      renameConversation: async () => {
        throw new Error('rename failed');
      },
    });
    const answer = await run(deps, states);
    expect(answer.action).toBe('switch');
    expect(deps.calls).toEqual(['createPart']); // The rename was attempted and failed — only the label is lost.
  });
});

describe('in-flight guard', () => {
  it('collapses a burst of turn-ends into one check', async () => {
    const states = new Map<string, StewardMemory>();
    const flights = new Map<string, Promise<ContextStewardRunResult>>();
    let reads = 0;
    const deps = baseDeps({
      getConversation: async () => {
        reads += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return conversation();
      },
    });
    const [first, second] = await Promise.all([
      runContextStewardIn(deps, states, flights, 'conv-1'),
      runContextStewardIn(deps, states, flights, 'conv-1'),
    ]);
    expect(reads).toBe(1); // The second caller reuses the first check's answer.
    expect(first).toEqual(second);
    expect(flights.size).toBe(0); // The guard cleans up after itself.
  });
});

describe('hysteresis across turns', () => {
  it('does not re-ask after a compact until the session grows by check/4 again', async () => {
    const states = new Map<string, StewardMemory>();
    const asks: number[] = [];
    const deps = baseDeps({
      getConversation: async () => conversation({ position: undefined, teamId: 'team-9' }),
      askEngine: async (): Promise<ContextStewardEngineResult> => {
        asks.push(1);
        return { answered: false, reason: 'timeout' };
      },
    });
    await run(deps, states); // compact #1 at 160k
    const after = baseDeps({
      getConversation: async () => conversation({ position: undefined, teamId: 'team-9' }),
      askEngine: async (): Promise<ContextStewardEngineResult> => {
        asks.push(1);
        return { answered: false, reason: 'timeout' };
      },
    });
    const still = await run(
      { ...after, readUsage: async () => ({ usage: { ...overLineUsage, tokens: 170_000 }, cursor: 20 }) },
      states
    );
    expect(still).toMatchObject({ action: 'skip', reason: 'below-line' }); // +10k < check/4 (~36.7k)
    const grown = await run(
      { ...after, readUsage: async () => ({ usage: { ...overLineUsage, tokens: 200_000 }, cursor: 30 }) },
      states
    );
    expect(grown.action).toBe('compact');
    expect(asks.length).toBe(2);
  });
});
