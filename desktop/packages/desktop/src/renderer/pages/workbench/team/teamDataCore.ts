/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure derivations for the team views rendered inside the group conversation:
 * task status normalized into timeline columns (with the open-dependency
 * override), validated dependency edges, slot-name resolution and team-scoped
 * search over the global message search API.
 *
 * Tasks are read from the backend's own task store and never guessed from the
 * chat — the DS-Bot rule this view ports. Every function here is pure: data
 * in, derived data out, no IO.
 */
import type { ITeamTaskItem, TeamAssistant } from '@/common/types/team/teamTypes';

/** Board column a task's free-string status normalizes into. */
export type TaskBoardColumn = 'todo' | 'in_progress' | 'review' | 'blocked' | 'done';

const COLUMN_OF_STATUS: Record<string, TaskBoardColumn> = {
  // neutral / backlog
  todo: 'todo',
  pending: 'todo',
  open: 'todo',
  new: 'todo',
  backlog: 'todo',
  planned: 'todo',
  not_started: 'todo',
  // moving
  in_progress: 'in_progress',
  active: 'in_progress',
  doing: 'in_progress',
  started: 'in_progress',
  working: 'in_progress',
  // waiting on a person
  review: 'review',
  in_review: 'review',
  reviewing: 'review',
  // waiting on something else
  blocked: 'blocked',
  waiting: 'blocked',
  paused: 'blocked',
  // terminals
  done: 'done',
  completed: 'done',
  complete: 'done',
  cancelled: 'done',
  canceled: 'done',
  failed: 'done',
  closed: 'done',
};

const normalizeStatus = (status: string | undefined): string =>
  typeof status === 'string'
    ? status
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_')
    : '';

/** A task's board column; unknown statuses stay open on `todo` (a made-up status is work not yet done). */
export const boardColumnOf = (task: Pick<ITeamTaskItem, 'status'>): TaskBoardColumn =>
  COLUMN_OF_STATUS[normalizeStatus(task.status)] ?? 'todo';

/** Terminal tasks carry why they ended, for the finished section. */
export const terminalKindOf = (task: Pick<ITeamTaskItem, 'status'>): 'done' | 'cancelled' | 'failed' | undefined => {
  const normalized = normalizeStatus(task.status);
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
  if (normalized === 'failed') return 'failed';
  if (COLUMN_OF_STATUS[normalized] === 'done') return 'done';
  return undefined;
};

/** One dependency edge: `task` cannot move until `blocker` does. */
export type TaskDependencyEdge = { task_id: string; blocker_id: string; cyclic: boolean };

/**
 * Validated `blocked_by` edges of a whole task set, each marked when it sits on
 * a cycle. Edges naming tasks outside the set are dropped: the backend owns
 * the ids, a dangling reference renders nothing rather than a fake card.
 */
export const dependencyEdgesOf = (tasks: readonly ITeamTaskItem[]): TaskDependencyEdge[] => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const edges: TaskDependencyEdge[] = [];
  for (const task of tasks) {
    for (const blockerId of task.blocked_by) {
      if (blockerId === task.id) {
        edges.push({ task_id: task.id, blocker_id: blockerId, cyclic: true });
        continue;
      }
      if (!byId.has(blockerId)) continue;
      edges.push({ task_id: task.id, blocker_id: blockerId, cyclic: false });
    }
  }
  if (edges.length === 0) return edges;
  // Mark edges on a blocked_by cycle: walk each edge's blocker chain; reaching the
  // start again within one walk means every edge walked is on that cycle. A visited
  // set keeps each walk linear — chains fan out and reconnect, and a naive DFS on
  // them explodes (the original walked the same nodes forever).
  const blockedBy = new Map<string, string[]>();
  for (const edge of edges) {
    const list = blockedBy.get(edge.task_id) ?? [];
    if (!list.includes(edge.blocker_id)) list.push(edge.blocker_id);
    blockedBy.set(edge.task_id, list);
  }
  for (const edge of edges) {
    if (edge.cyclic) continue;
    const walked: Array<[string, string]> = [];
    const visited = new Set<string>([edge.task_id]);
    const stack: Array<{ from: string; next: string }> = [{ from: edge.task_id, next: edge.blocker_id }];
    let cyclic = false;
    while (stack.length > 0 && !cyclic) {
      const step = stack.pop();
      if (!step) break;
      walked.push([step.from, step.next]);
      if (step.next === edge.task_id) {
        cyclic = true;
        break;
      }
      if (visited.has(step.next)) continue;
      visited.add(step.next);
      for (const deeper of blockedBy.get(step.next) ?? []) stack.push({ from: step.next, next: deeper });
    }
    if (cyclic) {
      for (const walkedEdge of walked) {
        const found = edges.find(
          (candidate) => candidate.task_id === walkedEdge[0] && candidate.blocker_id === walkedEdge[1]
        );
        if (found) found.cyclic = true;
      }
    }
  }
  return edges;
};

