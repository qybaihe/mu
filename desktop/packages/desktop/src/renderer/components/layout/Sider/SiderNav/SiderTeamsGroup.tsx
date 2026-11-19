/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The sidebar's team section: every team's group chat as a row of its own,
 * one click from the lead conversation — the group chat itself. A section
 * like the position roster above it: foldable, folded the same way across
 * reloads. A team past its TTL (the shared index) reads as history: dimmed,
 * tagged, after the active ones. The row never shows the lead conversation's
 * raw name — the team's own name and member count are the identity.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { Tooltip } from '@arco-design/web-react';
import { Comments, Plus, Right } from '@icon-park/react';
import classNames from 'classnames';
import { supervisorBridge } from '@/common/chat/supervisor/supervisorBridge';
import type { SupervisorTeam } from '@/common/chat/supervisor/supervisorCore';
import { useTeamRosterSnapshot } from '@renderer/pages/workbench/team/teamStore';
import {
  rosterEntryHolds,
  stripGroupChatMarker,
  teamRosterEntries,
  type TeamRosterEntry,
} from '@renderer/pages/workbench/team/teamIdentity';
import { usePositionRoster } from '@renderer/pages/positions/usePositionRoster';
import { rowButtonProps } from '@renderer/utils/ui/rowButton';

const FOLDED_KEY = 'sider-teams-folded';

const readFolded = (): boolean => {
  try {
    return localStorage.getItem(FOLDED_KEY) === '1';
  } catch {
    return false;
  }
};

type TeamRowProps = {
  entry: TeamRosterEntry;
  /** The route's conversation id, for the active row. */
  activeConversationId: string | undefined;
  onOpen: (entry: TeamRosterEntry) => void;
};

const TeamRow: React.FC<TeamRowProps> = ({ entry, activeConversationId, onOpen }) => {
  const { t } = useTranslation();
  const active = rosterEntryHolds(entry, activeConversationId);
  // The backend team is the authority for the name (UI- and supervisor-built
  // alike); stripping the marker keeps a hand-renamed lead conversation from
  // saying “群聊” twice — the section already says it.
  const displayName = stripGroupChatMarker(entry.team.name);
  const retiredLabel = entry.retired ? ` · ${t('team.sider.retired')}` : '';
  const tooltip = `${displayName}${retiredLabel}\n${entry.team.assistants.map((a) => a.assistant_name).join(', ')}`;
  return (
    <Tooltip content={tooltip} position='right' trigger='hover' unmountOnExit mini>
      <div
        data-testid={`sider-team-${entry.team.id}`}
        aria-label={`${t('team.sider.rowA11y', { name: displayName, count: entry.memberCount })}${retiredLabel}`}
        className={classNames(
          'h-28px mx-8px ps-8px pe-8px flex items-center gap-8px rd-6px cursor-pointer shrink-0 min-w-0 transition-colors',
          entry.retired ? 'opacity-50' : '',
          active ? 'bg-fill-3 text-t-primary' : 'text-t-secondary hover:text-t-primary hover:bg-fill-3 active:bg-fill-4'
        )}
        {...rowButtonProps(() => onOpen(entry))}
      >
        <span
          className={classNames(
            'flex-center size-20px rd-6px shrink-0',
            entry.retired ? 'bg-fill-2 text-t-tertiary' : 'bg-[rgba(var(--primary-6),0.12)] text-primary'
          )}
        >
          <Comments
            theme='outline'
            size='12'
            fill='currentColor'
            className='block leading-none'
            style={{ lineHeight: 0 }}
          />
        </span>
        <span className='text-13px leading-20px truncate'>{displayName}</span>
        <span
          data-testid={`sider-team-${entry.team.id}-count`}
          className={classNames(
            'ms-auto me-2px text-11px leading-14px px-4px py-1px rd-full shrink-0',
            entry.retired ? 'bg-fill-2 text-t-tertiary' : 'bg-fill-2 text-t-secondary'
          )}
        >
          {t('team.sider.memberCount', { count: entry.memberCount })}
        </span>
      </div>
    </Tooltip>
  );
};

/** The team section: a fold of group chats, each row opening that team's lead conversation — plus
 *  the section header's + button, the one way a group chat is created. */
