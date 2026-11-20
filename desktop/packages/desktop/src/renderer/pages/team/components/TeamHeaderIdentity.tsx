/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A team conversation's identity in the header: the member strip (one initial
 * per slot, overlapping) and the pill that says what kind of thread this is —
 * the group chat itself for a lead conversation, a member of the team for a
 * teammate's private thread. It replaces the ordinary agent logo there, so a
 * team conversation is recognizable at a glance; ordinary conversations never
 * mount it.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@arco-design/web-react';
import classNames from 'classnames';
import { useTeamRosterSnapshot } from '../core/teamStore';
import { memberIdentityColor, memberInitial } from '../core/teamIdentity';
import { usePositionRoster } from '@renderer/pages/positions/usePositionRoster';
import TeamMembersManager from './TeamMembersManager';
import TeamWorkspaceHandoff from './TeamWorkspaceHandoff';

/** How many member circles the strip shows before it summarizes the rest. */
const MAX_VISIBLE_MEMBERS = 3;

type Props = {
  teamId: string;
  /** The conversation's own role: the lead hosts the group chat itself. */
  role: string | undefined;
};

const TeamHeaderIdentity: React.FC<Props> = ({ teamId, role }) => {
  const { t } = useTranslation();
  const { teams } = useTeamRosterSnapshot();
  const { positions } = usePositionRoster();
  const team = teams.find((candidate) => candidate.id === teamId);
  if (!team || team.assistants.length === 0) return null;

  const members = team.assistants.map((assistant) => assistant.assistant_name);
  const visible = members.slice(0, MAX_VISIBLE_MEMBERS);
  const overflow = members.length - visible.length;
  const pill =
    role === 'lead'
      ? t('team.header.groupChatPill', { count: members.length })
      : t('team.header.teamPill', { count: members.length });

  return (
    <Tooltip content={t('team.header.members', { names: members.join(', ') })} position='bottom' mini>
      <div data-testid='team-header-identity' className='flex items-center gap-6px'>
        <div className='flex items-center ps-2px'>
          {visible.map((name, i) => {
            // One initial per member on that member's position identity colour —
            // the same hue the roster row and the monitor card carry.
            const identity = memberIdentityColor(name, positions);
            return (
              <span
                key={`${name}-${i}`}
                className={classNames(
                  'size-18px rd-full flex-center text-10px font-medium',
                  i > 0 ? '-ms-6px' : '',
                  'border-1px border-solid border-[var(--bg-2)]'
                )}
                style={{ background: identity.background, color: identity.foreground, zIndex: visible.length - i }}
              >
                {memberInitial(name)}
              </span>
            );
          })}
          {overflow > 0 ? (
            <span className='size-18px rd-full flex-center text-10px font-medium bg-fill-2 text-t-tertiary -ms-6px border-1px border-solid border-[var(--bg-2)]'>
              +{overflow}
            </span>
          ) : null}
        </div>
        <span
          data-testid='team-header-identity-pill'
          className='text-11px leading-16px px-6px py-1px rd-full whitespace-nowrap bg-[rgba(var(--primary-6),0.12)] text-primary'
        >
          {pill}
        </span>
        {/* The workspace record is the team's, so both threads of it — the
            group chat and a member's private thread — carry the entry. */}
        {team.workspace ? <TeamWorkspaceHandoff team={team} /> : null}
        {/* Member management lives on the group chat itself: the lead thread. A teammate's
            private thread sees the identity but never the manager. */}
        {role === 'lead' ? <TeamMembersManager team={team} /> : null}
      </div>
    </Tooltip>
  );
};

export default TeamHeaderIdentity;
