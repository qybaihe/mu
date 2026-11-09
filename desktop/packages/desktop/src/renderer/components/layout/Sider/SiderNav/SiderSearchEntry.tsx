/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Tooltip } from '@arco-design/web-react';
import { Search } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import classNames from 'classnames';
import { toggleCommandPalette } from '@renderer/components/layout/Sider/CommandPalette';
import { COMMAND_PALETTE_SHORTCUT, formatPrimaryShortcut } from '@renderer/utils/ui/keyboardShortcuts';
import { rowButtonProps } from '@renderer/utils/ui/rowButton';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';

type SiderSearchEntryProps = {
  isMobile: boolean;
  collapsed: boolean;
  siderTooltipProps: SiderTooltipProps;
};

/**
 * The sidebar's search: it opens the command palette, the same one Cmd/Ctrl+K opens. Like the rows beside it, it
 * takes the focus with Tab, in the order the rows are shown, and Enter or Space presses it.
 */
const SiderSearchEntry: React.FC<SiderSearchEntryProps> = ({ isMobile, collapsed, siderTooltipProps }) => {
  const { t } = useTranslation();
  const label = t('conversation.historySearch.shortTitle');
  const shortcut = formatPrimaryShortcut(COMMAND_PALETTE_SHORTCUT);
  const tooltip = `${t('common.commandPalette.placeholder')} (${shortcut})`;

  if (collapsed) {
    return (
      <Tooltip {...siderTooltipProps} content={tooltip} position='right'>
        <div
          data-testid='sider-search'
          aria-label={label}
          className='w-full h-34px flex items-center justify-center cursor-pointer transition-colors rd-8px text-t-primary hover:bg-fill-3 active:bg-fill-4'
          {...rowButtonProps(toggleCommandPalette)}
        >
          <Search
            theme='outline'
            size='16'
            fill='currentColor'
            className='block leading-none shrink-0'
            style={{ lineHeight: 0 }}
          />
        </div>
      </Tooltip>
    );
  }

  return (
    <Tooltip {...siderTooltipProps} content={tooltip} position='right'>
      <div
        data-testid='sider-search'
        className={classNames(
          'box-border group h-30px w-full flex items-center justify-start gap-8px ps-10px pe-8px rd-6px cursor-pointer shrink-0 transition-all text-t-secondary hover:text-t-primary hover:bg-fill-3 active:bg-fill-4',
          isMobile && 'sider-action-btn-mobile'
        )}
        {...rowButtonProps(toggleCommandPalette)}
      >
        <span className='size-22px flex items-center justify-center shrink-0'>
          <Search
            theme='outline'
            size='15'
            fill='currentColor'
            className='block leading-none'
            style={{ lineHeight: 0 }}
          />
        </span>
        <span className='collapsed-hidden text-t-primary text-13px font-[500] leading-20px'>{label}</span>
        <span className='collapsed-hidden ms-auto text-12px text-t-tertiary'>{shortcut}</span>
      </div>
    </Tooltip>
  );
};

export default SiderSearchEntry;
