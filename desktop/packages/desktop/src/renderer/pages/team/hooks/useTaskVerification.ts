/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Layout-level wiring of task verification (batch L ②): task-board
 * changes flow in; a task that just turned `done` gets its claimed output
 * checked against the file system — the owner conversation's write/present
 * rows inside the task's window go to one batch fileRefs resolve, and the
 * verdict lands in the badge store. Mounted once, in the Layout, so a
 * completion verifies whether or not the group chat is open. Best-effort
 * throughout, like the receipt and changed-files chains it sits beside: a
 * team that vanished, an owner that is not a slot, or a conversation that
 * will not read simply yields ⚠ pending — never a crash, never a re-queue
 * storm. On mount it also backfills verdicts for tasks that finished before
 * this session (once per session, after a settling delay).
 */
import { useEffect } from 'react';
import { ipcBridge } from '@/common';
import { fileRefBridge } from '@/common/chat/fileRefs/fileRefBridge';
import type { TMessage } from '@/common/chat/chatLib';
import type { ITeamTaskChangedEvent, ITeamTaskItem } from '@/common/types/team/teamTypes';
import { terminalKindOf } from '@renderer/pages/team/core/teamDataCore';
import { loadConversationMessagePage } from '@renderer/utils/chat/messagePagination';
import {
  TASK_WINDOW_SLACK_MS,
  VERIFY_DELAY_MS,
  claimedPathsFrom,
  recordTaskVerification,
  taskVerificationSnapshot,
  verificationStateOf,
  type TaskVerificationState,
} from '@renderer/pages/team/core/notes/taskVerificationNotes';

/** How many pages of one conversation one check reads (newest last). */
const ROW_PAGES = 2;
const ROW_PAGE_LIMIT = 200;
/** The backfill waits this long after mount, out of the startup's way. */
const BACKFILL_DELAY_MS = 4000;

/** The conversation's stored rows, newest last, capped at two pages. */
const loadRows = async (conversationId: string): Promise<readonly TMessage[] | undefined> => {
  try {
    const latest = await loadConversationMessagePage(conversationId, {
      limit: ROW_PAGE_LIMIT,
      contentMode: 'compact',
    });
    if (!latest.has_more_before || !latest.oldest_cursor) return latest.items;
    const older = await loadConversationMessagePage(conversationId, {
      limit: ROW_PAGE_LIMIT,
      before: latest.oldest_cursor,
      contentMode: 'compact',
    });
    return [...older.items, ...latest.items];
  } catch {
    return undefined;
  }
};

/** The check itself: one done task → one verdict entry (or nothing, when the world will not answer). */
const verifyTask = async (task: ITeamTaskItem): Promise<void> => {
  const since = task.created_at - TASK_WINDOW_SLACK_MS;
  const until = task.updated_at + TASK_WINDOW_SLACK_MS;
  let conversationId: string | undefined;
  let workspace: string | undefined;
  try {
    const team = await ipcBridge.team.get.invoke({ id: task.team_id });
    const owner = team?.assistants.find((assistant) => assistant.slot_id === task.owner);
    conversationId = owner?.conversation_id;
    workspace = team?.workspace || undefined;
  } catch {
    // A deleted team cannot be verified: the verdict stays pending below.
  }
  const rows = conversationId ? await loadRows(conversationId) : undefined;
  const paths = rows && conversationId ? claimedPathsFrom(rows, conversationId, since, until) : [];
  let state: TaskVerificationState = 'pending';
  let verifiedCount = 0;
  if (paths.length > 0) {
    try {
      const answer = await fileRefBridge.resolve.invoke({ cwd: workspace, refs: paths });
      if (answer.ok) {
        verifiedCount = answer.data.filter((item) => item.state === 'found').length;
        state = verificationStateOf(answer.data);
      }
    } catch {
      // The resolve refused: pending, like an unreadable window.
    }
  }
  recordTaskVerification({
    taskId: task.id,
    teamId: task.team_id,
    state,
    checkedAt: Date.now(),
    pathCount: paths.length,
    verifiedCount,
  });
};

/** Whether a done task still needs a verdict: never checked, or re-done since the last check. */
const needsVerdict = (task: ITeamTaskItem): boolean => {
  if (terminalKindOf(task) !== 'done') return false;
  const known = taskVerificationSnapshot().get(task.id);
  return known === undefined || known.checkedAt < task.updated_at;
};

/** The one-shot backfill: every team's done tasks without a verdict. */
const backfillVerdicts = async (): Promise<void> => {
  try {
    const user = await ipcBridge.auth.currentUser.invoke().catch((): undefined => undefined);
    const teams = await ipcBridge.team.list.invoke({ user_id: user?.id ?? '' });
    for (const team of teams ?? []) {
      let tasks: ITeamTaskItem[] | undefined;
      try {
        tasks = await ipcBridge.team.listTasks.invoke({ team_id: team.id, limit: 100 });
      } catch {
        continue; // a team whose board will not read simply keeps its old verdicts
      }
      for (const task of tasks ?? []) {
        if (needsVerdict(task)) await verifyTask(task);
      }
    }
  } catch {
    // The list refused: live events still verify whatever comes.
  }
};

export const useTaskVerification = (): void => {
  useEffect(() => {
    let disposed = false;
    const pending = new Map<string, ITeamTaskItem>();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const drain = async (): Promise<void> => {
      if (disposed) return;
      const batch = [...pending.values()];
      pending.clear();
      for (const task of batch) {
        if (needsVerdict(task)) await verifyTask(task);
      }
    };

    const queue = (task: ITeamTaskItem | undefined): void => {
      if (!task || !needsVerdict(task)) return;
      pending.set(task.id, task);
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => void drain(), VERIFY_DELAY_MS);
    };

    const disposeTaskChanged = ipcBridge.team.taskChanged.on((event: ITeamTaskChangedEvent) => {
      if (event.task) queue(event.task);
      // A change event without the full payload (legacy shape) refetches the task.
      else if (event.task_id) {
        ipcBridge.team.listTasks
          .invoke({ team_id: event.team_id, ids: [event.task_id] })
          .then((tasks: ITeamTaskItem[] | undefined) => queue(tasks?.[0]))
          .catch((): undefined => undefined);
      }
    });

    const backfillTimer = setTimeout(() => void backfillVerdicts(), BACKFILL_DELAY_MS);
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      clearTimeout(backfillTimer);
      disposeTaskChanged();
    };
  }, []);
};
