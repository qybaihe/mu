/**
 * The line above the send box while something happens: mu starting, the judge reading the message, the model thinking
 * or working (what the judgment layer works out, in the reader's language), a request tried again, a compaction. With
 * the time it has taken since the message that started it. No line when nothing happens: how a run ended is in the
 * transcript. The element itself is always there and carries the view's status (`data-status`), and whether a message
 * is on its way to pi (`data-sending`): the message shows at once, but the run it starts has not begun yet.
 *
 * The line is a breathing dot, the words and the time in figures that keep their width: the judge's pink dot while it
 * reads the message, mu's violet otherwise. No spinner and no tag.
 */
import type { TFunction } from 'i18next';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeHostStatus } from '@/common/kyrn/nativeBridge';
import type { NativeView } from '@/common/utils/nativeHost';
import { eventLines } from '@/renderer/pages/conversation/KyrnPanel/Judge/eventLine';
import { formatDuration } from '@/renderer/services/i18n/format';
import { statusRow } from '../utils/statusRow';

/** What the line says, or undefined for no line. */
export function statusWords(
  t: TFunction,
  view: NativeView,
  host: NativeHostStatus,
  sending: boolean
): string | undefined {
  if (host.phase === 'starting') return t('mu.native.status.starting');
  const row = statusRow(view);
  switch (row.kind) {
    case 'classifying':
      return t('mu.native.status.classifying');
    case 'compacting':
      return t('mu.native.status.compacting');
    case 'retrying':
      return t('mu.native.status.retrying', { attempt: row.attempt, max: row.maxAttempts });
    case 'thinking':
      return t('mu.native.status.thinking');
    case 'working': {
      const step = row.step
        ? eventLines(t, 'progress', {
            step: row.step,
            ...(row.code ? { code: row.code } : {}),
            ...(row.params ? { params: row.params } : {}),
          })?.[0]
        : undefined;
      return step || t('mu.native.status.working');
    }
    default:
      return sending ? t('mu.native.status.sending') : undefined;
  }
}

/** When the message that started what happens now was sent. */
function startedAt(view: NativeView, sending?: number): number | undefined {
  if (sending !== undefined) return sending;
  for (let index = view.messages.length - 1; index >= 0; index--) {
    const message = view.messages[index];
    if (message.role === 'user') return message.timestamp;
  }
  return undefined;
}

/** Whole seconds since `since`, counted once a second; undefined without a usable start. */
function useSecondsSince(since: number | undefined): number | undefined {
  const usable = since !== undefined && Number.isFinite(since) && since > 0 ? since : undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (usable === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [usable]);
  return usable === undefined ? undefined : Math.max(0, Math.floor((now - usable) / 1000));
}

const NativeStatus: React.FC<{ view: NativeView; host: NativeHostStatus; sendingSince?: number }> = ({
  view,
  host,
  sendingSince,
}) => {
  const { t, i18n } = useTranslation();
  const words = statusWords(t, view, host, sendingSince !== undefined);
  const busy = view.status === 'working' || view.status === 'thinking' || sendingSince !== undefined;
  const seconds = useSecondsSince(busy ? startedAt(view, sendingSince) : undefined);
  const judging = host.phase !== 'starting' && statusRow(view).kind === 'classifying';
  // Always there, so what reads the screen can wait for a run's end (`data-status`); a line only while it says something.
  return (
    <div
      data-testid='native-status'
      data-status={view.status}
      data-sending={String(sendingSince !== undefined)}
      className='contents'
    >
      {words ? (
        <div
          className='relative z-1 mb--20px pb-30px px-12px py-10px rd-t-20px flex items-center gap-8px text-13px lh-20px'
          style={{ background: 'var(--thought-gradient)' }}
        >
          <span
            className='size-6px shrink-0 rd-full animate-pulse motion-reduce:animate-none'
            style={{ background: judging ? 'var(--mu-judge-dot, var(--primary))' : 'var(--primary)' }}
            data-testid='native-status-dot'
            data-judge={String(judging)}
            aria-hidden='true'
          />
          <span className='min-w-0 flex-1 truncate text-t-secondary' title={words}>
            {words}
          </span>
          {seconds !== undefined && (
            <span
              className='shrink-0 font-mono text-12px tabular-nums text-t-tertiary'
              data-testid='native-status-time'
            >
              {formatDuration(seconds * 1000, i18n.language, 'narrow')}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
};

export default NativeStatus;
