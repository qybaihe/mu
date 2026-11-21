/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One task's inline card in the group conversation's flow — the Rakazo
 * delegation-card form: a compact single line (assignee avatar, subject,
 * status pill) that opens to the task's details. The card always shows the
 * task's latest state, so a status change updates this same card where it
 * sits instead of adding a new row. A finished task stays a single quiet
 * line; only the reader opening it says more.
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@arco-design/web-react';
import { Link, Right } from '@icon-park/react';
import ThemedLogo from '@/renderer/components/agent/ThemedLogo';
import type { ITeamTaskItem, TeamAssistant } from '@/common/types/team/teamTypes';
import {
  effectiveTaskColumn,
  isClaimableTask,
  nameOfSlot,
  terminalKindOf,
  type TaskBoardColumn,
} from '@renderer/pages/team/core/teamDataCore';
import styles from './TeamTaskCard.module.css';

/** Tasks the reader opened, by task id — an update re-renders the card, not the reader's choice. */
const openTaskIds = new Set<string>();

const PILL_CLASS: Record<TaskBoardColumn, string> = {
  todo: styles.pillTodo,
  in_progress: styles.pillProgress,
  review: styles.pillReview,
  blocked: styles.pillBlocked,
  done: styles.pillDone,
};

const pillLabelKey = (
  column: TaskBoardColumn,
  terminal: 'done' | 'cancelled' | 'failed' | undefined,
  claimable: boolean
): string => {
  if (terminal === 'cancelled') return 'team.taskCard.cancelled';
  if (terminal === 'failed') return 'team.taskCard.failed';
  if (column === 'todo') return claimable ? 'team.taskCard.status.claimable' : 'team.taskCard.status.todo';
  if (column === 'in_progress') return 'team.taskCard.status.inProgress';
  if (column === 'review') return 'team.taskCard.status.review';
  if (column === 'blocked') return 'team.taskCard.status.blocked';
  return 'team.taskCard.status.done';
};

const timeLabel = (at: number, language: string): string => {
  try {
    return new Intl.DateTimeFormat(language, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(at));
  } catch {
    return '';
  }
};

const OwnerAvatar: React.FC<{ member: TeamAssistant | undefined; ownerName: string }> = ({ member, ownerName }) => {
  if (member?.icon) {
    return <ThemedLogo src={member.icon} alt={ownerName} className={styles.avatar} />;
  }
  return <span className={styles.avatarFallback}>{ownerName.slice(0, 1).toUpperCase()}</span>;
};

const TeamTaskCard: React.FC<{
  task: ITeamTaskItem;
  /** The team's whole task list — dependency subjects resolve against it. */
  tasks: readonly ITeamTaskItem[];
  members: readonly TeamAssistant[];
  /** Blocker ids that sit on a dependency cycle (from `dependencyEdgesOf`). */
  cyclicBlockerIds: ReadonlySet<string>;
}> = ({ task, tasks, members, cyclicBlockerIds }) => {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(() => openTaskIds.has(task.id));
  const column = effectiveTaskColumn(task, tasks);
  const terminal = terminalKindOf(task);
  const claimable = isClaimableTask(task, tasks);
  const claimBlocked = !task.owner && column === 'blocked';
  const ownerName = task.owner ? nameOfSlot(task.owner, members) || task.owner : undefined;
  const member = task.owner ? members.find((candidate) => candidate.slot_id === task.owner) : undefined;
  const language = i18n?.language ?? 'en';
  const blockers = useMemo(
    () =>
      task.blocked_by.map((blockerId) => ({
        id: blockerId,
        subject: tasks.find((candidate) => candidate.id === blockerId)?.subject ?? blockerId,
        cyclic: cyclicBlockerIds.has(blockerId),
      })),
    [task.blocked_by, tasks, cyclicBlockerIds]
  );
  const hasDetails = Boolean(task.description) || Boolean(ownerName) || blockers.length > 0;
  const toggle = () => {
    setOpen((value) => {
      const next = !value;
      if (next) openTaskIds.add(task.id);
      else openTaskIds.delete(task.id);
      return next;
    });
  };

  return (
    <div
      className={`${styles.card} ${claimBlocked ? styles.cardClaimBlocked : ''}`}
      data-testid='team-task-card'
      data-task-status={terminal ?? column}
      data-claimable={claimable ? 'true' : undefined}
      data-task-id={task.id}
    >
      <Button
        type='text'
        size='mini'
        aria-expanded={open}
        data-testid='team-task-card-header'
        className={styles.header}
        onClick={toggle}
      >
        <OwnerAvatar member={member} ownerName={ownerName ?? '?'} />
        <span className={styles.subject} dir='auto'>
          {task.subject}
        </span>
        <span
          className={`${styles.pill} ${claimable ? styles.pillClaimable : PILL_CLASS[column]} ${
            column === 'in_progress' ? styles.pillLive : ''
          }`}
        >
          {t(pillLabelKey(column, terminal, claimable))}
        </span>
        {hasDetails ? (
          <Right theme='outline' size='12' className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`} />
        ) : null}
      </Button>
      {open ? (
        <div className={styles.body} data-testid='team-task-card-body'>
          {task.description ? (
            <p className={styles.description} dir='auto'>
              {task.description}
            </p>
          ) : null}
          <div className={styles.meta}>
            {ownerName ? (
              <span className={styles.metaRow}>
                {t('team.taskCard.owner')}: {ownerName}
              </span>
            ) : claimBlocked ? (
              <span className={styles.metaRow} data-testid='task-claim-blocked'>
                {t('team.taskCard.unassigned')} · {t('team.taskCard.blockedClaim')}
              </span>
            ) : (
              <span className={styles.metaRow}>{t('team.taskCard.unassigned')}</span>
            )}
            <span className={styles.metaRow}>
              {t('team.taskCard.createdAt')}: {timeLabel(task.created_at, language)}
            </span>
            {task.updated_at !== task.created_at ? (
              <span className={styles.metaRow}>
                {t('team.taskCard.updatedAt')}: {timeLabel(task.updated_at, language)}
              </span>
            ) : null}
          </div>
          {blockers.length > 0 ? (
            <div className={styles.blockers}>
              <Link theme='outline' size='12' className={styles.blockersIcon} />
              {blockers.map((blocker) => (
                <span
                  key={blocker.id}
                  data-testid='team-task-blocker'
                  className={`${styles.depChip} ${blocker.cyclic ? styles.depChipCyclic : ''}`}
                >
                  {blocker.subject}
                  {blocker.cyclic ? ` · ${t('team.taskCard.cyclic')}` : ''}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export default React.memo(TeamTaskCard);
