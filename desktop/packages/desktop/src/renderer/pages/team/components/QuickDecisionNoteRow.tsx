/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One ⚡ receipt row: the light marker (复用〈队名〉 / 本岗外拒绝 / 直达〈成员〉 /
 * 分派提示已注入), the one-line receipt under it, and — on click — the
 * decision's basis (model, duration, confidence, cache). Deliberately NOT a
 * message bubble: nothing went through the model, so the row reads as a
 * system note the app itself wrote. The trigger is a native span: Arco
 * Trigger clones its events into the child, which silently dies on a custom
 * component that does not forward them.
 */
import { Popover } from '@arco-design/web-react';
import { Thunderbolt } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { QuickDecisionNote } from '@renderer/pages/team/core/notes/quickDecisionNotes';

const QuickDecisionNoteRow: React.FC<{ note: QuickDecisionNote }> = ({ note }) => {
  const { t } = useTranslation();
  const basis = (
    <div className='space-y-2px text-12px leading-18px' data-testid='quick-decision-basis'>
      <div>
        {t('quickDecision.details.model')}: {note.model ?? '—'}
      </div>
      <div>
        {t('quickDecision.details.duration')}: {note.durationMs ?? 0}ms
      </div>
      {note.confidence !== undefined && (
        <div>
          {t('quickDecision.details.confidence')}: {note.confidence.toFixed(2)}
        </div>
      )}
      <div>{note.cached ? t('quickDecision.details.cached') : t('quickDecision.details.fresh')}</div>
      {note.reason && (
        <div>
          {t('quickDecision.details.reason')}: {note.reason}
        </div>
      )}
    </div>
  );
  const title =
    note.kind === 'reuse'
      ? t('quickDecision.reuse.title', { team: note.teamName ?? '' })
      : note.kind === 'reject'
        ? t('quickDecision.reject.title')
        : note.kind === 'route'
          ? t('quickDecision.route.title', { member: note.memberName ?? '' })
          : note.kind === 'thinking'
            ? t('quickDecision.thinking.title', {
                level: t(`quickDecision.thinking.level.${note.thinkingLevel ?? 'low'}`, {
                  defaultValue: note.thinkingLevel ?? 'low',
                }),
              })
            : t('quickDecision.hint.title');
  const body =
    note.kind === 'reuse'
      ? t('quickDecision.reuse.body', { reason: note.reason ?? '' })
      : note.kind === 'reject'
        ? t('quickDecision.reject.body', { suggest: note.suggestLabel ?? '', reason: note.reason ?? '' })
        : note.kind === 'route'
          ? t('quickDecision.route.body', { member: note.memberName ?? '', reason: note.reason ?? '' })
          : note.kind === 'thinking'
            ? t('quickDecision.thinking.body', { reason: note.reason ?? '' })
            : t('quickDecision.hint.body', {
                positions: (note.hintLabels ?? []).join('、') || '—',
                reason: note.reason ?? '',
              });
  return (
    <div className='flex flex-col gap-4px py-6px' data-testid='quick-decision-row' data-note-kind={note.kind}>
      <div className='flex items-center gap-6px'>
        <span className='inline-flex items-center gap-4px rd-full px-8px py-2px text-12px leading-18px font-500 bg-[rgba(var(--warning-6),0.12)] text-[rgb(var(--warning-6))] cursor-pointer quick-decision-note-trigger'>
          <Thunderbolt theme='outline' size='12' fill='currentColor' />
          <span data-testid='quick-decision-title'>{title}</span>
        </span>
      </div>
      <div className='text-12px leading-18px text-t-tertiary' data-testid='quick-decision-body'>
        {body}
      </div>
      <div className='flex'>
        <Popover content={basis} trigger='click' position='top'>
          <span
            className='text-12px leading-18px text-t-quaternary cursor-pointer hover:text-t-secondary'
            data-testid='quick-decision-basis-trigger'
          >
            {t('quickDecision.details.trigger')}
          </span>
        </Popover>
      </div>
      {note.input && (
        <div
          className='text-12px leading-18px text-t-quaternary border-l-2px border-solid border-border-2 pl-8px max-w-100% truncate'
          data-testid='quick-decision-task'
        >
          {t('quickDecision.taskLabel')}: {note.input}
        </div>
      )}
    </div>
  );
};

export default QuickDecisionNoteRow;
