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
import { Button } from '@arco-design/web-react';
import classNames from 'classnames';
import type { PositionInfo } from '@/common/chat/positions/positionLibraryCore';
import { positionIdentityColor } from '@/common/chat/positions/positionIdentityColor';
import { useConversationHistoryContext } from '@renderer/hooks/context/ConversationHistoryContext';
import { useAssistantList } from '@renderer/hooks/assistant/useAssistantList';
import { selectableAssistants } from '@renderer/utils/model/assistantSelection';
import { useOpenPosition } from '@renderer/pages/positions/openPosition';
import { useOpenSupervisor } from '@renderer/pages/positions/openSupervisor';
import { rowButtonProps } from '@renderer/utils/ui/rowButton';
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

const PositionWallCard: React.FC<{ card: PositionCard; now: number; onOpen: (position: PositionInfo) => void }> = ({
  card,
  now,
  onOpen,
}) => {
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

const TeamWallCard: React.FC<{ card: TeamCard; now: number; onOpen: (card: TeamCard) => void }> = ({
  card,
  now,
  onOpen,
}) => {
  const { t } = useTranslation();
  const { entry } = card;
  const total = card.counts.todo + card.counts.inProgress + card.counts.done;
  const ttlNear = card.ttlDays !== undefined && !entry.retired && isNearExpiry(card.ttlDays);
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
          <span
            data-testid={`monitor-team-${entry.team.id}-ttl`}
            className={classNames(
              'text-12px px-6px py-1px rd-10px shrink-0',
              ttlNear ? 'bg-[rgba(var(--warning-6),0.12)] text-[rgb(var(--warning-6))]' : 'bg-fill-2 text-t-tertiary'
            )}
          >
            {t('monitor.teams.ttl', { days: card.ttlDays })}
          </span>
        ) : null}
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
  const [now, setNow] = useState(() => Date.now());

  // The cards keep their own clock (the overview's tick drives its memo); a
  // slow tick here keeps the team cards' relative times honest too.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const { positionCards, teamWall } = overview;
  const nothingAtAll = positionCards.length === 0 && teamWall.active.length === 0 && teamWall.retired.length === 0;
  const noWorkHappening =
    teamWall.active.length === 0 && positionCards.every((card) => card.state === 'idle' || !card.conversationId);

  const openTeam = (card: TeamCard) => {
    const lead = card.entry.leadConversationId;
    if (!lead) return;
    void navigate(`/conversation/${lead}`);
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
          <div className='text-13px font-500 text-t-secondary'>{t('monitor.positions.title')}</div>
          <div className='grid gap-12px grid-cols-[repeat(auto-fill,minmax(230px,1fr))]'>
            {positionCards.map((card) => (
              <PositionWallCard key={card.position.name} card={card} now={now} onOpen={openPosition} />
            ))}
          </div>
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
                <TeamWallCard key={card.entry.team.id} card={card} now={now} onOpen={openTeam} />
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
                    <TeamWallCard key={card.entry.team.id} card={card} now={now} onOpen={openTeam} />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
};

export default MonitorPage;
