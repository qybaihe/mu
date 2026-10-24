import React from 'react';
import { Collapse, Progress, Tag, Tooltip } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { Activity } from '@/common/kyrn/types';
import { formatNumber } from '@/renderer/services/i18n/format';
import { compactionEffect, contextView } from './context';
import { str } from '../activity';
import { useClock } from '../clock';

/** The three counts a beta compaction reports, in the order the line lists them. */
const COMPACTION_COUNTS = [
  ['kept', 'common.kyrn.compactionKept'],
  ['pruned', 'common.kyrn.compactionPruned'],
  ['dropped', 'common.kyrn.compactionDropped'],
] as const;

export default function ContextPanel({ events }: { events: Activity[] }) {
  const { t, i18n } = useTranslation();
  const clock = useClock();
  const view = contextView(events);
  // Numbers follow the app language, not the operating system (`toLocaleString()` would).
  const number = (n: number | undefined) => (n === undefined ? '—' : formatNumber(n, i18n.language));
  /** `value` is a percentage from 0 to 100. */
  const percent = (value: number | undefined) =>
    value === undefined
      ? '—'
      : formatNumber(value / 100, i18n.language, { style: 'percent', maximumFractionDigits: 1 });
  return (
    <div className='px-12px pb-8px text-13px shrink-0' data-testid='kyrn-context'>
      <div className='flex items-center gap-12px'>
        <div className='flex-1 min-w-0'>
          <div className='font-500 mb-4px'>{t('common.kyrn.contextUsage')}</div>
          <div>
            {number(view.tokens)} / {number(view.window)}
          </div>
          {view.percent !== undefined && (
            <Progress
              percent={view.percent}
              size='small'
              color='var(--text-primary)'
              formatText={(value) => percent(value)}
            />
          )}
          {view.tokens === undefined && (
            <div className='text-t-tertiary text-12px'>{t('common.kyrn.contextPending')}</div>
          )}
        </div>
        <Tooltip
          content={
            view.cache.percent === undefined
              ? t('common.kyrn.cachePending')
              : t('common.kyrn.cacheDetail', { read: number(view.cache.read), total: number(view.cache.total) })
          }
        >
          <div
            className='flex flex-col items-center gap-4px shrink-0'
            role='img'
            aria-label={t('common.kyrn.cacheLabel', { percent: percent(view.cache.percent) })}
          >
            <Progress
              type='circle'
              width={46}
              strokeWidth={4}
              color='var(--text-primary)'
              percent={view.cache.percent ?? 0}
              formatText={() => <span className='text-11px'>{percent(view.cache.percent)}</span>}
            />
            <span className='text-12px text-t-secondary'>{t('common.kyrn.cacheHit')}</span>
          </div>
        </Tooltip>
      </div>
      <div className='flex flex-wrap items-center gap-6px mt-6px'>
        <Tag>
          {t(
            view.beta && view.mode === 'active'
              ? 'common.kyrn.betaActive'
              : view.beta && view.mode === 'shadow'
                ? 'common.kyrn.betaShadow'
                : view.mode === undefined
                  ? 'common.kyrn.contextWaiting'
                  : 'common.kyrn.betaOff'
          )}
        </Tag>
        <span className='text-t-secondary'>
          {view.auto === undefined
            ? t('common.kyrn.contextWaiting')
            : view.auto
              ? t('common.kyrn.contextTrigger', { tokens: number(view.limit) })
              : t('common.kyrn.autoOff')}
        </span>
      </div>
      {view.compacting && <p className='mt-8px mb-0 text-12px text-t-primary'>{t('common.kyrn.compacting')}</p>}
      <Collapse bordered={false} className='mt-4px'>
        <Collapse.Item name='compaction' header={t('common.kyrn.compactionResults', { count: view.history.length })}>
          <div className='max-h-240px overflow-y-auto'>
            {!view.history.length && <span className='text-t-secondary'>{t('common.kyrn.noCompaction')}</span>}
            {view.history.map((event) => {
              const effect = compactionEffect(event);
              return (
                <div key={event.id} className='mb-12px'>
                  <div className='flex justify-between gap-8px'>
                    <span>
                      {t(
                        effect.applied
                          ? event.payload.beta
                            ? 'common.kyrn.betaApplied'
                            : 'common.kyrn.summaryApplied'
                          : event.payload.aborted
                            ? 'common.kyrn.compactionAborted'
                            : 'common.kyrn.compactionFailed'
                      )}
                    </span>
                    <span className='text-t-tertiary'>{clock(event.at)}</span>
                  </div>
                  {effect.applied && (
                    <>
                      <div>
                        {t('common.kyrn.compactionTokens', {
                          before: number(effect.before),
                          after: number(effect.after),
                        })}
                      </div>
                      {effect.savedPercent !== undefined && (
                        <div>{t('common.kyrn.compactionSavings', { saved: percent(effect.savedPercent) })}</div>
                      )}
                      {event.payload.beta === true && (
                        <div className='text-t-secondary'>
                          {COMPACTION_COUNTS.flatMap(([metric, key]) => {
                            const count = effect.metrics[metric];
                            return typeof count === 'number' && Number.isFinite(count) ? [t(key, { count })] : [];
                          }).join(' · ') || '—'}
                        </div>
                      )}
                    </>
                  )}
                  {/* The headline above says what happened; the harness's own message is the detail. */}
                  {event.payload.error ? (
                    <div className='text-12px text-t-secondary whitespace-pre-wrap break-words' dir='auto'>
                      {str(event.payload.error)}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Collapse.Item>
      </Collapse>
    </div>
  );
}
