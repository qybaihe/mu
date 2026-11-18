/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The "Needs your attention" list: one row per item, click opens its conversation; a
 * failure row also carries "Mark as handled" — the only way a failure ever leaves the
 * list. Approvals and questions answer themselves: they are live waits, and answered
 * turns drop them from the wire.
 */
import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button, Empty, Tag } from '@arco-design/web-react';
import { Attention } from '@icon-park/react';
import classNames from 'classnames';
import { rowButtonProps } from '@renderer/utils/ui/rowButton';
import type { AttentionItem } from './attentionCore';
import { useAttentionSnapshot, useDismissAttentionFailure } from './attentionStore';
import styles from './AttentionPanel.module.css';

const timeOf = (at: number, language: string): string => {
  try {
    return new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }).format(new Date(at));
  } catch {
    return '';
  }
};

const AttentionRow: React.FC<{
  item: AttentionItem;
  name: string;
  timeLabel: string;
  onOpen: (conversationId: string) => void;
  onDismissFailure: (failureKey: string) => void;
}> = ({ item, name, timeLabel, onOpen, onDismissFailure }) => {
  const { t } = useTranslation();
  return (
    <div
      data-testid={`attention-row-${item.kind}`}
      className={classNames(
        'group w-full flex items-center gap-8px px-10px py-8px rd-6px cursor-pointer transition-colors',
        'hover:bg-fill-2 active:bg-fill-3 text-t-primary',
        styles.row
      )}
      {...rowButtonProps(() => onOpen(item.conversationId))}
    >
      <span className='size-22px flex items-center justify-center shrink-0 text-t-secondary'>
        <Attention
          theme='outline'
          size='15'
          fill='currentColor'
          className={classNames('block leading-none shrink-0', item.kind === 'failure' && styles.failureIcon)}
          style={{ lineHeight: 0 }}
        />
      </span>
      <span className='flex-1 min-w-0 flex flex-col gap-2px'>
        <span className='truncate text-13px font-[500] leading-18px'>{name}</span>
        <span className='flex items-center gap-6px text-12px leading-16px text-t-secondary'>
          <Tag
            size='small'
            className={classNames(item.kind === 'failure' && styles.failureTag)}
            data-testid={`attention-kind-${item.kind}`}
          >
            {t(
              item.kind === 'approval'
                ? 'team.workbench.attention.approval'
                : item.kind === 'question'
                  ? 'team.workbench.attention.question'
                  : 'team.workbench.attention.failure'
            )}
          </Tag>
          <span>{timeLabel}</span>
        </span>
      </span>
      {item.kind === 'failure' ? (
        <Button
          size='mini'
          type='text'
          className={styles.handledButton}
          aria-label={t('team.workbench.attention.markHandledA11y', { name })}
          onClick={(event) => {
            event.stopPropagation();
            onDismissFailure(item.key);
          }}
        >
          {t('team.workbench.attention.markHandled')}
        </Button>
      ) : null}
    </div>
  );
};

const AttentionPanel: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const snapshot = useAttentionSnapshot();
  const dismissFailure = useDismissAttentionFailure();

  const onOpen = useCallback(
    (conversationId: string) => {
      void navigate(`/conversation/${conversationId}`);
    },
    [navigate]
  );

  const rows = useMemo(
    () =>
      snapshot.items.map((item) => ({
        item,
        name: snapshot.conversationNames.get(item.conversationId) || t('common.tray.untitled'),
        timeLabel: timeOf(item.at, i18n.language),
      })),
    [snapshot.items, snapshot.conversationNames, t, i18n.language]
  );

  if (rows.length === 0) {
    return (
      <div className='w-full h-full flex items-center justify-center py-48px' data-testid='attention-empty'>
        <Empty description={t('team.workbench.attention.empty')} />
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-2px py-4px' data-testid='attention-list'>
      {rows.map((row) => (
        <AttentionRow
          key={row.item.key}
          item={row.item}
          name={row.name}
          timeLabel={row.timeLabel}
          onOpen={onOpen}
          onDismissFailure={dismissFailure}
        />
      ))}
    </div>
  );
};

export default AttentionPanel;
