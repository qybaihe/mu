/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The monitor core: how the division-of-labor panel reads the app's own
 * state — every position's 1:1 session plus its slots in the active teams,
 * and every group chat's members, tasks and TTL — as one wall of cards.
 * Pure derivations only; all IO lives in the stores (`slotWorkStore`, the
 * team store, the conversation list sync) that feed these functions.
 */
import type { PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import { findPositionConversationId } from '@/common/chat/team/positions/positionLibraryCore';
import type { ITeamSlotWork, ITeamTaskItem } from '@/common/types/team/teamTypes';
import { boardColumnOf } from '@renderer/pages/workbench/team/teamDataCore';
import { slotMatchesPosition, type TeamRosterEntry } from '@renderer/pages/workbench/team/teamIdentity';

/** The team's slot-work map, as the wire store keeps it per team. */
export type SlotWorkBySlot = ReadonlyMap<string, ITeamSlotWork>;
/** The whole index: one slot-work map per team id. */
export type SlotWorkIndex = ReadonlyMap<string, SlotWorkBySlot>;

/** How long a team stays matchable since its last reuse; the same 7 days as the supervisor's index. */
export const TEAM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// --- position wall ---

export type PositionCardState = 'working' | 'waiting' | 'idle';

export type PositionCard = {
  position: PositionInfo;
  /** The position's 1:1 conversation, when one exists. */
  conversationId: string | undefined;
  state: PositionCardState;
  /** The newest in-progress team task owned by one of the position's slots. */
  currentTask: string | undefined;
  /** In-progress team tasks across the position's slots, right now. */
  inProgressCount: number;
  /** Epoch ms of the latest known activity: the conversation's or its tasks'. */
  lastActiveAt: number | undefined;
};

/** Which position state a slot's work state contributes: running work is
 *  working; queued or parked work is waiting. */
const stateOfSlotWork = (work: ITeamSlotWork): PositionCardState | undefined => {
  if (work.state === 'running' || work.state === 'starting') return 'working';
  if (work.state === 'queued' || work.state === 'paused' || work.state === 'blocked') return 'waiting';
  if (work.queued_foreground_count > 0 || work.queued_background_count > 0) return 'waiting';
  return undefined;
};

/** The best state of the two sources: any working beats any waiting beats idle. */
const mergeStates = (a: PositionCardState | undefined, b: PositionCardState | undefined): PositionCardState => {
  if (a === 'working' || b === 'working') return 'working';
  if (a === 'waiting' || b === 'waiting') return 'waiting';
  return 'idle';
};

export type PositionWallInputs = {
  positions: readonly PositionInfo[];
  /** Every loaded conversation (the position marker lives on `extra.position`). */
  conversations: ReadonlyArray<{ id: string; modified_at?: number; extra?: unknown }>;
  /** Conversations with a live turn, and ones blocked on the user. */
  generatingIds: ReadonlySet<string>;
  waitingConfirmationIds: ReadonlySet<string>;
  /** The backend's teams, with their lifecycle from the shared index. */
  roster: readonly TeamRosterEntry[];
  tasksByTeam: ReadonlyMap<string, readonly ITeamTaskItem[]>;
  slotWork: SlotWorkIndex;
};

/**
 * The position wall, in roster order (the roster is the user's own filing;
 * cards stay put as states move under them). A position's state merges its
 * 1:1 session (generating / waiting on the user) with its slots in every
 * ACTIVE team — a retired team runs nothing, so it contributes no state.
 */
export const positionCardsOf = (inputs: PositionWallInputs): PositionCard[] => {
  const activeTeams = inputs.roster.filter((entry) => !entry.retired);
  return inputs.positions.map((position) => {
    const conversationId = findPositionConversationId(inputs.conversations, position.name);
    const conversation = conversationId
      ? inputs.conversations.find((candidate) => candidate.id === conversationId)
      : undefined;
    const sessionState: PositionCardState | undefined = conversationId
      ? inputs.generatingIds.has(conversationId)
        ? 'working'
        : inputs.waitingConfirmationIds.has(conversationId)
          ? 'waiting'
          : undefined
      : undefined;
    let state: PositionCardState = sessionState ?? 'idle';
    let inProgressCount = 0;
    let newestTask: ITeamTaskItem | undefined;
    let lastTaskActivity: number | undefined;
    for (const entry of activeTeams) {
      for (const assistant of entry.team.assistants) {
        if (!slotMatchesPosition(assistant.assistant_name, position.displayName)) continue;
        const work = inputs.slotWork.get(entry.team.id)?.get(assistant.slot_id);
        if (work) state = mergeStates(state, stateOfSlotWork(work));
        const tasks = inputs.tasksByTeam.get(entry.team.id);
        for (const task of tasks ?? []) {
          if (task.owner !== assistant.slot_id) continue;
          lastTaskActivity = Math.max(lastTaskActivity ?? 0, task.updated_at);
          const column = boardColumnOf(task);
          if (column === 'in_progress') {
            inProgressCount += 1;
            if (!newestTask || task.updated_at > newestTask.updated_at) newestTask = task;
          }
        }
      }
    }
    return {
      position,
      conversationId,
      state,
      currentTask: newestTask?.subject,
      inProgressCount,
      lastActiveAt: Math.max(conversation?.modified_at ?? 0, lastTaskActivity ?? 0) || undefined,
    };
  });
};

// --- team wall ---

export type MemberDotKind = 'running' | 'queued' | 'idle';

export type TeamMemberDot = {
  /** The slot's name — the member's Chinese display name in position-built teams. */
  name: string;
  kind: MemberDotKind;
  isLead: boolean;
};

export type TeamProgressCounts = { todo: number; inProgress: number; done: number };

export type TeamCard = {
  entry: TeamRosterEntry;
  members: TeamMemberDot[];
  /** Any member running or queued: the team is mid-flight. */
  running: boolean;
  counts: TeamProgressCounts;
  /** Whole days left before the shared index retires the team. */
  ttlDays: number | undefined;
};

/** A slot's dot: running work lights green, queued or parked work amber. */
export const memberDotOf = (work: ITeamSlotWork | undefined): MemberDotKind => {
  if (!work) return 'idle';
  if (work.state === 'running' || work.state === 'starting') return 'running';
  if (work.state === 'queued' || work.state === 'paused' || work.state === 'blocked') return 'queued';
  if (work.queued_foreground_count > 0 || work.queued_background_count > 0) return 'queued';
  return 'idle';
};

/** The task columns the progress bar shows: `review` and `blocked` work is
 *  still waiting to move, so it counts with the backlog (`todo`). */
const progressCountsOf = (tasks: readonly ITeamTaskItem[] | undefined): TeamProgressCounts => {
  const counts = { todo: 0, inProgress: 0, done: 0 };
  for (const task of tasks ?? []) {
    const column = boardColumnOf(task);
    if (column === 'in_progress') counts.inProgress += 1;
    else if (column === 'done') counts.done += 1;
    else counts.todo += 1;
  }
  return counts;
};

/** Whole days of TTL left: 0 the day it expires, never negative. */
export const ttlDaysOf = (expiresAt: number | undefined, now: number): number | undefined =>
  expiresAt === undefined ? undefined : Math.max(0, Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000)));