/**
 * The column a task reads as in the team's timeline: its own status, except
 * that a task blocked by a still-open task cannot move, whatever its status
 * string says — the dependency is the stronger signal (the DS-Bot `blocked`
 * rule on mu's richer data). Terminal blockers never block.
 */
export const effectiveTaskColumn = (task: ITeamTaskItem, tasks: readonly ITeamTaskItem[]): TaskBoardColumn => {
  const column = boardColumnOf(task);
  if (column === 'done' || column === 'blocked') return column;
  const blockedByOpen = task.blocked_by.some((blockerId) => {
    const blocker = tasks.find((candidate) => candidate.id === blockerId);
    return blocker !== undefined && terminalKindOf(blocker) === undefined;
  });
  return blockedByOpen ? 'blocked' : column;
};

/** Display name for a slot id ('user' stays 'user'); unknown ids fall back to the id itself. */
export const nameOfSlot = (slotId: string | undefined, members: ReadonlyArray<TeamAssistant>): string => {
  if (!slotId) return '';
  if (slotId === 'user') return 'user';
  return members.find((member) => member.slot_id === slotId)?.assistant_name ?? slotId;
};

/** Collapsed single-line preview of a message body. */
const summaryOf = (content: string, max = 120): string => content.replace(/\s+/g, ' ').trim().slice(0, max);

/** Search result row: a hit that belongs to one team conversation. */
export type TeamSearchRow = {
  message_id: string;
  conversation_id: string;
  conversation_name: string;
  at: number;
  preview: string;
  is_tool_call: boolean;
};

/** Raw shape the search API mapper returns; kept local so the core stays decoupled from the bridge. */
export type SearchHitSource = {
  message_id: string;
  message_type?: string;
  message_created_at?: number;
  preview_text?: string;
  conversation?: { id?: string; name?: string; extra?: Record<string, unknown> | null } | null;
};

const teamIdOfConversation = (conversation: SearchHitSource['conversation']): string | undefined => {
  const extra = conversation?.extra as { teamId?: string; team_id?: string } | undefined;
  return extra?.teamId || extra?.team_id || undefined;
};

export const SEARCH_PAGE_SIZE = 20;
export const SEARCH_TERMS_MAX = 8;
export const SEARCH_QUERY_MAX = 200;

/** Search terms of a raw query: unique, capped, lowercased — the AND the ledger search used. */
export const searchTermsOf = (query: string): string[] =>
  [...new Set(query.toLowerCase().slice(0, SEARCH_QUERY_MAX).split(/\s+/).filter(Boolean))].slice(0, SEARCH_TERMS_MAX);

/**
 * Team-scope a global search page: keep hits whose conversation belongs to the
 * team, require every term in the preview (AND), newest first. `hasMore` stays
 * the caller's (the API page boundary), not ours.
 */
export const filterSearchHitsToTeam = (
  hits: readonly SearchHitSource[],
  teamId: string,
  terms: readonly string[]
): TeamSearchRow[] => {
  if (terms.length === 0) return [];
  const rows: TeamSearchRow[] = [];
  for (const hit of hits) {
    const conversation = hit.conversation;
    if (!conversation?.id || teamIdOfConversation(conversation) !== teamId) continue;
    const preview = typeof hit.preview_text === 'string' ? hit.preview_text : '';
    const haystack = preview.toLowerCase();
    if (!terms.every((term) => haystack.includes(term))) continue;
    rows.push({
      message_id: hit.message_id,
      conversation_id: conversation.id,
      conversation_name: conversation.name?.trim() || conversation.id,
      at: hit.message_created_at ?? 0,
      preview: summaryOf(preview, 160),
      is_tool_call: hit.message_type === 'tool_call',
    });
  }
  return rows.sort((a, b) => b.at - a.at);
};
