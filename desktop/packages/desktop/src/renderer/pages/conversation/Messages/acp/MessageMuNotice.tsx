import { Attention, Info, PauseOne, Remind } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '@/renderer/services/i18n/format';
import { openExternalUrl } from '@/renderer/utils/platform';
import {
  checkpointOffWords,
  FREE_JEV_UNAVAILABLE_KEYS,
  MU_NOTICE_KEYS,
  MU_NOTICE_LINKS,
  TO_MODEL_KEYS,
  type MuNotice,
} from './muNotice';
import styles from './MessageJevLine.module.css';

/** The mark before a line: a warning says something went wrong, a stop mark ends a stopped reply, an answer is quiet. */
function Mark({ notice }: { notice: MuNotice }) {
  if (notice.code === 'stopped')
    return <PauseOne theme='outline' size='14' className='flex-none text-t-secondary' aria-hidden='true' />;
  if (notice.code === 'to_model')
    return <Remind theme='outline' size='14' className='flex-none text-t-secondary' aria-hidden='true' />;
  if (notice.code === 'free_jev' || (!notice.code && notice.level === 'info'))
    return <Info theme='outline' size='14' className='flex-none text-t-secondary' aria-hidden='true' />;
  return notice.level === 'error' ? (
    <Attention theme='outline' size='14' className='flex-none' style={{ color: 'var(--danger)' }} aria-hidden='true' />
  ) : (
    <Attention theme='outline' size='14' className='flex-none text-warning' aria-hidden='true' />
  );
}

/**
 * A notice of the mu bridge as one line in the reader's language, such as an answer to mu's question that did not reach
 * it. Quiet like Jev's lines, with a mark: it says what mu did in the person's place, or what the person has to do
 * (ending with the page to do it on). What mu notified itself (a command's answer, a warning) is shown as mu wrote it,
 * line breaks kept.
 */
export default function MessageMuNotice({ notice }: { notice: MuNotice }) {
  if (notice.code === 'to_model') return <ToModelLine notice={notice} />;
  return <NoticeLine notice={notice} />;
}

/**
 * What mu told the model, as one quiet line in the reader's language: the reminder to finish a turn, the errors an edit
 * left, a rule, a rewind. The words the model got are one click away, as mu wrote them; they are not mu's reply.
 */
function ToModelLine({ notice }: { notice: MuNotice }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const key = (notice.kind && TO_MODEL_KEYS[notice.kind]) || MU_NOTICE_KEYS.to_model;
  const sent = notice.sent || notice.title;
  return (
    <div className='flex flex-col min-w-0' data-testid='mu-notice' data-code='to_model' data-kind={notice.kind ?? ''}>
      <div className={styles.line} role='status'>
        <Mark notice={notice} />
        <span className='min-w-0 whitespace-normal'>{t(key)}</span>
        {sent && (
          <button
            type='button'
            className={styles.action}
            aria-expanded={open}
            data-testid='mu-notice-original'
            onClick={() => setOpen((value) => !value)}
          >
            {t(open ? 'mu.notices.toModel.hide' : 'mu.notices.toModel.show')}
          </button>
        )}
      </div>
      {open && sent && (
        <div
          className='ml-22px mb-4px text-12px leading-18px text-t-secondary whitespace-pre-line [overflow-wrap:anywhere]'
          data-testid='mu-notice-sent'
        >
          {sent}
        </div>
      )}
    </div>
  );
}

function NoticeLine({ notice }: { notice: MuNotice }) {
  const { t, i18n } = useTranslation();
  let text: string;
  if (notice.code === 'checkpoint_off') {
    const words = checkpointOffWords(notice);
    // The numbers a reason names (a limit, seconds) are written the reader's way.
    const values = Object.fromEntries(
      Object.entries(words?.values ?? {}).map(([name, value]) => [name, formatNumber(value, i18n?.language)])
    );
    text = words ? t(words.key, values) : notice.title || t(MU_NOTICE_KEYS.checkpoint_off);
  } else if (notice.code === 'free_jev_unavailable') {
    // A reason this build has no words for is said in mu's own.
    const key = notice.reason ? FREE_JEV_UNAVAILABLE_KEYS[notice.reason] : undefined;
    text = key ? t(key) : notice.title || t(MU_NOTICE_KEYS.free_jev_unavailable);
  } else text = notice.code ? t(MU_NOTICE_KEYS[notice.code]) : notice.title;
  const link = notice.code ? MU_NOTICE_LINKS[notice.code] : undefined;
  if (!text) return null;
  return (
    <div
      className={styles.line}
      role='status'
      data-testid='mu-notice'
      data-code={notice.code ?? ''}
      data-level={notice.level ?? ''}
    >
      <Mark notice={notice} />
      <span
        className={notice.code ? 'min-w-0 whitespace-normal' : 'min-w-0 whitespace-pre-line [overflow-wrap:anywhere]'}
      >
        {text}
        {link && (
          <>
            {' '}
            <a
              href={link}
              className='break-all text-primary'
              data-testid='mu-notice-link'
              onClick={(event) => {
                event.preventDefault();
                void openExternalUrl(link);
              }}
            >
              {link}
            </a>
          </>
        )}
      </span>
    </div>
  );
}