/** The expiry that reads as urgent: less than two days left. */
export const isNearExpiry = (ttlDays: number): boolean => ttlDays < 2;

export type TeamWallInputs = {
  roster: readonly TeamRosterEntry[];
  tasksByTeam: ReadonlyMap<string, readonly ITeamTaskItem[]>;
  slotWork: SlotWorkIndex;
  now: number;
};

export type TeamWall = { active: TeamCard[]; retired: TeamCard[] };

/**
 * The team wall split by lifecycle: active teams first (a running team before
 * a resting one, else by recency), retired teams after — the collapsed tail.
 */
export const teamCardsOf = (inputs: TeamWallInputs): TeamWall => {
  const cards = inputs.roster.map<TeamCard>((entry) => {
    const bySlot = inputs.slotWork.get(entry.team.id);
    const members = entry.team.assistants.map<TeamMemberDot>((assistant) => ({
      name: assistant.assistant_name,
      kind: memberDotOf(bySlot?.get(assistant.slot_id)),
      isLead: assistant.role === 'leader',
    }));
    return {
      entry,
      members,
      running: members.some((member) => member.kind !== 'idle'),
      counts: progressCountsOf(inputs.tasksByTeam.get(entry.team.id)),
      ttlDays: ttlDaysOf(entry.expiresAt, inputs.now),
    };
  });
  const active = cards.filter((card) => !card.entry.retired);
  const retired = cards.filter((card) => card.entry.retired);
  active.sort((a, b) =>
    a.running === b.running ? b.entry.team.updated_at - a.entry.team.updated_at : a.running ? -1 : 1
  );
  return { active, retired };
};

// --- the entry badge ---

/** How many cards are mid-flight right now: positions working plus teams with
 *  any member running or queued — the sidebar entry's live badge. */
export const monitorActiveCount = (positions: readonly PositionCard[], teams: readonly TeamCard[]): number =>
  positions.filter((card) => card.state === 'working').length + teams.filter((card) => card.running).length;

// --- relative time ---

export type RelativeTimeBucket =
  | { kind: 'now' }
  | { kind: 'minutes'; n: number }
  | { kind: 'hours'; n: number }
  | { kind: 'days'; n: number };

/** The coarse age a timestamp reads as: 刚刚 / N 分钟前 / N 小时前 / N 天前. */
export const relativeTimeBucket = (ts: number | undefined, now: number): RelativeTimeBucket | undefined => {
  if (ts === undefined) return undefined;
  const elapsed = Math.max(0, now - ts);
  const minute = 60_000;
  if (elapsed < minute) return { kind: 'now' };
  if (elapsed < 60 * minute) return { kind: 'minutes', n: Math.floor(elapsed / minute) };
  if (elapsed < 24 * 60 * minute) return { kind: 'hours', n: Math.floor(elapsed / (60 * minute)) };
  return { kind: 'days', n: Math.floor(elapsed / (24 * 60 * minute)) };
};
