/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ITeamMailboxMessage, ITeamTaskItem, TeamAssistant } from '@/common/types/team/teamTypes';
import {
  augmentDeliveredTeamMessages,
  deliveredMsgIdsOf,
  interleaveTeamTasks,
  memberMessagesFromMailbox,
  teamMailboxMsgId,
  teamTaskRowId,
} from '@/renderer/pages/conversation/Messages/teamTaskEvents';

const task = (id: string, createdAt: number): ITeamTaskItem => ({
  id,
  team_id: 'team-1',
  subject: `subject ${id}`,
  status: 'pending',
  owner: 'slot-a',
  blocked_by: [],
  blocks: [],
  created_at: createdAt,
  updated_at: createdAt,
});

type Row = { id: string; created_at: number };
const row = (id: string, createdAt: number): Row => ({ id, created_at: createdAt });
const ids = (merged: Array<Row | { id: string }>): string[] => merged.map((item) => item.id);

describe('interleaveTeamTasks', () => {
  it('places each task between the messages around its creation time', () => {
    const merged = interleaveTeamTasks<Row>(
      [row('m1', 10), row('m2', 20), row('m3', 30)],
      [task('t-a', 15), task('t-b', 12), task('t-c', 99)],
      (item) => item.created_at
    );
    expect(ids(merged)).toEqual(['m1', teamTaskRowId('t-b'), teamTaskRowId('t-a'), 'm2', 'm3', teamTaskRowId('t-c')]);
  });

  it('keeps the message before a task born at the exact same moment', () => {
    const merged = interleaveTeamTasks<Row>([row('m1', 10)], [task('t1', 10)], (item) => item.created_at);
    expect(ids(merged)).toEqual(['m1', teamTaskRowId('t1')]);
  });

  it('carries the task object so a refetch updates the same row in place', () => {
    const t1 = task('t1', 5);
    const first = interleaveTeamTasks<Row>([row('m1', 10)], [t1], (item) => item.created_at);
    const updated = { ...t1, status: 'done' };
    const second = interleaveTeamTasks<Row>([row('m1', 10)], [updated], (item) => item.created_at);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(ids(first)).toEqual(ids(second));
    expect((second[0] as { task: ITeamTaskItem }).task.status).toBe('done');
  });

  it('returns the items untouched with no tasks and never re-sorts messages', () => {
    const items = [row('m2', 20), row('m1', 10)];
    expect(interleaveTeamTasks(items, [], (item) => item.created_at)).toEqual(items);
  });
});

const member = (slotId: string, name: string, conversationId: string): TeamAssistant => ({
  slot_id: slotId,
  conversation_id: conversationId,
  role: slotId === 'lead-slot' ? 'leader' : 'teammate',
  assistant_backend: 'acp',
  assistant_name: name,
  status: 'idle',
});

const mailboxMessage = (
  id: string,
  from: string,
  type: string,
  createdAt: number,
  content = `text-${id}`
): ITeamMailboxMessage => ({
  id,
  team_id: 'team-1',
  from_agent_id: from,
  to_agent_id: 'lead-slot',
  msg_type: type,
  content,
  files: [],
  read: false,
  created_at: createdAt,
});

const MEMBERS = [member('lead-slot', '货代', 'c-lead'), member('mate-slot', '货代 2', 'c-mate')];

describe('memberMessagesFromMailbox', () => {
  it('builds left rows with the sender’s identity for undelivered member speech only', () => {
    const delivered = teamMailboxMsgId('team-1', 'mb-delivered', 'c-lead');
    const rows = memberMessagesFromMailbox(
      [
        mailboxMessage('mb-1', 'mate-slot', 'message', 10),
        mailboxMessage('mb-delivered', 'mate-slot', 'message', 12),
        mailboxMessage('mb-2', 'mate-slot', 'idle_notification', 14),
        mailboxMessage('mb-3', 'user', 'message', 16),
        mailboxMessage('mb-4', 'ghost-slot', 'message', 18),
      ],
      { teamId: 'team-1', conversationId: 'c-lead', members: MEMBERS },
      new Set([delivered])
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'team-mailbox-mb-1',
      position: 'left',
      created_at: 10,
      content: { content: 'text-mb-1', teammateMessage: true, senderName: '货代 2', senderConversationId: 'c-mate' },
    });
  });

  it('labels a lead-authored message with the lead’s identity too', () => {
    const rows = memberMessagesFromMailbox(
      [mailboxMessage('mb-lead', 'lead-slot', 'message', 5, '分派：任务1 给 货代 2')],
      { teamId: 'team-1', conversationId: 'c-lead', members: MEMBERS },
      new Set()
    );
    expect(rows[0]?.content).toMatchObject({ senderName: '货代', senderConversationId: 'c-lead' });
  });
});

describe('augmentDeliveredTeamMessages', () => {
  it('gives a delivered row the sender’s identity, leaves everything else untouched', () => {
    const items = [
      { type: 'text', msg_id: teamMailboxMsgId('team-1', 'mb-9', 'c-lead'), content: { content: '回报完成' } },
      { type: 'text', msg_id: 'ordinary', content: { content: 'lead 自己的话' } },
      { type: 'tool_summary', id: 'ts-1' },
    ];
    const augmented = augmentDeliveredTeamMessages(items, [mailboxMessage('mb-9', 'mate-slot', 'message', 1)], {
      teamId: 'team-1',
      members: MEMBERS,
    });
    expect(augmented[0]?.content).toMatchObject({
      teammateMessage: true,
      senderName: '货代 2',
      senderConversationId: 'c-mate',
    });
    expect(augmented[1]).toBe(items[1]);
    expect(augmented[2]).toBe(items[2]);
  });

  it('leaves a delivered row alone when the sender cannot be resolved', () => {
    const items = [{ type: 'text', msg_id: teamMailboxMsgId('team-1', 'mb-x', 'c-lead'), content: { content: '?' } }];
    const augmented = augmentDeliveredTeamMessages(items, [mailboxMessage('mb-x', 'ghost-slot', 'message', 1)], {
      teamId: 'team-1',
      members: MEMBERS,
    });
    expect(augmented[0]).toBe(items[0]);
  });
});

describe('deliveredMsgIdsOf', () => {
  it('collects both msg_id and id of every row', () => {
    expect(deliveredMsgIdsOf([{ id: 'a', msg_id: 'x' }, { id: 'b' }])).toEqual(new Set(['a', 'x', 'b']));
  });
});
