/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ITeamTaskItem, TeamAssistant } from '@/common/types/team/teamTypes';
import {
  boardColumnOf,
  dependencyEdgesOf,
  effectiveTaskColumn,
  filterSearchHitsToTeam,
  nameOfSlot,
  searchTermsOf,
  terminalKindOf,
  type SearchHitSource,
} from '@/renderer/pages/team/core/teamDataCore';

const member = (slotId: string, name: string, role: 'leader' | 'teammate' = 'teammate') => ({
  slot_id: slotId,
  conversation_id: `conv-${slotId}`,
  role,
  assistant_backend: 'claude',
  assistant_name: name,
  status: 'idle' as const,
  context_reset: { supported: true, availability: 'ready' as const },
});

const members: TeamAssistant[] = [member('slot-a', 'Captain', 'leader'), member('slot-b', 'Scout')];

const task = (overrides: Partial<ITeamTaskItem> = {}): ITeamTaskItem => ({
  id: `t-${Math.random().toString(36).slice(2, 8)}`,
  team_id: 'team-1',
  subject: 'probe task',
  status: 'pending',
  owner: 'slot-a',
  blocked_by: [],
  blocks: [],
  created_at: 1,
  updated_at: 2,
  ...overrides,
});

describe('boardColumnOf / terminalKindOf', () => {
  it('normalizes known statuses into the four open columns and done', () => {
    expect(boardColumnOf(task({ status: 'pending' }))).toBe('todo');
    expect(boardColumnOf(task({ status: 'todo' }))).toBe('todo');
    expect(boardColumnOf(task({ status: 'Active' }))).toBe('in_progress');
    expect(boardColumnOf(task({ status: 'in progress' }))).toBe('in_progress');
    expect(boardColumnOf(task({ status: 'in_review' }))).toBe('review');
    expect(boardColumnOf(task({ status: 'BLOCKED' }))).toBe('blocked');
    expect(boardColumnOf(task({ status: 'done' }))).toBe('done');
    expect(boardColumnOf(task({ status: 'completed' }))).toBe('done');
  });

  it('keeps unknown statuses open on todo, never silently done', () => {
    expect(boardColumnOf(task({ status: 'wip' }))).toBe('todo');
    expect(boardColumnOf(task({ status: '' }))).toBe('todo');
    expect(boardColumnOf(task({ status: undefined as unknown as string }))).toBe('todo');
    expect(terminalKindOf(task({ status: 'wip' }))).toBeUndefined();
  });

  it('separates why a task ended', () => {
    expect(terminalKindOf(task({ status: 'cancelled' }))).toBe('cancelled');
    expect(terminalKindOf(task({ status: 'failed' }))).toBe('failed');
    expect(terminalKindOf(task({ status: 'done' }))).toBe('done');
  });
});

describe('dependencyEdgesOf', () => {
  it('drops dangling blocked_by ids and keeps valid edges', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b', blocked_by: ['a', 'ghost'] });
    const edges = dependencyEdgesOf([a, b]);
    expect(edges).toEqual([{ task_id: 'b', blocker_id: 'a', cyclic: false }]);
  });

  it('marks every edge on a cycle and leaves side branches alone', () => {
    const a = task({ id: 'a', blocked_by: ['c'] });
    const b = task({ id: 'b', blocked_by: ['a'] });
    const c = task({ id: 'c', blocked_by: ['b'] });
    const side = task({ id: 's', blocked_by: ['a'] });
    const edges = dependencyEdgesOf([a, b, c, side]);
    const cyclic = new Set(edges.filter((edge) => edge.cyclic).map((edge) => `${edge.task_id}>${edge.blocker_id}`));
    expect(cyclic).toEqual(new Set(['a>c', 'b>a', 'c>b']));
    expect(cyclic.has('s>a')).toBe(false);
  });

  it('terminates on long reconnecting chains without revisiting nodes', () => {
    // 50-node ring: n0 blocked by n49, every ni blocked by ni-1 — the naive walk
    // revisits nodes forever; the visited set keeps each walk linear.
    const tasks: ITeamTaskItem[] = [];
    for (let index = 0; index < 50; index += 1) {
      tasks.push(task({ id: `n${index}`, blocked_by: index === 0 ? ['n49'] : [`n${index - 1}`] }));
    }
    const edges = dependencyEdgesOf(tasks);
    expect(edges.length).toBe(50);
    expect(edges.every((edge) => edge.cyclic)).toBe(true);
  });

  it('marks a self-block as cyclic', () => {
    const self = task({ id: 'self', blocked_by: ['self'] });
    expect(dependencyEdgesOf([self])).toEqual([{ task_id: 'self', blocker_id: 'self', cyclic: true }]);
  });
});

