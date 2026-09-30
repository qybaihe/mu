/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useAgentLogos } from '@/renderer/utils/model/agentLogo';
import ThemedLogo from '@/renderer/components/agent/ThemedLogo';
import FlexFullContainer from '@/renderer/components/layout/FlexFullContainer';
import { usePresetAssistantInfo } from '@/renderer/hooks/agent/usePresetAssistantInfo';
import { CronJobIndicator } from '@/renderer/pages/cron';
import { resolveConversationLeadingMark } from '@/renderer/pages/conversation/utils/conversationAssistantIdentity';
import { cleanupSiderTooltips, getSiderTooltipProps } from '@/renderer/utils/ui/siderTooltip';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { useMenuKeyboard } from '@/renderer/hooks/ui/useMenuKeyboard';
import { Checkbox, Dropdown, Menu, Spin, Tooltip } from '@arco-design/web-react';
import { Attention, EditOne, Export, FolderClose, Inbox, MoreOne, Pushpin, Timer } from '@icon-park/react';
import ForkBranchIcon from '@renderer/components/base/ForkBranchIcon';
import classNames from 'classnames';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import type { ConversationRowProps } from './types';
import { isConversationPinned } from './utils/groupingHelpers';

const ConversationRow: React.FC<ConversationRowProps> = (props) => {
  const {
    conversation,
    isGenerating,
    isWaitingConfirmation,
    hasUnread,
    collapsed,
    tooltipEnabled,
    batchMode,
    checked,
    selected,
    menuVisible,
    tabIndex = 0,
    dimIcon = false,
    dragHandle,
  } = props;
  const logos = useAgentLogos();
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const {
    onToggleChecked,
    onConversationClick,
    onOpenMenu,
    onMenuVisibleChange,
    onEditStart,
    onCreateCronTask,
    onArchive,
    onExport,
    onTogglePin,
    onToggleManualUnread,
    isManualUnread,
    getJobStatus,
  } = props;
  const { t } = useTranslation();
  // A conversation nothing has named yet goes by the name the command palette gives it, never a blank row.
  const displayName = conversation.name?.trim() || t('conversation.welcome.newConversation');
  const { info: assistantInfo } = usePresetAssistantInfo(conversation);
  const isPinned = isConversationPinned(conversation);
  // Fork-lineage badge: present only on forked conversations (extra.fork is
  // server-minted by the fork API). Parent name resolves from the loaded
  // sidebar list; a deleted/unloaded parent degrades to the generic tip.
  const forkLineage = (conversation.extra as { fork?: { parent_conversation_id?: string } } | undefined)?.fork;
  const forkParentName = forkLineage?.parent_conversation_id
    ? props.resolveConversationName?.(forkLineage.parent_conversation_id)
    : undefined;
  const cronStatus = getJobStatus(conversation.id);
  const siderTooltipProps = getSiderTooltipProps(tooltipEnabled);
  const inlineNameTooltipEnabled = !collapsed && !isMobile && !!conversation.name;
  const leadingMark = resolveConversationLeadingMark(conversation, assistantInfo, logos);
  // Only a real avatar leads a row. An assistant without one goes by its title alone: no stand-in robot or chat
  // bubble in front of every conversation.
  const hasAvatar = leadingMark.kind === 'emoji' || leadingMark.kind === 'image';
  // Waiting on the user takes visual precedence over the generating spinner: a
  // paused turn still streams frames that mark it "generating", so without this
  // the distinct icon would never win.
  const liveStatus = batchMode ? 'none' : isWaitingConfirmation ? 'waiting' : isGenerating ? 'generating' : 'none';
  const showsUnreadDot = !batchMode && hasUnread && !isGenerating && !isWaitingConfirmation;
  // Collapsed, the leading slot is all a row shows; pinned, it is where the drag handle appears.
  const hasLeadingSlot = collapsed || hasAvatar || isPinned;
  // A row without a leading slot shows its state at its end, where the unread dot is: a live turn, else its scheduled
  // task. So the title does not move when a turn starts or ends, nor when the scheduled tasks load after the list.
  const trailing = hasLeadingSlot
    ? 'none'
    : liveStatus !== 'none'
      ? 'status'
      : cronStatus !== 'none' && !showsUnreadDot
        ? 'cron'
        : 'none';
  // On mobile the row's menu always shows at the end, so the state sits left of it.
  const trailingBesideMenu = isMobile && !batchMode;

  const renderLiveStatus = (size: number) =>
    liveStatus === 'waiting' ? (
      <Attention
        theme='filled'
        size={size}
        className='line-height-0 flex-shrink-0 text-warning animate-wiggle'
        data-testid={`conversation-waiting-confirmation-${conversation.id}`}
      />
    ) : (
      <Spin size={size} />
    );

  const renderLeadingIcon = () => {
    if (cronStatus !== 'none') {
      return <CronJobIndicator status={cronStatus} size={16} className='flex-shrink-0' />;
    }

    // When the row is pinned, hovering reveals an overlay on the leading icon —
    // the drag handle when the row is sortable, otherwise a pushpin marker.
    // We dim the resting icon on hover so the overlay reads cleanly.
    const pinnedHoverFade = isPinned ? 'group-hover:opacity-0 transition-opacity' : '';
    const composedClass = classNames(pinnedHoverFade);

    if (leadingMark.kind === 'emoji') {
      return (
        <span className={classNames('text-16px leading-none flex-shrink-0', composedClass)}>{leadingMark.value}</span>
      );
    }
    if (leadingMark.kind === 'image') {
      return (
        <ThemedLogo
          src={leadingMark.value}
          alt={leadingMark.label}
          className={classNames('w-16px h-16px rounded-50% flex-shrink-0', composedClass)}
        />
      );
    }
    // No avatar. A pinned row keeps a pin where its drag handle appears.
    if (!collapsed) {
      return (
        <Pushpin
          theme='outline'
          size='14'
          className={classNames('line-height-0 flex-shrink-0 text-t-tertiary', composedClass)}
        />
      );
    }
    // Collapsed, the title is hidden, so its first character stands in for it.
    const initial = Array.from(displayName)[0]?.toUpperCase() ?? '·';
    return (
      <span
        className={classNames(
          'size-18px rd-5px flex-center shrink-0 bg-fill-2 text-11px font-[600] leading-none text-t-secondary select-none',
          composedClass
        )}
        data-testid={`conversation-initial-${conversation.id}`}
      >
        {initial}
      </span>
    );
  };

  const handleRowClick = () => {
    cleanupSiderTooltips();
    if (batchMode) {
      onToggleChecked(conversation);
      return;
    }
    onConversationClick(conversation);
  };

  // The row is a button for the keyboard: Tab reaches it, Enter or Space opens the conversation (or checks it in batch
  // mode). Keys pressed on the row's menu button or inside its menu bubble up here and are theirs, not the row's.
  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    handleRowClick();
  };

  const setMenuOpen = useCallback(
    (open: boolean) => {
      if (open) {
        onOpenMenu(conversation);
        return;
      }
      onMenuVisibleChange(conversation.id, false);
    },
    [conversation, onMenuVisibleChange, onOpenMenu]
  );
  const menuKeyboard = useMenuKeyboard<HTMLSpanElement>(menuVisible, setMenuOpen);

  const handleRowContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    cleanupSiderTooltips();
    if (batchMode) {
      return;
    }
    onOpenMenu(conversation);
  };

  const renderCompletionUnreadDot = () => {
    if (!showsUnreadDot) {
      return null;
    }

    return (
      <span className='absolute end-8px top-1/2 -translate-y-1/2 flex items-center justify-center group-hover:hidden group-focus-within:hidden'>
        {/* Inline: the theme's `--primary-6` is comma separated, and the utility class for `rgb(var(--primary-6))` adds
            `/ opacity` to it, which is no colour at all (the dot was there, and could not be seen). */}
        <span
          className='h-8px w-8px rounded-full'
          style={{ background: 'rgb(var(--primary-6))', boxShadow: '0 0 0 2px rgba(var(--primary-6), 0.18)' }}
        />
      </span>
    );
  };

  return (
    <Tooltip key={conversation.id} {...siderTooltipProps} content={displayName} position='right'>
      <div
        id={'c-' + conversation.id}
        className={classNames(
          'chat-history__item h-34px rd-8px flex items-center group cursor-pointer relative overflow-hidden shrink-0 conversation-item [&.conversation-item+&.conversation-item]:mt-2px min-w-0 transition-colors',
          collapsed ? 'justify-center px-0' : 'justify-start gap-8px',
          !collapsed && (trailing !== 'none' ? (trailingBesideMenu ? 'pe-56px' : 'pe-32px') : 'pe-16px'),
          // dimIcon means this row sits inside a project/cron parent — visually indent the row content while keeping the bg full-width.
          // A title without an icon lines up with the section label, or inside a project with the project's name.
          !collapsed && (hasLeadingSlot ? (dimIcon ? 'ps-34px' : 'ps-10px') : dimIcon ? 'ps-40px' : 'ps-12px'),
          {
            'hover:bg-fill-3': !batchMode && !selected,
            '!bg-fill-3': selected,
            'bg-[rgba(var(--primary-6),0.08)]': batchMode && checked,
          }
        )}
        role='button'
        tabIndex={tabIndex}
        data-roving-row={conversation.id}
        aria-label={displayName}
        aria-current={selected ? 'page' : undefined}
        onClick={handleRowClick}
        onKeyDown={handleRowKeyDown}
        onContextMenu={handleRowContextMenu}
      >
        {batchMode && (
          <span
            className='me-8px flex-center'
            onClick={(event) => {
              event.stopPropagation();
              onToggleChecked(conversation);
            }}
          >
            <Checkbox checked={checked} />
          </span>
        )}
        {hasLeadingSlot && (
          <span
            className='size-22px flex items-center justify-center shrink-0 relative'
            data-testid={`conversation-leading-${conversation.id}`}
          >
            {liveStatus !== 'none' ? renderLiveStatus(16) : renderLeadingIcon()}
            {/* Hover overlay on the leading icon: drag handle for sortable pinned rows, pushpin marker otherwise */}
            {!batchMode &&
              isPinned &&
              !isMobile &&
              !isGenerating &&
              !isWaitingConfirmation &&
              (dragHandle ?? (
                <span
                  className='absolute inset-0 flex-center text-t-secondary pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity'
                  style={{ lineHeight: 0 }}
                >
                  <Pushpin theme='outline' size='14' />
                </span>
              ))}
          </span>
        )}
        <FlexFullContainer className='h-24px min-w-0 flex-1 collapsed-hidden'>
          <Tooltip
            content={conversation.name}
            disabled={!inlineNameTooltipEnabled}
            trigger='hover'
            popupVisible={inlineNameTooltipEnabled ? undefined : false}
            unmountOnExit
            popupHoverStay={false}
            position='top'
          >
            <div className='chat-history__item-name overflow-hidden text-ellipsis flex items-center gap-4px w-full text-14px font-[500] lh-24px whitespace-nowrap min-w-0 text-t-primary'>
              <span className='block overflow-hidden text-ellipsis whitespace-nowrap min-w-0'>{displayName}</span>
              {forkLineage && (
                <Tooltip
                  content={
                    forkParentName
                      ? t('conversation.history.forkedFrom', { name: forkParentName })
                      : t('conversation.history.forkedConversation')
                  }
                  position='top'
                >
                  <span className='flex-shrink-0 line-height-0 text-t-tertiary' data-testid='conversation-fork-badge'>
                    <ForkBranchIcon size={12} />
                  </span>
                </Tooltip>
              )}
            </div>
          </Tooltip>
        </FlexFullContainer>

        {renderCompletionUnreadDot()}
        {trailing !== 'none' && (trailingBesideMenu || batchMode || !menuVisible) && (
          // Gives way to the row's menu, which opens in the same place (on mobile the menu always shows, so it moves left).
          <span
            className={classNames(
              'absolute top-1/2 -translate-y-1/2 flex items-center justify-center size-16px',
              trailingBesideMenu ? 'end-32px' : 'end-8px',
              !batchMode && !isMobile && 'group-hover:hidden group-focus-within:hidden'
            )}
            style={{ lineHeight: 0 }}
            data-testid={`conversation-status-${conversation.id}`}
          >
            {trailing === 'status' ? (
              renderLiveStatus(14)
            ) : (
              <CronJobIndicator status={cronStatus} size={14} className='flex-shrink-0' />
            )}
          </span>
        )}
        {!batchMode && (
          <div
            className={classNames(
              'absolute end-8px top-1/2 -translate-y-1/2 items-center justify-end !collapsed-hidden',
              {
                flex: isMobile || menuVisible,
                'hidden group-hover:flex group-focus-within:flex': !isMobile && !menuVisible,
              }
            )}
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <Dropdown
              droplist={
                <Menu
                  ref={menuKeyboard.menuRef}
                  onKeyDown={menuKeyboard.onMenuKeyDown}
                  onClickMenuItem={(key) => {
                    if (key === 'pin') {
                      onTogglePin(conversation);
                      return;
                    }
                    if (key === 'toggleManualUnread') {
                      onToggleManualUnread(conversation);
                      return;
                    }
                    if (key === 'rename') {
                      onEditStart(conversation);
                      return;
                    }
                    if (key === 'createCronTask') {
                      onCreateCronTask(conversation);
                      return;
                    }
                    if (key === 'export') {
                      onExport?.(conversation);
                      return;
                    }
                    if (key === 'archive') {
                      onArchive(conversation);
                    }
                  }}
                >
                  <Menu.Item key='pin'>
                    <div className='flex items-center gap-8px'>
                      <Pushpin theme='outline' size='14' />
                      <span>{isPinned ? t('conversation.history.unpin') : t('conversation.history.pin')}</span>
                    </div>
                  </Menu.Item>
                  <Menu.Item key='toggleManualUnread'>
                    <div className='flex items-center gap-8px'>
                      <Inbox theme='outline' size='14' />
                      <span>
                        {isManualUnread ? t('conversation.history.markAsRead') : t('conversation.history.markAsUnread')}
                      </span>
                    </div>
                  </Menu.Item>
                  <Menu.Item key='rename'>
                    <div className='flex items-center gap-8px'>
                      <EditOne theme='outline' size='14' />
                      <span>{t('conversation.history.rename')}</span>
                    </div>
                  </Menu.Item>
                  <Menu.Item key='createCronTask'>
                    <div className='flex items-center gap-8px'>
                      <Timer theme='outline' size='14' />
                      <span>{t('conversation.history.createCronTask')}</span>
                    </div>
                  </Menu.Item>
                  {onExport && (
                    <Menu.Item key='export'>
                      <div className='flex items-center gap-8px'>
                        <Export theme='outline' size='14' />
                        <span>{t('conversation.history.export')}</span>
                      </div>
                    </Menu.Item>
                  )}
                  <Menu.Item key='archive'>
                    <div className='flex items-center gap-8px'>
                      <FolderClose theme='outline' size='14' />
                      <span>{t('conversation.history.archive')}</span>
                    </div>
                  </Menu.Item>
                </Menu>
              }
              trigger='click'
              position='br'
              popupVisible={menuVisible}
              onVisibleChange={(visible) => onMenuVisibleChange(conversation.id, visible)}
              getPopupContainer={() => document.body}
              unmountOnExit={false}
            >
              <span
                ref={menuKeyboard.buttonRef}
                data-testid={`conversation-row-menu-${conversation.id}`}
                role='button'
                tabIndex={0}
                aria-label={t('conversation.history.conversationActions')}
                aria-haspopup='menu'
                aria-expanded={menuVisible}
                className={classNames(
                  'flex-center cursor-pointer transition-colors text-t-secondary hover:text-t-primary size-20px rd-4px sider-action-btn',
                  {
                    flex: isMobile || menuVisible,
                    'hidden group-hover:flex group-focus-within:flex': !isMobile && !menuVisible,
                  }
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenMenu(conversation);
                }}
                onKeyDown={menuKeyboard.onButtonKeyDown}
              >
                <MoreOne theme='outline' size='14' fill='currentColor' className='block leading-none' />
              </span>
            </Dropdown>
          </div>
        )}
      </div>
    </Tooltip>
  );
};

export default ConversationRow;
