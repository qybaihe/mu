/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The monitor core's derivations: how a position card merges its session and
 * its team slots into one state, how a team card reads its members' dots,
 * task progress and TTL, and how the walls split active from retired.
 */
import { describe, expect, it } from 'vitest';
import type { PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import type { ITeamSlotWork, ITeamTaskItem, TTeam, TeamAssistant } from '@/common/types/team/teamTypes';
import type { TeamRosterEntry } from '@renderer/pages/team/core/teamIdentity';
import { slotMatchesPosition } from '@renderer/pages/team/core/teamIdentity';
import {
  isNearExpiry,
  memberDotOf,
  monitorActiveCount,
  positionCardsOf,
  relativeTimeBucket,
  teamCardsOf,
  ttlDaysOf,
  type SlotWorkIndex,
} from '@renderer/pages/monitor/monitorCore';

const position = (name: string, displayName: string): PositionInfo => ({
  name,
  displayName,
  description: '',
  body: '',
});

const assistant = (slotId: string, name: string, role: 'leader' | 'teammate' = 'teammate'): TeamAssistant => ({
  slot_id: slotId,
  conversation_id: `c-${slotId}`,
  role,
  assistant_backend: 'acp',
  assistant_name: name,
  status: 'idle',
});

const team = (id: string, assistants: TeamAssistant[], updatedAt = 1): TTeam => ({
  id,
  user_id: 'u1',
  name: `队${id}`,
  workspace: 'E:/w',
  workspace_mode: 'isolated',
  leader_assistant_id: assistants[0]?.slot_id ?? 's0',
  assistants,
  created_at: 1,
  updated_at: updatedAt,
});

const rosterEntry = (
  source: TTeam,
  retired: boolean,
  expiresAt?: number,
  ttlDays?: number,
  permanent?: boolean,
  deletedAt?: number
): TeamRosterEntry => ({
  team: source,
  memberCount: source.assistants.length,
  leadConversationId: source.assistants.find((member) => member.role === 'leader')?.conversation_id,
  conversationIds: source.assistants.map((member) => member.conversation_id),
  retired,
  deleted: deletedAt !== undefined,
  deletedAt,
  expiresAt,
  ttlDays,
  permanent: permanent ?? false,
});

const work = (slotId: string, state: ITeamSlotWork['state'], queued = 0): ITeamSlotWork => ({
  slot_id: slotId,
  role: 'teammate',
  state,
  queued_foreground_count: queued,
  queued_background_count: 0,
  active_turn_id: null,
  active_turn_started_at_ms: null,
  active_turn_elapsed_ms: null,
  active_turn_slow: null,
  active_turn_slow_threshold_ms: null,
  blocked_reason: null,
  team_run_id: null,
});

const task = (id: string, owner: string, status: string, updatedAt: number): ITeamTaskItem => ({
  id,
  team_id: 't1',
  subject: `任务-${id}`,
  status,
  owner,
  blocked_by: [],
  blocks: [],
  created_at: 1,
  updated_at: updatedAt,
});

const DAY = 24 * 60 * 60 * 1000;

describe('positionCardsOf', () => {
  const positions = [position('forwarder', '货代'), position('reviewer', '评审')];
  const conversation = {
    id: 'c-fwd',
    modified_at: 100,
    extra: { position: 'forwarder' },
  };

  it('a position with nothing attached reads idle and holds no conversation', () => {
    const cards = positionCardsOf({
      positions,
      conversations: [],
      generatingIds: new Set(),
      waitingConfirmationIds: new Set(),
      roster: [],
      tasksByTeam: new Map(),
      slotWork: new Map(),
    });
    expect(cards.map((card) => [card.position.name, card.state, card.conversationId])).toEqual([
      ['forwarder', 'idle', undefined],
      ['reviewer', 'idle', undefined],
    ]);
  });

  it('the session is the first source: generating works, a pending confirmation waits', () => {
    const base = {
      positions,
      conversations: [conversation],
      roster: [] as TeamRosterEntry[],
      tasksByTeam: new Map<string, ITeamTaskItem[]>(),
      slotWork: new Map() as SlotWorkIndex,
    };
    expect(
      positionCardsOf({ ...base, generatingIds: new Set(['c-fwd']), waitingConfirmationIds: new Set() })[0].state
    ).toBe('working');
    expect(
      positionCardsOf({ ...base, generatingIds: new Set(), waitingConfirmationIds: new Set(['c-fwd']) })[0].state
    ).toBe('waiting');
  });

  it('a running slot of the position in an active team works — the numbered second slot included', () => {
    const teamA = team('t1', [
      assistant('s-lead', '货代', 'leader'),
      assistant('s-2', '评审'),
      assistant('s-3', '货代 2'),
    ]);
    const cards = positionCardsOf({
      positions,
      conversations: [],
      generatingIds: new Set(),
      waitingConfirmationIds: new Set(),
      roster: [rosterEntry(teamA, false, Date.now() + DAY)],
      tasksByTeam: new Map(),
      slotWork: new Map([['t1', new Map([['s-3', work('s-3', 'running')]])]]),
    });
    expect(cards[0]).toMatchObject({ state: 'working', inProgressCount: 0 });
    expect(cards[1].state).toBe('idle');
  });

  it('a queued slot waits; a retired team contributes nothing', () => {
    const teamA = team('t1', [assistant('s-1', '货代', 'leader')]);
    const retired = rosterEntry(teamA, true, Date.now() - DAY);
    expect(
      positionCardsOf({
        positions,
        conversations: [],
        generatingIds: new Set(),
        waitingConfirmationIds: new Set(),
        roster: [retired],
        tasksByTeam: new Map(),
        slotWork: new Map([['t1', new Map([['s-1', work('s-1', 'queued')]])]]),
      })[0].state
    ).toBe('idle');
    const active = rosterEntry(teamA, false, Date.now() + DAY);
    expect(
      positionCardsOf({
        positions,
        conversations: [],
        generatingIds: new Set(),
        waitingConfirmationIds: new Set(),
        roster: [active],
        tasksByTeam: new Map(),
        slotWork: new Map([['t1', new Map([['s-1', work('s-1', 'queued')]])]]),
      })[0].state
    ).toBe('waiting');
  });

  it('in-progress tasks of the position slots count, newest subject wins, retired teams excluded', () => {
    const teamA = team('t1', [assistant('s-1', '货代', 'leader')]);
    const teamB = team('t2', [assistant('s-9', '货代', 'leader')]);
    const cards = positionCardsOf({
      positions,
      conversations: [conversation],
      generatingIds: new Set(),
      waitingConfirmationIds: new Set(),
      roster: [rosterEntry(teamA, false, Date.now() + DAY), rosterEntry(teamB, true, Date.now() - DAY)],
      tasksByTeam: new Map([
        [
          't1',
          [task('a', 's-1', 'in_progress', 500), task('b', 's-1', 'in_progress', 900), task('c', 's-1', 'done', 950)],
        ],
        ['t2', [task('z', 's-9', 'in_progress', 999)]],
      ]),
      slotWork: new Map(),
    });
    expect(cards[0]).toMatchObject({ inProgressCount: 2, currentTask: '任务-b', lastActiveAt: 950 });
  });
});

describe('teamCardsOf', () => {
  it('member dots follow the slot work: running green, queued amber, unknown idle', () => {
    const teamA = team('t1', [assistant('s-1', '货代', 'leader'), assistant('s-2', '评审')]);
    const wall = teamCardsOf({
      roster: [rosterEntry(teamA, false, Date.now() + DAY)],
      tasksByTeam: new Map(),
      slotWork: new Map([['t1', new Map([['s-2', work('s-2', 'queued')]])]]),
      now: 0,
    });
    expect(wall.active[0].members.map((member) => member.kind)).toEqual(['idle', 'queued']);
    expect(wall.active[0].running).toBe(true);
  });

  it('progress counts map statuses: review and blocked stay with the backlog', () => {
    const teamA = team('t1', [assistant('s-1', '货代', 'leader')]);
    const wall = teamCardsOf({
      roster: [rosterEntry(teamA, false)],
      tasksByTeam: new Map([
        [
          't1',
          [
            task('a', 's-1', 'todo', 1),
            task('b', 's-1', 'review', 2),
            task('c', 's-1', 'in_progress', 3),
            task('d', 's-1', 'done', 4),
          ],
        ],
      ]),
      slotWork: new Map(),
      now: 0,
    });
    expect(wall.active[0].counts).toEqual({ todo: 2, inProgress: 1, done: 1 });
  });

  it('the wall splits retired from active, a running team first', () => {
    const resting = rosterEntry(team('t1', [assistant('s-1', '货代', 'leader')], 10), false, Date.now() + DAY);
    const running = team('t2', [assistant('s-2', '评审', 'leader')], 5);
    const retired = rosterEntry(team('t3', [assistant('s-3', '货代', 'leader')], 99), true, Date.now() - DAY);
    const wall = teamCardsOf({
      roster: [resting, retired, rosterEntry(running, false, Date.now() + DAY)],
      tasksByTeam: new Map(),
      slotWork: new Map([['t2', new Map([['s-2', work('s-2', 'running')]])]]),
      now: 0,
    });
    expect(wall.active.map((card) => card.entry.team.id)).toEqual(['t2', 't1']);
    expect(wall.retired.map((card) => card.entry.team.id)).toEqual(['t3']);
  });

  it('the wall files soft-deleted teams into the restore queue, off every visible wall', () => {
    const live = rosterEntry(team('t1', [assistant('s-1', '货代', 'leader')]), false, Date.now() + DAY);
    const deleted = rosterEntry(
      team('t2', [assistant('s-2', '评审', 'leader')]),
      false,
      Date.now() + DAY,
      7,
      false,
      42
    );
    const wall = teamCardsOf({ roster: [live, deleted], tasksByTeam: new Map(), slotWork: new Map(), now: 0 });
    expect(wall.active.map((card) => card.entry.team.id)).toEqual(['t1']);
    expect(wall.retired).toEqual([]);
    expect(wall.deleted.map((card) => card.entry.team.id)).toEqual(['t2']);
    expect(wall.deleted[0].entry.deletedAt).toBe(42);
  });

  it('carries the lifecycle: a permanent team keeps its card active with its configured ttlDays on the entry', () => {
    const forever = rosterEntry(team('t1', [assistant('s-1', '货代', 'leader')]), false, Date.now() + 3 * DAY, 3, true);
    const wall = teamCardsOf({ roster: [forever], tasksByTeam: new Map(), slotWork: new Map(), now: 0 });
    expect(wall.active[0].permanent).toBe(true);
    expect(wall.active[0].entry.ttlDays).toBe(3);
    expect(wall.active[0].entry.permanent).toBe(true);
  });
});

describe('ttl and time', () => {
  it('ttl days count whole days left, floor at zero, near expiry under two', () => {
    const now = 0;
    expect(ttlDaysOf(now + 7 * DAY, now)).toBe(7);
    expect(ttlDaysOf(now + DAY + 1, now)).toBe(2);
    expect(ttlDaysOf(now + DAY, now)).toBe(1);
    expect(ttlDaysOf(now - DAY, now)).toBe(0);
    expect(ttlDaysOf(undefined, now)).toBeUndefined();
    expect(isNearExpiry(1)).toBe(true);
    expect(isNearExpiry(2)).toBe(false);
  });

  it('relative buckets are coarse: now, minutes, hours, days', () => {
    const now = 10 * 60 * 1000;
    expect(relativeTimeBucket(undefined, now)).toBeUndefined();
    expect(relativeTimeBucket(now - 30_000, now)).toEqual({ kind: 'now' });
    expect(relativeTimeBucket(now - 61_000, now)).toEqual({ kind: 'minutes', n: 1 });
    expect(relativeTimeBucket(now - 2 * 60 * 60 * 1000, now)).toEqual({ kind: 'hours', n: 2 });
    expect(relativeTimeBucket(now - 3 * DAY, now)).toEqual({ kind: 'days', n: 3 });
  });
});

describe('badge and slot naming', () => {
  it('the badge counts working positions plus mid-flight teams', () => {
    const cards = positionCardsOf({
      positions: [position('forwarder', '货代')],
      conversations: [],
      generatingIds: new Set(),
      waitingConfirmationIds: new Set(),
      roster: [],
      tasksByTeam: new Map(),
      slotWork: new Map(),
    });
    const teamA = team('t1', [assistant('s-1', '货代', 'leader')]);
    const wall = teamCardsOf({
      roster: [rosterEntry(teamA, false)],
      tasksByTeam: new Map(),
      slotWork: new Map([['t1', new Map([['s-1', work('s-1', 'running')]])]]),
      now: 0,
    });
    expect(monitorActiveCount(cards, wall.active)).toBe(1);
  });

  it('a slot name matches its position exactly or as a numbered second slot', () => {
    expect(slotMatchesPosition('货代', '货代')).toBe(true);
    expect(slotMatchesPosition('货代 2', '货代')).toBe(true);
    expect(slotMatchesPosition('货代王', '货代')).toBe(false);
    expect(slotMatchesPosition('评审', '货代')).toBe(false);
  });

  it('memberDotOf: queued counts wait even when the state says idle', () => {
    expect(memberDotOf(undefined)).toBe('idle');
    expect(memberDotOf(work('s', 'running'))).toBe('running');
    expect(memberDotOf(work('s', 'starting'))).toBe('running');
    expect(memberDotOf(work('s', 'paused'))).toBe('queued');
    expect(memberDotOf(work('s', 'idle', 2))).toBe('queued');
    expect(memberDotOf(work('s', 'idle'))).toBe('idle');
  });
});