describe('effectiveTaskColumn', () => {
  it('moves a task with an open blocker into blocked regardless of its own status', () => {
    const review = task({ id: 'r', status: 'pending' });
    const release = task({ id: 'p', status: 'pending', blocked_by: ['r'] });
    expect(effectiveTaskColumn(release, [review, release])).toBe('blocked');
    expect(effectiveTaskColumn(review, [review, release])).toBe('todo');
  });

  it('keeps a task whose blockers all finished in its own column', () => {
    const done = task({ id: 'd', status: 'done' });
    const release = task({ id: 'p', status: 'in_progress', blocked_by: ['d'] });
    expect(effectiveTaskColumn(release, [done, release])).toBe('in_progress');
  });

  it('never overrides an already-blocked or terminal task', () => {
    const blocked = task({ id: 'b', status: 'blocked' });
    const finished = task({ id: 'f', status: 'done', blocked_by: ['b'] });
    expect(effectiveTaskColumn(blocked, [blocked])).toBe('blocked');
    expect(effectiveTaskColumn(finished, [blocked, finished])).toBe('done');
  });

  it('ignores blocked_by ids naming tasks outside the set', () => {
    const lonely = task({ id: 'l', status: 'in_progress', blocked_by: ['not-there'] });
    expect(effectiveTaskColumn(lonely, [lonely])).toBe('in_progress');
  });
});

describe('nameOfSlot', () => {
  it('answers empty for no owner, user for the user, names for members, ids for unknowns', () => {
    expect(nameOfSlot(undefined, members)).toBe('');
    expect(nameOfSlot('user', members)).toBe('user');
    expect(nameOfSlot('slot-b', members)).toBe('Scout');
    expect(nameOfSlot('ghost-slot', members)).toBe('ghost-slot');
  });
});

describe('searchTermsOf / filterSearchHitsToTeam', () => {
  const hit = (overrides: Partial<SearchHitSource> = {}): SearchHitSource => ({
    message_id: `h-${Math.random().toString(36).slice(2, 8)}`,
    message_type: 'text',
    message_created_at: 10,
    preview_text: 'pricing research done',
    conversation: { id: 'c1', name: 'Scout', extra: { teamId: 'team-1' } },
    ...overrides,
  });

  it('dedupes and caps terms at eight', () => {
    const terms = searchTermsOf('a b a c d e f g h i');
    expect(terms).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    expect(searchTermsOf('   ')).toEqual([]);
  });

  it('keeps only this team conversations and requires every term (AND)', () => {
    const rows = filterSearchHitsToTeam(
      [
        hit(),
        hit({ preview_text: 'pricing only' }),
        hit({ conversation: { id: 'c2', name: 'other', extra: { teamId: 'team-2' } } }),
        hit({ conversation: { id: 'c3', name: 'no-team', extra: {} } }),
      ],
      'team-1',
      ['pricing', 'research']
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ conversation_id: 'c1', preview: 'pricing research done', is_tool_call: false });
  });

  it('returns nothing without terms and tags tool-call rows', () => {
    expect(filterSearchHitsToTeam([hit()], 'team-1', [])).toEqual([]);
    const rows = filterSearchHitsToTeam(
      [hit({ message_type: 'tool_call', preview_text: 'team_task_update x' })],
      'team-1',
      ['team_task_update']
    );
    expect(rows[0]?.is_tool_call).toBe(true);
  });

  it('sorts newest first', () => {
    const rows = filterSearchHitsToTeam(
      [hit({ message_created_at: 1 }), hit({ message_created_at: 30 }), hit({ message_created_at: 10 })],
      'team-1',
      ['pricing']
    );
    expect(rows.map((row) => row.at)).toEqual([30, 10, 1]);
  });
});
