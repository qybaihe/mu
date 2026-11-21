/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One ⚡ steward row (上下文管家): the light marker saying what the steward
 * did — compacted in place, switched to a fresh part, or (the row a new part
 * opens with) continued from one — plus the one-line reason and, on click,
 * the numbers behind the call. Deliberately NOT a message bubble: the main
 * model never learns the steward acted; the row reads as a system note the
 * app itself wrote.
 */
import { Popover } from '@arco-design/web-react';
import { Layers } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ContextStewardNote } from '@renderer/pages/team/core/notes/contextStewardNotes';

const ContextStewardRow: React.FC<{ note: ContextStewardNote }> = ({ note }) => {
  const { t } = useTranslation();
  const percentText =
    note.percent !== undefined && note.percent !== null && Number.isFinite(note.percent)
      ? `${Math.round(note.percent * 100)}%`
      : undefined;
  const basis = (
    <div className='space-y-2px text-12px leading-18px' data-testid='context-steward-basis'>
      {note.tokens !== undefined && (
        <div>
          {t('contextSteward.details.tokens')}: {note.tokens} / {note.contextWindow ?? '—'}
          {percentText ? ` (${percentText})` : ''}
        </div>
      )}
      {note.part !== undefined && <div>{t('contextSteward.details.part', { part: note.part })}</div>}
      {note.reason && (
        <div>
          {t('contextSteward.details.reason')}: {note.reason}
        </div>
      )}
    </div>
  );
  const title =
    note.kind === 'compact'
      ? t('contextSteward.compact.title')
      : note.kind === 'switch'
        ? t('contextSteward.switch.title', { part: note.part ?? '' })
        : t('contextSteward.continuation.title', { part: note.part ?? '' });
  const body =
    note.kind === 'compact'
      ? t('contextSteward.compact.body', { reason: note.reason })
      : note.kind === 'switch'
        ? t('contextSteward.switch.body', {
            reason: note.reason,
            target: note.newTitle ?? '',
          })
        : t('contextSteward.continuation.body', { source: note.oldTitle ?? '' });
  return (
    <div className='flex flex-col gap-4px py-6px' data-testid='context-steward-row' data-note-kind={note.kind}>
      <div className='flex items-center gap-6px'>
        <span className='inline-flex items-center gap-4px rd-full px-8px py-2px text-12px leading-18px font-500 bg-[rgba(var(--warning-6),0.12)] text-[rgb(var(--warning-6))]'>
          <Layers theme='outline' size='12' fill='currentColor' />
          <span data-testid='context-steward-title'>{title}</span>
        </span>
      </div>
      <div className='text-12px leading-18px text-t-tertiary' data-testid='context-steward-body'>
        {body}
      </div>
      <div className='flex'>
        <Popover content={basis} trigger='click' position='top'>
          <span
            className='text-12px leading-18px text-t-quaternary cursor-pointer hover:text-t-secondary'
            data-testid='context-steward-basis-trigger'
          >
            {t('contextSteward.details.trigger')}
          </span>
        </Popover>
      </div>
    </div>
  );
};

export default ContextStewardRow;
