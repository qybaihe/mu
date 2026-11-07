import { describe, expect, it } from 'vitest';
import type { Activity } from '@/common/kyrn/types';
import {
  goalIsLive,
  offersGoal,
  reduceGoalState,
  GOAL_CLEAR_COMMAND,
} from '@/renderer/pages/conversation/platforms/acp/Composer/goalState';

const goalEvent = (id: string, payload: Record<string, unknown>): Activity => ({
  id,
  at: 0,
  kind: 'goal.state',
  payload,
});

describe('offersGoal', () => {
  it('finds a goal only where the agent offers the goal command', () => {
    expect(offersGoal([{ name: 'permissions' }, { name: 'goal' }])).toBe(true);
    expect(offersGoal([{ name: 'goals' }, { name: 'compact' }])).toBe(false);
    expect(offersGoal([])).toBe(false);
  });
});

describe('the goal command', () => {
  it('ends a goal with mu’s own words for it', () => {
    expect(GOAL_CLEAR_COMMAND).toBe('/goal clear');
  });
});

describe('reduceGoalState', () => {
  it('reads the goal the harness last reported', () => {
    const goal = reduceGoalState(null, [
      goalEvent('1', { status: 'active', text: 'every test passes', continuations: 0 }),
    ]);
    expect(goal).toEqual({ status: 'active', text: 'every test passes' });
  });

  it('lets a later state win inside one page', () => {
    const goal = reduceGoalState(null, [
      goalEvent('1', { status: 'active', text: 'every test passes' }),
      goalEvent('2', { status: 'paused', text: 'every test passes', reason: 'waiting for you' }),
    ]);
    expect(goal).toEqual({ status: 'paused', text: 'every test passes' });
  });

  it('keeps what it had when a page carries no goal event', () => {
    const previous = { status: 'active' as const, text: 'every test passes' };
    expect(reduceGoalState(previous, [{ id: '9', at: 0, kind: 'decision', payload: {} }])).toBe(previous);
  });

  it('ignores a payload with no usable status or condition', () => {
    expect(reduceGoalState(null, [goalEvent('1', { status: 'sideways', text: 'x' })])).toBeNull();
    expect(reduceGoalState(null, [goalEvent('2', { status: 'active', text: '   ' })])).toBeNull();
  });
});

describe('goalIsLive', () => {
  it('counts a running goal and a paused one, because the next message picks it up', () => {
    expect(goalIsLive({ status: 'active', text: 'x' })).toBe(true);
    expect(goalIsLive({ status: 'paused', text: 'x' })).toBe(true);
  });

  it('does not count a goal that is met, cleared or absent', () => {
    expect(goalIsLive({ status: 'met', text: 'x' })).toBe(false);
    expect(goalIsLive({ status: 'cleared', text: 'x' })).toBe(false);
    expect(goalIsLive(null)).toBe(false);
  });
});
