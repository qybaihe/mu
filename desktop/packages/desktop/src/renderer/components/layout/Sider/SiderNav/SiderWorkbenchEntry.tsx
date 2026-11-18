/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Tooltip } from '@arco-design/web-react';
import { Connect } from '@icon-park/react';
import classNames from 'classnames';
import { rowButtonProps } from '@renderer/utils/ui/rowButton';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';
import { useAttentionSnapshot } from '@renderer/pages/workbench/attention/attentionStore';

interface SiderWorkbenchEntryProps {
  isMobile: boolean;
  isActive: boolean;
  collapsed: boolean;
  siderTooltipProps: SiderTooltipProps;
  onClick: () => void;
}

/** The workbench way in: a row like the scheduled tasks one, with the attention count as its badge. */
const SiderWorkbenchEntry: React.FC<SiderWorkbenchEntryProps> = ({
  isMobile,
  isActive,
  collapsed,
  siderTooltipProps,
  onClick,
}) => {
  const { t } = useTranslation();
  const snapshot = useAttentionSnapshot();
  const count = snapshot.badgeCount;

  const icon = (
    <Connect
      theme='outline'
      size={collapsed ? '16' : '15'}
      fill='currentColor'
      className='block leading-none shrink-0'
      style={{ lineHeight: 0 }}
    />
  );

  if (collapsed) {
    return (
      <Tooltip {...siderTooltipProps} content={t('team.workbench.title')} position='right'>
        <div
          data-testid='sider-workbench'
          aria-label={t('team.workbench.title')}
          aria-current={isActive ? 'page' : undefined}
          className={classNames(
            'relative w-full h-34px flex items-center justify-center cursor-pointer transition-colors rd-8px text-t-primary',
            isActive ? 'bg-fill-3' : 'hover:bg-fill-3 active:bg-fill-4'
          )}
          {...rowButtonProps(onClick)}
        >
          {icon}
          {count > 0 ? (
            <span className='absolute top-2px end-4px'>
              <Badge count={count} data-testid='sider-workbench-badge' />
            </span>
          ) : null}
        </div>
      </Tooltip>
    );
  }

  return (
    <Tooltip {...siderTooltipProps} content={t('team.workbench.title')} position='right'>
      <div
        data-testid='sider-workbench'
        aria-current={isActive ? 'page' : undefined}
        className={classNames(
          'box-border group h-30px w-full flex items-center justify-start gap-8px ps-10px pe-8px rd-6px cursor-pointer shrink-0 transition-all text-t-secondary hover:text-t-primary',
          isMobile && 'sider-action-btn-mobile',
          isActive ? 'bg-fill-3 !text-t-primary' : 'hover:bg-fill-3 active:bg-fill-4'
        )}
        {...rowButtonProps(onClick)}
      >
        <span className='size-22px flex items-center justify-center shrink-0'>{icon}</span>
        <span className='collapsed-hidden text-t-primary text-13px font-[500] leading-20px'>
          {t('team.workbench.title')}
        </span>
        {count > 0 ? (
          <span className='ms-auto me-4px'>
            <Badge count={count} data-testid='sider-workbench-badge' />
          </span>
        ) : null}
      </div>
    </Tooltip>
  );
};

export default SiderWorkbenchEntry;
