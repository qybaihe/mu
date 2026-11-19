/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The sidebar's position roster: every position of the user's position library
 * as a row, one click from that position's 1:1 conversation, with the built-in
 * supervisor fixed at the top — the position that assembles and reuses
 * temporary teams. A section of its own at the top of the conversation list,
 * foldable like the list's sections and folded the same way across reloads.
 * The library's rows follow the library's order; the desktop adds nothing
 * below them.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@arco-design/web-react';
import { Robot, Right, Connect } from '@icon-park/react';
import classNames from 'classnames';
import { findPositionConversationId, type PositionInfo } from '@/common/chat/positions/positionLibraryCore';
import { SUPERVISOR_POSITION_NAME } from '@/common/chat/supervisor/supervisorCore';
import { useConversationHistoryContext } from '@renderer/hooks/context/ConversationHistoryContext';
import { useAssistantList } from '@renderer/hooks/assistant/useAssistantList';
import { selectableAssistants } from '@renderer/utils/model/assistantSelection';
import { useOpenPosition } from '@renderer/pages/positions/openPosition';
import { useOpenSupervisor } from '@renderer/pages/positions/openSupervisor';
import { usePositionRoster } from '@renderer/pages/positions/usePositionRoster';
import { rowButtonProps } from '@renderer/utils/ui/rowButton';

const FOLDED_KEY = 'sider-positions-folded';

const readFolded = (): boolean => {
  try {
    return localStorage.getItem(FOLDED_KEY) === '1';
  } catch {
    return false;
  }
};

type PositionRowProps = {
  position: PositionInfo;
  /** The conversation already bound to the position, when one exists. */
  conversationId: string | undefined;
  onOpen: (position: PositionInfo) => void;
};

const PositionRow: React.FC<PositionRowProps> = ({ position, conversationId, onOpen }) => {
  const { t } = useTranslation();
  const tooltip = position.projectRoot ? `${position.description}\n${position.projectRoot}` : position.description;
  return (
    <Tooltip content={tooltip} position='right' trigger='hover' unmountOnExit mini>
      <div
        data-testid={`sider-position-${position.name}`}
        aria-label={t('positions.rowA11y', { name: position.displayName })}
        className={classNames(
          'h-28px mx-8px ps-14px pe-8px flex items-center gap-8px rd-6px cursor-pointer shrink-0 min-w-0 transition-colors',
          conversationId ? 'text-t-primary' : 'text-t-secondary hover:text-t-primary hover:bg-fill-3 active:bg-fill-4'
        )}
        {...rowButtonProps(() => onOpen(position))}
      >
        <Robot
          theme='outline'
          size='14'
          fill='currentColor'
          className='block leading-none shrink-0'
          style={{ lineHeight: 0 }}
        />
        <span className='text-13px leading-20px truncate'>{position.displayName}</span>
        {conversationId ? <span className='ms-auto me-2px size-6px rd-full bg-primary shrink-0' /> : null}
      </div>
    </Tooltip>
  );
};

/** The built-in supervisor's fixed row at the top of the roster. */
const SupervisorRow: React.FC<{ conversationId: string | undefined; onOpen: () => void }> = ({
  conversationId,
  onOpen,
}) => {
  const { t } = useTranslation();
  return (
    <Tooltip content={t('supervisor.tooltip')} position='right' trigger='hover' unmountOnExit mini>
      <div
        data-testid={`sider-position-${SUPERVISOR_POSITION_NAME}`}
        aria-label={t('supervisor.rowA11y')}
        className={classNames(
          'h-28px mx-8px ps-14px pe-8px flex items-center gap-8px rd-6px cursor-pointer shrink-0 min-w-0 transition-colors',
          conversationId ? 'text-t-primary' : 'text-t-secondary hover:text-t-primary hover:bg-fill-3 active:bg-fill-4'
        )}
        {...rowButtonProps(onOpen)}
      >
        <Connect
          theme='outline'
          size='14'
          fill='currentColor'
          className='block leading-none shrink-0'
          style={{ lineHeight: 0 }}
        />
        <span className='text-13px leading-20px truncate'>{t('supervisor.title')}</span>
        {conversationId ? <span className='ms-auto me-2px size-6px rd-full bg-primary shrink-0' /> : null}
      </div>
    </Tooltip>
  );
};

/** The roster section: a fold of positions, each row opening that position's 1:1 conversation. */
const SiderPositionsGroup: React.FC<{ onSessionClick?: () => void }> = ({ onSessionClick }) => {
  const { t } = useTranslation();
  const { positions } = usePositionRoster();
  const { conversations } = useConversationHistoryContext();
  const { assistants, assistantOrder } = useAssistantList();
  // The primary selectable assistant — mu when it is enabled — not the raw list's first
  // row, which may be a disabled builtin (AionUi Butler) without a model of its own.
  const primaryAssistantId = selectableAssistants(assistants, assistantOrder)[0]?.id ?? null;
  const openPosition = useOpenPosition(conversations, primaryAssistantId);
  const openSupervisor = useOpenSupervisor(conversations, primaryAssistantId);
  const [folded, setFolded] = useState<boolean>(readFolded);

  useEffect(() => {
    try {
      localStorage.setItem(FOLDED_KEY, folded ? '1' : '0');
    } catch {
      // The fold simply does not persist; the section still works.
    }
  }, [folded]);

  if (positions.length === 0) return null;

  const handleOpen = (position: PositionInfo) => {
    openPosition(position);
    onSessionClick?.();
  };
  const handleOpenSupervisor = () => {
    openSupervisor();
    onSessionClick?.();
  };

  return (
    <div data-testid='sider-positions' className='shrink-0'>
      <div
        className='group/label sider-section-label flex items-center px-12px h-24px select-none mt-4px cursor-pointer'
        role='button'
        tabIndex={0}
        aria-expanded={!folded}
        aria-label={t('positions.title')}
        onClick={() => setFolded((prev) => !prev)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          setFolded((prev) => !prev);
        }}
      >
        <span className='text-12px text-t-tertiary sider-section-title group-hover/label:text-t-secondary transition-colors font-[500] leading-none'>
          {t('positions.title')}
        </span>
        <span className='ms-2px flex items-center justify-center opacity-0 group-hover/label:opacity-100 transition-opacity text-t-tertiary shrink-0'>
          <Right
            theme='outline'
            size={12}
            className={classNames('transition-transform duration-150', { 'rotate-90': !folded })}
          />
        </span>
      </div>
      {folded ? null : (
        <div className='flex flex-col gap-1px pb-4px'>
          <SupervisorRow
            conversationId={findPositionConversationId(conversations, SUPERVISOR_POSITION_NAME)}
            onOpen={handleOpenSupervisor}
          />
          {positions.map((position) => (
            <PositionRow
              key={position.name}
              position={position}
              conversationId={findPositionConversationId(conversations, position.name)}
              onOpen={handleOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default SiderPositionsGroup;
