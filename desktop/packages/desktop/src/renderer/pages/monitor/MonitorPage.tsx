/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The division-of-labor monitor: one page, two walls. The position wall —
 * every position of the roster as a card: is it working, waiting or idle,
 * what it is on (its newest in-progress team task), when it last moved.
 * The team wall — every group chat as a card: its members with live dots,
 * its task progress, its remaining TTL. Every number on this page is the
 * app's own live state (WS-pushed, updated in place); nothing here runs a
 * poll of its own. Clicking a card is the way back to the work: the
 * position's session, the group chat itself.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button, Message, Popconfirm, Popover } from '@arco-design/web-react';
import { Delete, Plus } from '@icon-park/react';
import classNames from 'classnames';
import { positionBridge } from '@/common/chat/team/positions/positionBridge';
import type { PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import { positionIdentityColor } from '@/common/chat/team/positions/positionIdentityColor';
import type { TrashedPosition } from '@/common/chat/team/positions/positionTrashCore';
import { trashDaysLeftOf } from '@/common/chat/team/positions/positionTrashCore';
import { supervisorBridge } from '@/common/chat/team/supervisor/supervisorBridge';
import { deletedDaysLeftOf } from '@/common/chat/team/supervisor/supervisorCore';
import { useConversationHistoryContext } from '@renderer/hooks/context/ConversationHistoryContext';
import { useAssistantList } from '@renderer/hooks/assistant/useAssistantList';
import { selectableAssistants } from '@renderer/utils/model/assistantSelection';
import { useOpenPosition } from '@renderer/pages/positions/openPosition';
import { useOpenSupervisor } from '@renderer/pages/positions/openSupervisor';
import { refreshPositions } from '@renderer/pages/positions/usePositionRoster';
import PositionCreationModal from '@renderer/pages/positions/PositionCreationModal';
import { refreshTeamsList } from '@renderer/pages/team/core/teamStore';
import { rowButtonProps } from '@renderer/utils/ui/rowButton';
import TeamLifecycleEditor from './TeamLifecycleEditor';
import { isNearExpiry, relativeTimeBucket, type PositionCard, type TeamCard, type MemberDotKind } from './monitorCore';
import { useMonitorOverview } from './useMonitorOverview';
import styles from './MonitorPage.module.css';

const DOT_CLASS_OF: Record<MemberDotKind, string> = {
  running: 'bg-[rgb(var(--success-6))]',
  queued: 'bg-[rgb(var(--warning-6))]',
  idle: 'bg-fill-3',
};

const stateChipClass = (state: PositionCard['state']): string =>
  state === 'working'
    ? 'bg-[rgba(var(--success-6),0.10)] text-[rgb(var(--success-6))]'
    : state === 'waiting'
      ? 'bg-[rgba(var(--warning-6),0.10)] text-[rgb(var(--warning-6))]'
      : 'bg-fill-2 text-t-tertiary';

const stateDotClass = (state: PositionCard['state']): string =>
  state === 'working' ? DOT_CLASS_OF.running : state === 'waiting' ? DOT_CLASS_OF.queued : DOT_CLASS_OF.idle;

/** The card-surface skin mirroring the state (undefined = idle, plain card). */
const stateSkinClass = (state: PositionCard['state']): string | undefined =>
  state === 'working' ? styles.cardWorking : state === 'waiting' ? styles.cardWaiting : undefined;

/** Keeps an interactive card child (the TTL chip, the hover icons) from
 *  pressing the card itself: clicks and Enter/Space stop before the row
 *  button's handlers. */
const stopBubble = {
  onClick: (event: React.MouseEvent) => event.stopPropagation(),
  onKeyDown: (event: React.KeyboardEvent) => event.stopPropagation(),
};

/** The hover-revealed delete affordance both card kinds share. Spreads the
 *  rest of its props onto the span: Arco's Popconfirm clones its child and
 *  attaches the trigger handlers there, so they must reach the DOM. */
const CardDeleteIcon: React.FC<
  { testId: string; a11y: string; className?: string } & React.HTMLAttributes<HTMLSpanElement>
> = ({ testId, a11y, className, ...rest }) => (
  <span
    data-testid={testId}
    aria-label={a11y}
    className={classNames(
      'inline-flex items-center justify-center size-20px rd-6px text-t-quaternary hover:text-[rgb(var(--danger-6))] hover:bg-fill-3 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity shrink-0',
      className
    )}
    {...rest}
  >
    <Delete theme='outline' size='12' fill='currentColor' className='block' style={{ lineHeight: 0 }} />
  </span>
);

const RelativeTime: React.FC<{ ts: number | undefined; now: number }> = ({ ts, now }) => {
  const { t } = useTranslation();
  const bucket = relativeTimeBucket(ts, now);
  if (!bucket) return null;
  const text =
    bucket.kind === 'now'
      ? t('monitor.relative.now')
      : bucket.kind === 'minutes'
        ? t('monitor.relative.minutes', { count: bucket.n })
        : bucket.kind === 'hours'
          ? t('monitor.relative.hours', { count: bucket.n })
          : t('monitor.relative.days', { count: bucket.n });
  return <span className='text-12px text-t-quaternary shrink-0'>{text}</span>;
};

const stateLabelKey = (
  state: PositionCard['state']
): 'monitor.positions.state.working' | 'monitor.positions.state.waiting' | 'monitor.positions.state.idle' =>
  state === 'working'
    ? 'monitor.positions.state.working'
    : state === 'waiting'
      ? 'monitor.positions.state.waiting'
      : 'monitor.positions.state.idle';

/** One row of a restore queue: what the deleted (soft-deleted) things render
 *  as — their name, the grace days they have left, and the one button that
 *  brings them back. Never a card: a deleted thing is a row to restore, not
 *  a wall entry to click into. */
const RestoreRow: React.FC<{ testId: string; name: string; daysLeft: number; onRestore: () => void }> = ({
  testId,
  name,
  daysLeft,
  onRestore,
}) => {
  const { t } = useTranslation();
  return (
    <div data-testid={testId} className='flex items-center gap-10px min-w-0 px-2px'>
      <span className='text-13px text-t-secondary truncate'>{name}</span>
      <span className='text-12px text-t-quaternary shrink-0'>{t('monitor.daysLeft', { count: daysLeft })}</span>
      <Button type='text' size='mini' onClick={onRestore}>
        {t('monitor.restore')}
      </Button>
    </div>
  );
};

/** The fold header both restore queues share: the count, the soonest expiry. */
const RestoreFoldHeader: React.FC<{
  testId: string;
  open: boolean;
  onToggle: () => void;
  label: string;
}> = ({ testId, open, onToggle, label }) => (
  <span
    data-testid={testId}
    role='button'
    tabIndex={0}
    aria-expanded={open}
    className='text-12px text-t-quaternary cursor-pointer hover:text-t-secondary'
    onClick={onToggle}
    onKeyDown={(event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onToggle();
    }}
  >
    {label}
  </span>
);

const PositionWallCard: React.FC<{
  card: PositionCard;
  now: number;
  onOpen: (position: PositionInfo) => void;
  onDelete: (position: PositionInfo) => void;
}> = ({ card, now, onOpen, onDelete }) => {
  const { t } = useTranslation();
  const { position, state } = card;
  const doing = card.currentTask
    ? card.currentTask
    : state === 'working'
      ? t('monitor.positions.workingSession')
      : state === 'waiting'
        ? t('monitor.positions.awaitingYou')
        : card.conversationId
          ? ''
          : t('monitor.positions.noSession');
  return (
    <div
      data-testid={`monitor-position-${position.name}`}
      aria-label={t('monitor.positions.openA11y', { name: position.displayName })}
      className={classNames('group flex flex-col gap-8px p-16px cursor-pointer', styles.card, stateSkinClass(state))}
      {...rowButtonProps(() => onOpen(position))}
    >
      <div className='flex items-center gap-8px min-w-0'>
        {/* The position's identity dot: its stable derived hue — identity only, the state chip and its colours below stay untouched. */}
        <span
          data-testid={`monitor-position-${position.name}-identity`}
          className='size-8px rd-full shrink-0'
          style={{ background: positionIdentityColor(position.name).background }}
        />
        <span className='text-16px font-600 tracking-[-0.015em] leading-[1.15] text-t-primary truncate'>
          {position.displayName}
        </span>
        <span className='text-12px leading-[1.45] text-t-quaternary truncate'>{position.name}</span>
        <span className='flex-1' />
        {/* Delete, the quarantine semantics: the file moves to the library's
         * .trash, the roster and walls drop it at once, 7 days to restore. */}
        <span {...stopBubble}>
          <Popconfirm
            title={t('monitor.positions.deleteTitle', { name: position.displayName })}
            content={t('monitor.positions.deleteDesc')}
            okText={t('common.delete')}
            cancelText={t('common.cancel')}
            onOk={() => onDelete(position)}
          >
            <CardDeleteIcon
              testId={`monitor-position-${position.name}-delete`}
              a11y={t('monitor.positions.deleteA11y', { name: position.displayName })}
            />
          </Popconfirm>
        </span>
      </div>
      <div
        data-testid={`monitor-position-${position.name}-state`}
        className={classNames(
          'inline-flex items-center gap-6px self-start px-8px py-1px rd-10px text-12px',
          stateChipClass(state)
        )}
      >
        <span className={classNames('size-6px rd-full', stateDotClass(state))} />
        {t(stateLabelKey(state))}
      </div>
      <div className='text-13px text-t-secondary truncate h-20px leading-[1.45]'>{doing}</div>
      {position.thinkingLevel ? (
        /* The declared default level, as the roster shows it: an at-a-glance hint of what this position's sessions start on. */
        <div
          data-testid={`monitor-position-${position.name}-thinking`}
          className='text-12px text-t-quaternary leading-[1.45]'
        >
          {t('positions.wizard.thinkingBadge', {
            level: t(`positions.wizard.thinking.${position.thinkingLevel}`),
          })}
        </div>
      ) : null}
      <div className='flex items-center gap-8px min-w-0'>
        <RelativeTime ts={card.lastActiveAt} now={now} />
        <span className='flex-1' />
        {card.inProgressCount > 0 ? (
          <span data-testid={`monitor-position-${position.name}-tasks`} className='text-12px text-t-tertiary shrink-0'>
            {t('monitor.positions.inProgress', { count: card.inProgressCount })}
          </span>
        ) : null}
      </div>
    </div>
  );
};

const TeamWallCard: React.FC<{
  card: TeamCard;
  now: number;
  onOpen: (card: TeamCard) => void;
  onSetLifecycle: (card: TeamCard, ttlDays: number, permanent: boolean) => Promise<void>;
  onDelete: (card: TeamCard) => Promise<void>;
}> = ({ card, now, onOpen, onSetLifecycle, onDelete }) => {
  const { t } = useTranslation();
  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  const { entry } = card;
  const total = card.counts.todo + card.counts.inProgress + card.counts.done;
  // Near-expiry only reads on a team that can expire: a permanent team never
  // turns amber for its lifecycle.
  const ttlNear = !card.permanent && card.ttlDays !== undefined && !entry.retired && isNearExpiry(card.ttlDays);
  // The surface mirrors the wall's most urgent signal: any member running
  // tints the whole card green; with no one running, a near-TTL team shows the
  // yellow skin (the TTL chip keeps its own badge); running wins if both.
  const skin = card.members.some((member) => member.kind === 'running')
    ? styles.cardWorking
    : ttlNear
      ? styles.cardWaiting
      : undefined;
  return (
    <div
      data-testid={`monitor-team-${entry.team.id}`}
      aria-label={t('monitor.teams.openA11y', { name: entry.team.name })}
      className={classNames('group flex flex-col gap-12px p-16px cursor-pointer', styles.card, skin)}
      {...rowButtonProps(() => onOpen(card))}
    >
      <div className='flex items-center gap-8px min-w-0'>
        <span className='text-15px font-600 tracking-[-0.015em] leading-[1.15] text-t-primary truncate'>
          {entry.team.name}
        </span>
        <span className='flex-1' />
        {entry.retired ? (
          <span className='text-12px text-t-quaternary shrink-0'>{t('team.sider.retired')}</span>
        ) : card.ttlDays !== undefined ? (
          // The TTL area is also its editor: the chip opens the lifecycle
          // popover (days 1-365, or permanent — either can become the other).
          // Stopped, so pressing the chip never opens the group chat underneath.
          <span {...stopBubble}>
            <Popover
              trigger='click'
              position='top'
              popupVisible={lifecycleOpen}
              onVisibleChange={(visible) => setLifecycleOpen(visible)}
              content={
                <TeamLifecycleEditor
                  ttlDays={entry.ttlDays ?? 7}
                  permanent={card.permanent}
                  onApply={async (ttlDays, permanent) => {
                    await onSetLifecycle(card, ttlDays, permanent);
                    setLifecycleOpen(false);
                  }}
                  onCancel={() => setLifecycleOpen(false)}
                />
              }
            >
              <span
                data-testid={`monitor-team-${entry.team.id}-ttl`}
                aria-label={t('monitor.teams.lifecycle.label')}
                className={classNames(
                  'text-12px px-6px py-1px rd-10px shrink-0 cursor-pointer',
                  ttlNear
                    ? 'bg-[rgba(var(--warning-6),0.12)] text-[rgb(var(--warning-6))]'
                    : 'bg-fill-2 text-t-tertiary'
                )}
              >
                {card.permanent ? t('monitor.teams.ttlPermanent') : t('monitor.teams.ttl', { days: card.ttlDays })}
              </span>
            </Popover>
          </span>
        ) : null}
        {/* Delete the group chat, the soft-delete semantics: the team and its
         * conversations leave every surface now, the backend keeps them for
         * the 7-day restore grace, then the reconcile deletes them for real. */}
        <span {...stopBubble}>
          <Popconfirm
            title={t('monitor.teams.deleteTitle', { name: entry.team.name })}
            content={t('monitor.teams.deleteDesc')}
            okText={t('common.delete')}
            cancelText={t('common.cancel')}
            onOk={() => onDelete(card)}
          >
            <CardDeleteIcon
              testId={`monitor-team-${entry.team.id}-delete`}
              a11y={t('monitor.teams.deleteA11y', { name: entry.team.name })}
            />
          </Popconfirm>
        </span>
      </div>
      <div className='flex flex-wrap gap-8px'>
        {card.members.map((member, index) => (
          <span
            key={`${member.name}-${index}`}
            data-testid={`monitor-team-${entry.team.id}-member-${index}`}
            className={classNames(
              'inline-flex items-center gap-5px px-7px py-2px rd-10px text-12px',
              member.isLead ? 'bg-[rgba(var(--primary-6),0.10)] text-primary' : 'bg-fill-2 text-t-secondary'
            )}
          >
            <span className={classNames('size-6px rd-full shrink-0', DOT_CLASS_OF[member.kind])} />
            {member.name}
          </span>
        ))}
      </div>
      <div className='flex flex-col gap-4px'>
        <div data-testid={`monitor-team-${entry.team.id}-bar`} className='h-6px rd-full overflow-hidden flex bg-fill-2'>
          {card.counts.done > 0 && total > 0 ? (
            <span className='bg-[rgb(var(--success-6))]' style={{ width: `${(card.counts.done / total) * 100}%` }} />
          ) : null}
          {card.counts.inProgress > 0 && total > 0 ? (
            <span className='bg-primary' style={{ width: `${(card.counts.inProgress / total) * 100}%` }} />
          ) : null}
        </div>
        <div className='flex items-center gap-8px text-12px text-t-tertiary'>
          <span>{t('monitor.teams.todo', { count: card.counts.todo })}</span>
          {card.counts.unclaimed > 0 ? (
            <span className='text-primary' data-testid={`monitor-team-${entry.team.id}-unclaimed`}>
              {t('monitor.teams.unclaimed', { count: card.counts.unclaimed })}
            </span>
          ) : null}
          <span>{t('monitor.teams.inProgress', { count: card.counts.inProgress })}</span>
          <span>{t('monitor.teams.done', { count: card.counts.done })}</span>
          <span className='flex-1' />
          <RelativeTime ts={entry.team.updated_at} now={now} />
        </div>
      </div>
    </div>
  );
};

/** The monitor page: the two walls and their way back to the work. */
const MonitorPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const overview = useMonitorOverview(true);
  const { conversations } = useConversationHistoryContext();
  const { assistants, assistantOrder } = useAssistantList();
  const primaryAssistantId = selectableAssistants(assistants, assistantOrder)[0]?.id ?? null;
  const openPosition = useOpenPosition(conversations, primaryAssistantId);
  const openSupervisor = useOpenSupervisor(conversations, primaryAssistantId);
  const [retiredOpen, setRetiredOpen] = useState(false);
  const [deletedTeamsOpen, setDeletedTeamsOpen] = useState(false);
  const [deletedPositionsOpen, setDeletedPositionsOpen] = useState(false);
  const [creatingPosition, setCreatingPosition] = useState(false);
  const [trashed, setTrashed] = useState<readonly TrashedPosition[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const refreshTrashed = () => {
    positionBridge.trashedList
      .invoke()
      .then(setTrashed)
      .catch(() => {
        // No trash: the queues simply read empty.
      });
  };

  useEffect(() => {
    refreshTrashed();
    // The hide semantics this page replaced left its list behind in older
    // profiles; nothing reads it now, so it goes on the first mount.
    try {
      localStorage.removeItem('monitor-hidden-positions');
    } catch {
      // Storage unavailable: nothing was hidden anyway.
    }
  }, []);

  // The cards keep their own clock (the overview's tick drives its memo); a
  // slow tick here keeps the team cards' relative times honest too.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const { positionCards, teamWall } = overview;
  const nothingAtAll =
    positionCards.length === 0 &&
    teamWall.active.length === 0 &&
    teamWall.retired.length === 0 &&
    teamWall.deleted.length === 0 &&
    trashed.length === 0;
  const noWorkHappening =
    teamWall.active.length === 0 && positionCards.every((card) => card.state === 'idle' || !card.conversationId);

  const openTeam = (card: TeamCard) => {
    const lead = card.entry.leadConversationId;
    if (!lead) return;
    void navigate(`/conversation/${lead}`);
  };

  // The lifecycle popover's save: one bridge write, then the wall re-reads
  // the shared index. A failed write surfaces as a toast, never as a throw.
  const setLifecycle = async (card: TeamCard, ttlDays: number, permanent: boolean): Promise<void> => {
    const answer = await supervisorBridge.setTeamLifecycle.invoke({ teamId: card.entry.team.id, ttlDays, permanent });
    if (answer.ok) {
      overview.refreshTeamsIndex();
    } else {
      Message.error(t('monitor.teams.lifecycle.saveFailed'));
    }
  };

  // The card's delete: one index stamp — the team and its conversations leave
  // every surface at once (the sidebar re-reads the index with the list
  // refresh), the backend keeps them for the 7-day restore grace.
  const deleteTeam = async (card: TeamCard): Promise<void> => {
    const answer = await supervisorBridge.softDeleteTeam.invoke({ teamId: card.entry.team.id });
    if (answer.ok) {
      refreshTeamsList();
      overview.refreshTeamsIndex();
    } else {
      Message.error(t('monitor.teams.deleteFailed'));
    }
  };

  // The restore queue's row: the stamp leaves, the team is back on every
  // surface with a fresh lifecycle lease.
  const restoreTeam = async (card: TeamCard): Promise<void> => {
    const answer = await supervisorBridge.restoreTeam.invoke({ teamId: card.entry.team.id });
    if (answer.ok) {
      refreshTeamsList();
      overview.refreshTeamsIndex();
    } else {
      Message.error(t('monitor.teams.restoreFailed'));
    }
  };

  // The position card's delete: the library file moves into the quarantine,
  // the roster and both walls drop it at once, 7 days to restore.
  const deletePosition = async (position: PositionInfo): Promise<void> => {
    const answer = await positionBridge.deletePosition.invoke({ name: position.name });
    if (answer.ok) {
      await refreshPositions();
      refreshTrashed();
    } else {
      Message.error(t('monitor.positions.deleteFailed'));
    }
  };

  // The quarantine row's restore: the file moves back to its origin name and
  // the roster picks it up on the refetch.
  const restorePosition = async (entry: TrashedPosition): Promise<void> => {
    const answer = await positionBridge.restorePosition.invoke({ file: entry.file });
    if (answer.ok) {
      setTrashed(answer.data);
      await refreshPositions();
    } else {
      Message.error(t('monitor.positions.restoreFailed'));
    }
  };

  if (nothingAtAll) {
    return (
      <div data-testid='monitor-page' className={classNames('size-full overflow-y-auto', styles.root)}>
        <div className='max-w-560px mx-auto px-24px py-80px flex flex-col items-center gap-12px text-center'>
          <div className='text-18px font-600 tracking-[-0.015em] leading-[1.15] text-t-primary'>
            {t('monitor.title')}
          </div>
          <div className='text-13px text-t-tertiary'>{t('monitor.empty.hint')}</div>
          <Button type='primary' onClick={() => openSupervisor()}>
            {t('monitor.empty.action')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div data-testid='monitor-page' className={classNames('size-full overflow-y-auto', styles.root)}>
      <div className='max-w-1080px mx-auto px-24px py-20px pb-40px flex flex-col gap-24px'>
        <div className='flex items-baseline gap-12px'>
          <span className='text-18px font-600 tracking-[-0.015em] leading-[1.15] text-t-primary'>
            {t('monitor.title')}
          </span>
          <span data-testid='monitor-summary' className='text-12px text-t-tertiary'>
            {t('monitor.summary', {
              positions: overview.positionCount,
              teams: overview.activeTeamCount,
              active: overview.activeCount,
            })}
          </span>
        </div>

        <section data-testid='monitor-positions-wall' className='flex flex-col gap-12px'>
          <div className='flex items-center gap-10px'>
            <span className='text-13px font-500 text-t-secondary'>{t('monitor.positions.title')}</span>
            {/* The creation wizard's monitor entry, the same dialog the sidebar's + opens. */}
            <Button
              data-testid='monitor-positions-create'
              size='mini'
              onClick={() => setCreatingPosition(true)}
              icon={<Plus theme='outline' size='12' fill='currentColor' style={{ lineHeight: 0 }} />}
            >
              {t('positions.wizard.entry')}
            </Button>
            {trashed.length > 0 ? (
              <RestoreFoldHeader
                testId='monitor-positions-deleted-toggle'
                open={deletedPositionsOpen}
                onToggle={() => setDeletedPositionsOpen((prev) => !prev)}
                label={`${t('monitor.positions.deletedFold', { count: trashed.length })} · ${t('monitor.daysLeft', {
                  count: Math.min(...trashed.map((entry) => trashDaysLeftOf(entry.deletedAt, now))),
                })}`}
              />
            ) : null}
          </div>
          <div className='grid gap-12px grid-cols-[repeat(auto-fill,minmax(230px,1fr))]'>
            {positionCards.map((card) => (
              <PositionWallCard
                key={card.position.name}
                card={card}
                now={now}
                onOpen={openPosition}
                onDelete={deletePosition}
              />
            ))}
          </div>
          {deletedPositionsOpen && trashed.length > 0 ? (
            <div className='flex flex-col gap-4px'>
              {trashed.map((entry) => (
                <RestoreRow
                  key={entry.file}
                  testId={`monitor-deleted-position-${entry.name}`}
                  name={entry.displayName}
                  daysLeft={trashDaysLeftOf(entry.deletedAt, now)}
                  onRestore={() => void restorePosition(entry)}
                />
              ))}
            </div>
          ) : null}
        </section>

        <section data-testid='monitor-teams-wall' className='flex flex-col gap-12px'>
          <div className='flex items-center gap-10px'>
            <span className='text-13px font-500 text-t-secondary'>{t('monitor.teams.title')}</span>
            {noWorkHappening ? <span className='text-12px text-t-quaternary'>{t('monitor.empty.hint')}</span> : null}
          </div>
          {teamWall.active.length === 0 ? (
            <div className='text-12px text-t-quaternary px-2px'>{t('monitor.teams.none')}</div>
          ) : (
            <div className='grid gap-12px grid-cols-[repeat(auto-fill,minmax(320px,1fr))]'>
              {teamWall.active.map((card) => (
                <TeamWallCard
                  key={card.entry.team.id}
                  card={card}
                  now={now}
                  onOpen={openTeam}
                  onSetLifecycle={setLifecycle}
                  onDelete={deleteTeam}
                />
              ))}
            </div>
          )}
          {teamWall.retired.length > 0 ? (
            <div className='flex flex-col gap-8px'>
              <div
                data-testid='monitor-retired-toggle'
                role='button'
                tabIndex={0}
                aria-expanded={retiredOpen}
                className='self-start text-12px text-t-quaternary cursor-pointer hover:text-t-secondary px-2px'
                onClick={() => setRetiredOpen((prev) => !prev)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  setRetiredOpen((prev) => !prev);
                }}
              >
                {t('monitor.teams.retiredFold', { count: teamWall.retired.length })}
              </div>
              {retiredOpen ? (
                <div className='grid gap-12px grid-cols-[repeat(auto-fill,minmax(320px,1fr))] opacity-60'>
                  {teamWall.retired.map((card) => (
                    <TeamWallCard
                      key={card.entry.team.id}
                      card={card}
                      now={now}
                      onOpen={openTeam}
                      onSetLifecycle={setLifecycle}
                      onDelete={deleteTeam}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {teamWall.deleted.length > 0 ? (
            <div className='flex flex-col gap-8px'>
              <RestoreFoldHeader
                testId='monitor-teams-deleted-toggle'
                open={deletedTeamsOpen}
                onToggle={() => setDeletedTeamsOpen((prev) => !prev)}
                label={`${t('monitor.teams.deletedFold', { count: teamWall.deleted.length })} · ${t(
                  'monitor.daysLeft',
                  {
                    count: Math.min(
                      ...teamWall.deleted.map((card) => deletedDaysLeftOf(card.entry.deletedAt ?? now, now))
                    ),
                  }
                )}`}
              />
              {deletedTeamsOpen ? (
                <div className='flex flex-col gap-4px'>
                  {teamWall.deleted.map((card) => (
                    <RestoreRow
                      key={card.entry.team.id}
                      testId={`monitor-deleted-team-${card.entry.team.id}`}
                      name={card.entry.team.name}
                      daysLeft={deletedDaysLeftOf(card.entry.deletedAt ?? now, now)}
                      onRestore={() => void restoreTeam(card)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
        <PositionCreationModal open={creatingPosition} onClose={() => setCreatingPosition(false)} />
      </div>
    </div>
  );
};

export default MonitorPage;
