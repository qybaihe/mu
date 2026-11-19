/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The sidebar's way into the division-of-labor monitor: a row above the
 * group-chat section, badged with how many positions and group chats are
 * mid-flight right now — the live count from the same stores the page
 * reads. No positions and no teams at all: nothing to monitor, no row.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { Tooltip } from '@arco-design/web-react';
import { Dashboard } from '@icon-park/react';
import classNames from 'classnames';
import { rowButtonProps } from '@renderer/utils/ui/rowButton';
import { useMonitorOverview } from '@renderer/pages/monitor/useMonitorOverview';

const SiderMonitorEntry: React.FC<{ onSessionClick?: () => void }> = ({ onSessionClick }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const overview = useMonitorOverview(false);
  const active = pathname === '/monitor';
  const hasAnything =
    overview.positionCount > 0 || overview.activeTeamCount > 0 || overview.teamWall.retired.length > 0;
  if (!hasAnything) return null;
  return (
    <Tooltip content={t('monitor.title')} position='right' trigger='hover' unmountOnExit mini>
      <div
        data-testid='sider-monitor'
        aria-current={active ? 'page' : undefined}
        aria-label={t('monitor.entryA11y')}
        className={classNames(
          'h-30px mx-8px ps-10px pe-8px flex items-center gap-8px rd-6px cursor-pointer shrink-0 transition-colors',
          active ? 'bg-fill-3 text-t-primary' : 'text-t-secondary hover:text-t-primary hover:bg-fill-3 active:bg-fill-4'
        )}
        {...rowButtonProps(() => {
          void navigate('/monitor');
          onSessionClick?.();
        })}
      >
        <span className='size-22px flex items-center justify-center shrink-0'>
          <Dashboard
            theme='outline'
            size='14'
            fill='currentColor'
            className='block leading-none'
            style={{ lineHeight: 0 }}
          />
        </span>
        <span className='text-13px font-500 leading-20px truncate'>{t('monitor.title')}</span>
        <span className='flex-1' />
        {overview.activeCount > 0 ? (
          <span
            data-testid='sider-monitor-badge'
            className='me-2px min-w-18px h-16px px-4px rd-full flex-center text-11px leading-none bg-[rgba(var(--success-6),0.14)] text-[rgb(var(--success-6))] shrink-0'
          >
            {overview.activeCount}
          </span>
        ) : null}
      </div>
    </Tooltip>
  );
};

export default SiderMonitorEntry;
