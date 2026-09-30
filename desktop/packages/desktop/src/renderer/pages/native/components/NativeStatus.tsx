/**
 * The line above the send box while something happens: mu starting, Jev reading the message, the model thinking or
 * working (what the judgment layer works out, in the reader's language), a request tried again, a compaction. With the
 * time it has taken since the message that started it. No line when nothing happens: how a run ended is in the
 * transcript. The element itself is always there and carries the view's status (`data-status`), and whether a message
 * is on its way to pi (`data-sending`): the message shows at once, but the run it starts has not begun yet.
 */
import type { TFunction } from 'i18next';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeHostStatus } from '@/common/kyrn/nativeBridge';
import type { NativeView } from '@/common/utils/nativeHost';
import ThoughtDisplay from '@/renderer/components/chat/ThoughtDisplay';
import { eventLines } from '@/renderer/pages/conversation/KyrnPanel/Judge/eventLine';
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

const NativeStatus: React.FC<{ view: NativeView; host: NativeHostStatus; sendingSince?: number }> = ({
  view,
  host,
  sendingSince,
}) => {
  const { t } = useTranslation();
  const words = statusWords(t, view, host, sendingSince !== undefined);
  const busy = view.status === 'working' || view.status === 'thinking' || sendingSince !== undefined;
  // Always there, so what reads the screen can wait for a run's end (`data-status`); a line only while it says something.
  return (
    <div
      data-testid='native-status'
      data-status={view.status}
      data-sending={String(sendingSince !== undefined)}
      className='contents'
    >
      {words ? (
        <ThoughtDisplay
          running
          statusText={words}
          externalElapsedSource
          startedAtMs={busy ? startedAt(view, sendingSince) : undefined}
        />
      ) : null}
    </div>
  );
};

export default NativeStatus;
