import { describe, expect, it } from 'vitest';
import {
  durable,
  fromEntries,
  PRESENTATION_STATUS_KEY,
  readGoal,
  reduceAll,
  type PiRecord,
} from '@/common/utils/nativeHost/index.ts';

/**
 * mu's goal in the view: its latest `kyrn.goal` entry on the branch (live from `entry_appended`, in a file as it is),
 * or a `goal.state` frame after it. Live and read back, the same entries give the same goal.
 */

type Json = Record<string, unknown>;

const goalEntry = (id: string, data: Json): Json => ({ type: 'custom', id, customType: 'kyrn.goal', data });
const message = (id: string, text: string): Json => ({
  type: 'message',
  id,
  message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
});
function file(entries: Json[]): Json[] {
  return entries.map((entry, index) => ({ ...entry, parentId: index ? entries[index - 1].id : null }));
}
const goalFrame = (payload: Json): PiRecord => ({
  type: 'extension_ui_request',
  id: 'f1',
  method: 'setStatus',
  statusKey: PRESENTATION_STATUS_KEY,
  statusText: JSON.stringify({ version: 1, kind: 'goal.state', payload, at: 5 }),
});

describe('the goal of a view', () => {
  it('is the latest goal entry on the branch of a file', () => {
    const entries = file([
      message('u1', '/goal the docs build'),
      goalEntry('g1', { status: 'active', text: 'the docs build', continuations: 0 }),
      goalEntry('g2', { status: 'paused', text: 'the docs build', reasonCode: 'interrupted' }),
    ]);
    expect(fromEntries(entries).goal).toEqual({ status: 'paused', text: 'the docs build' });
    // An earlier leaf: the branch there had the goal running.
    expect(fromEntries(entries, 'g1').goal).toEqual({ status: 'active', text: 'the docs build' });
    expect(fromEntries(entries, 'u1').goal).toBeUndefined();
  });

  it('comes live from the appended entries as from the file, and a frame after them has the last word', () => {
    const entries = [
      goalEntry('g1', { status: 'active', text: 'tests pass' }),
      goalEntry('g2', { status: 'met', text: 'tests pass' }),
    ];
    const live = reduceAll(entries.map((entry) => ({ type: 'entry_appended', entry })));
    expect(live.goal).toEqual({ status: 'met', text: 'tests pass' });
    expect(durable(live)).toEqual(fromEntries(file(entries)));
    // mu resumed a session whose goal ran: it says it paused, and writes no entry for it.
    const resumed = reduceAll(
      [goalFrame({ status: 'paused', text: 'tests pass', reasonCode: 'session_reopened' })],
      live
    );
    expect(resumed.goal).toEqual({ status: 'paused', text: 'tests pass' });
  });

  it('keeps what it had when an entry or a frame says nothing usable', () => {
    expect(readGoal({ status: 'done', text: 'x' })).toBeUndefined();
    expect(readGoal({ status: 'active', text: '  ' })).toBeUndefined();
    const view = fromEntries(
      file([goalEntry('g1', { status: 'active', text: 'ship' }), goalEntry('g2', { status: 'active' })])
    );
    expect(view.goal).toEqual({ status: 'active', text: 'ship' });
    expect(reduceAll([goalFrame({ status: 'weird', text: 'ship' })], view).goal).toEqual(view.goal);
  });
});
