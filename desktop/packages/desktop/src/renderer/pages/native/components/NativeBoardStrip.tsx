/**
 * The plain-language board's headline in the conversation's header, while the work panel is closed (it is closed by
 * default, and the board lives in it): one line that says where the work is, so the board is seen when it matters.
 * It shows only when the board is on and its latest board has a headline (board v2); the panel open, the board tab says
 * it all. A click opens the work panel on the board. The line keeps to one row and ends in an ellipsis, so it never
 * moves the page under it; its whole text (and what is blocked) is in its tooltip.
 */
import { Button } from '@arco-design/web-react';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { rememberWorkPanel, useWorkPanelMemory } from '@/renderer/components/layout/WorkPanel/workPanelStore';
import { asksUser, boardView } from '@/renderer/pages/conversation/KyrnPanel/Board/board';
import { boardWords } from '@/renderer/pages/conversation/KyrnPanel/Board/wording';
import { formatNumber } from '@/renderer/services/i18n/format';
import { useNativeActivity } from '../utils/nativeActivityStore';

const NativeBoardStrip: React.FC<{ conversationId: string }> = ({ conversationId }) => {
  const { t, i18n } = useTranslation();
  const activity = useNativeActivity(conversationId);
  const { open } = useWorkPanelMemory(conversationId);
  const events = activity?.events;
  const update = useMemo(() => {
    const view = boardView(events ?? []);
    return view.on ? view.update : undefined;
  }, [events]);
  const words = useMemo(
    () =>
      update
        ? boardWords(
            update,
            t,
            (key) => i18n.exists(key),
            (value) => formatNumber(value, i18n.language)
          )
        : undefined,
    [i18n, t, update]
  );
  if (open || !update || !words?.headline) return null;

  const { headline, blocked } = words;
  // Blocked: a hollow mark in the warning colour; waiting for the person: a hollow one; otherwise a plain dot.
  const mark = blocked ? 'blocked' : asksUser(update) ? 'asks' : 'dot';
  const blockedLine = blocked ? t('common.kyrn.boardView.blockedLine', { text: blocked }) : '';
  const label = t('common.kyrn.boardView.stripOpen', { headline });
  return (
    // Up to half the row, never squeezed by a long title (the sidebar shows the title too); a longer headline ends in
    // an ellipsis.
    <div className='shrink-0 min-w-0 max-w-[50%] ms-auto flex justify-end'>
      <Button
        type='text'
        size='small'
        className='!flex min-w-0 max-w-full items-center gap-8px !h-26px !px-10px !rd-full !bg-fill hover:!bg-hover !text-t-primary'
        data-testid='mu-board-strip'
        data-mark={mark}
        title={[headline, blockedLine, t('common.kyrn.boardView.stripHint')].filter(Boolean).join('\n')}
        aria-label={label}
        onClick={() => rememberWorkPanel(conversationId, { open: true, tab: 'board' })}
      >
        <span
          aria-hidden='true'
          className={
            mark === 'blocked'
              ? 'shrink-0 size-7px rd-full shadow-[inset_0_0_0_1.5px_var(--warning)]'
              : mark === 'asks'
                ? 'shrink-0 size-7px rd-full shadow-[inset_0_0_0_1.5px_var(--text-primary)]'
                : 'shrink-0 size-6px rd-full bg-t-secondary'
          }
        />
        <span className='min-w-0 truncate text-12px leading-18px font-500' data-testid='mu-board-strip-text' dir='auto'>
          {headline}
        </span>
      </Button>
    </div>
  );
};

export default NativeBoardStrip;
