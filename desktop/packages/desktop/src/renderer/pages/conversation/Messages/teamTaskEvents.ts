/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Team task events and member messages as timeline rows: the group
 * conversation's flow is the ledger, so a task renders where it happened and
 * a member speaks with a name and a face, not as an anonymous assistant
 * bubble. Task cards merge by time (below); member messages come from the
 * team mailbox — the ones the backend already delivered into the flow keep
 * their row and gain the sender's identity, the ones it did not deliver
 * (member-to-member chatter, dispatch notices) join the flow as synthetic
 * text rows the existing teammate rendering draws (avatar + name + bubble).
 * Pure data in, merged timeline out.
 */
import type { IMessageText } from '@/common/chat/chatLib';
import type { ITeamMailboxMessage, ITeamTaskItem, TeamAssistant } from '@/common/types/team/teamTypes';

/** One task's row in the conversation flow; `created_at` is the task's creation time. */
export type TeamTaskRow = { type: 'team_task'; id: string; task: ITeamTaskItem; created_at: number };

/** The DOM id / React key of a task's row (never a message id; ids do not share a space). */
export const teamTaskRowId = (taskId: string): string => `team-task-${taskId}`;

/** The msg_id the backend gives a mailbox message it delivered into a conversation's flow. */
export const teamMailboxMsgId = (teamId: string, mailboxId: string, conversationId: string): string =>
  `team:${teamId}:mailbox:${mailboxId}:conversation:${conversationId}`;

/** Matches the delivered form above (any conversation); captures the mailbox id. */
const DELIVERED_MAILBOX_MSG_ID_RE = /^team:([^:]+):mailbox:([^:]+):conversation:/;

/** The msg ids a conversation's message rows already carry (msg_id and id both), for mailbox dedupe. */
export const deliveredMsgIdsOf = (messages: ReadonlyArray<{ msg_id?: string; id: string }>): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.msg_id) ids.add(message.msg_id);
    ids.add(message.id);
  }
  return ids;
};

/** The sender of a mailbox message as the flow should label them, or undefined when it is not a member. */
const memberSenderOf = (
  message: ITeamMailboxMessage,
  members: readonly TeamAssistant[]
): { senderName: string; senderConversationId: string } | undefined => {
  if (!message.from_agent_id || message.from_agent_id === 'user') return undefined;
  const member = members.find((candidate) => candidate.slot_id === message.from_agent_id);
  if (!member) return undefined;
  return { senderName: member.assistant_name, senderConversationId: member.conversation_id };
};

/**
 * The member messages the backend did NOT deliver into the lead conversation,
 * as left-position text rows the teammate rendering can draw: only real
 * member speech (no idle heartbeats, nothing the user already said as their
 * own right-side row), each with the sender's identity baked in. Messages
 * whose sender cannot be resolved to a member are dropped rather than shown
 * anonymous.
 */
export const memberMessagesFromMailbox = (
  mailbox: readonly ITeamMailboxMessage[],
  context: { teamId: string; conversationId: string; members: readonly TeamAssistant[] },
  deliveredMsgIds: ReadonlySet<string>
): IMessageText[] => {
  const rows: IMessageText[] = [];
  for (const message of mailbox) {
    if (message.msg_type !== 'message') continue;
    const sender = memberSenderOf(message, context.members);
    if (!sender) continue;
    if (deliveredMsgIds.has(teamMailboxMsgId(context.teamId, message.id, context.conversationId))) continue;
    rows.push({
      id: `team-mailbox-${message.id}`,
      msg_id: `team-mailbox-${message.id}`,
      conversation_id: context.conversationId,
      type: 'text',
      position: 'left',
      status: 'finish',
      created_at: message.created_at,
      content: {
        content: message.content,
        teammateMessage: true,
        senderName: sender.senderName,
        senderConversationId: sender.senderConversationId,
      },
    });
  }
  return rows;
};

/**
 * Gives delivered mailbox rows the sender's identity: the backend writes them
 * into the flow as plain text (no `teammate_message` / `sender` fields), so
 * without this they read as the lead's own replies. A row the map cannot
 * resolve keeps its original object.
 */
export const augmentDeliveredTeamMessages = <T extends { type: string; msg_id?: string; content?: unknown }>(
  items: readonly T[],
  mailbox: readonly ITeamMailboxMessage[],
  context: { teamId: string; members: readonly TeamAssistant[] }
): T[] => {
  const senderByMailboxId = new Map<string, { senderName: string; senderConversationId: string }>();
  for (const message of mailbox) {
    if (message.msg_type !== 'message') continue;
    const sender = memberSenderOf(message, context.members);
    if (sender) senderByMailboxId.set(message.id, sender);
  }
  if (senderByMailboxId.size === 0) return [...items];
  return items.map((item) => {
    if (item.type !== 'text' || !item.msg_id) return item;
    const match = DELIVERED_MAILBOX_MSG_ID_RE.exec(item.msg_id);
    if (!match || match[1] !== context.teamId) return item;
    const sender = senderByMailboxId.get(match[2]);
    if (!sender) return item;
    const content = item.content as IMessageText['content'];
    return {
      ...item,
      content: {
        ...content,
        teammateMessage: true,
        senderName: sender.senderName,
        senderConversationId: sender.senderConversationId,
      },
    };
  });
};

/**
 * Merge task rows into the conversation's sorted items by time. Both sides are
 * walked in order; on an exact tie the message wins (a task is usually born
 * after the message that asked for it). Tasks arrive already sorted oldest
 * first from the caller; the merge never re-sorts messages.
 */
export const interleaveTeamTasks = <T>(
  items: readonly T[],
  tasks: readonly ITeamTaskItem[],
  createdAtOf: (item: T) => number
): Array<T | TeamTaskRow> => {
  if (tasks.length === 0) return [...items];
  const sortedTasks = tasks.toSorted((a, b) => a.created_at - b.created_at);
  const merged: Array<T | TeamTaskRow> = [];
  let taskIndex = 0;
  for (const item of items) {
    while (taskIndex < sortedTasks.length && sortedTasks[taskIndex].created_at < createdAtOf(item)) {
      const task = sortedTasks[taskIndex];
      merged.push({ type: 'team_task', id: teamTaskRowId(task.id), task, created_at: task.created_at });
      taskIndex += 1;
    }
    merged.push(item);
  }
  for (; taskIndex < sortedTasks.length; taskIndex += 1) {
    const task = sortedTasks[taskIndex];
    merged.push({ type: 'team_task', id: teamTaskRowId(task.id), task, created_at: task.created_at });
  }
  return merged;
};