const SiderTeamsGroup: React.FC<{ onSessionClick?: () => void; onNewGroupChat: () => void }> = ({
  onSessionClick,
  onNewGroupChat,
}) => {
  const { t } = useTranslation();
  const { teams } = useTeamRosterSnapshot();
  const { positions } = usePositionRoster();
  const [index, setIndex] = useState<readonly SupervisorTeam[]>([]);
  const [folded, setFolded] = useState<boolean>(readFolded);
  const navigate = useNavigate();
  const { pathname } = useLocation();

  useEffect(() => {
    try {
      localStorage.setItem(FOLDED_KEY, folded ? '1' : '0');
    } catch {
      // The fold simply does not persist; the section still works.
    }
  }, [folded]);

  // The shared index says which teams are past their TTL. It moves with the
  // team list (a fresh `send` refreshes a team's TTL), so it is re-read then.
  useEffect(() => {
    let cancelled = false;
    supervisorBridge.teams
      .invoke()
      .then((answer) => {
        if (!cancelled && answer.ok) setIndex(answer.data.teams);
      })
      .catch(() => {
        // No index, no retired marks: every team reads active.
      });
    return () => {
      cancelled = true;
    };
  }, [teams]);

  const entries = teamRosterEntries(teams, index, Date.now());
  // No positions to build a group from: the whole section (its + button
  // included) has nothing to offer and stays out of the sidebar.
  if (positions.length === 0 && entries.length === 0) return null;

  const activeCount = entries.filter((entry) => !entry.retired).length;
  const activeConversationId = pathname.startsWith('/conversation/') ? pathname.split('/')[2] : undefined;

  const handleOpen = (entry: TeamRosterEntry) => {
    if (!entry.leadConversationId) return;
    Promise.resolve(navigate(`/conversation/${entry.leadConversationId}`)).catch((error) => {
      console.error('Navigation failed:', error);
    });
    onSessionClick?.();
  };

  return (
    <div data-testid='sider-teams' className='shrink-0'>
      <div
        className='group/label sider-section-label flex items-center px-12px h-24px select-none mt-4px cursor-pointer'
        role='button'
        tabIndex={0}
        aria-expanded={!folded}
        aria-label={t('team.sider.titleA11y', { count: activeCount })}
        onClick={() => setFolded((prev) => !prev)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          setFolded((prev) => !prev);
        }}
      >
        <span className='text-12px text-t-tertiary sider-section-title group-hover/label:text-t-secondary transition-colors font-[500] leading-none'>
          {t('team.sider.title')}
        </span>
        <span
          data-testid='sider-teams-count'
          className='ms-4px text-11px text-t-quaternary leading-none'
        >{`×${activeCount}`}</span>
        <span className='flex-1' />
        <Tooltip content={t('team.groupChat.newEntry')} position='right' trigger='hover' unmountOnExit mini>
          <span
            data-testid='sider-new-group-chat'
            role='button'
            tabIndex={0}
            aria-label={t('team.groupChat.newEntry')}
            className='me-8px size-18px rd-6px flex-center text-t-tertiary hover:text-t-primary hover:bg-fill-3 active:bg-fill-4 cursor-pointer shrink-0'
            onClick={(event) => {
              event.stopPropagation();
              onNewGroupChat();
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              event.stopPropagation();
              onNewGroupChat();
            }}
          >
            <Plus
              theme='outline'
              size='12'
              fill='currentColor'
              className='block leading-none'
              style={{ lineHeight: 0 }}
            />
          </span>
        </Tooltip>
        <span className='me-4px flex items-center justify-center opacity-0 group-hover/label:opacity-100 transition-opacity text-t-tertiary shrink-0'>
          <Right
            theme='outline'
            size={12}
            className={classNames('transition-transform duration-150', { 'rotate-90': !folded })}
          />
        </span>
      </div>
      {folded ? null : (
        <div className='flex flex-col gap-1px pb-4px'>
          {entries.map((entry) => (
            <TeamRow
              key={entry.team.id}
              entry={entry}
              activeConversationId={activeConversationId}
              onOpen={handleOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default SiderTeamsGroup;
