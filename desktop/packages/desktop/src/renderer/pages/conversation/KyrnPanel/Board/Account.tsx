import React, { useState } from 'react';
import { Button } from '@arco-design/web-react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import { useLogClock } from '../clock';
import type { BoardNote } from './board';
import styles from './Board.module.css';

/** How many of the newest lines show before the older ones are asked for. */
const SHOWN = 30;

/**
 * The helper a line is about, as a chip in front of it: none for the main agent, nor where the line's own sentence
 * already starts from that name ("scout is back: …").
 */
const chipOf = (note: BoardNote): string | undefined =>
  note.who && note.params?.name !== note.who && note.params?.who !== note.who ? note.who : undefined;

/**
 * What the agent did, newest first: one line each, at the time it happened. The board model's own words stand out
 * from the harness's fixed sentences, and a line where something went wrong has a hollow dot, never a colour. A line
 * about a helper says which one. A new line fades in; one the harness sends again changes where it stands.
 */
export default function Account({
  notes,
  isFresh,
  words,
}: {
  /** Oldest first, as the account keeps them. */
  notes: readonly BoardNote[];
  /** Whether a line came after the panel opened: it fades in. */
  isFresh: (note: BoardNote) => boolean;
  /** A fixed line in the app's language, or undefined to keep its own text. */
  words: (note: BoardNote) => string | undefined;
}) {
  const { t } = useTranslation();
  const clock = useLogClock();
  const [all, setAll] = useState(false);
  const newest = notes.toReversed();
  const shown = all ? newest : newest.slice(0, SHOWN);
  const hidden = newest.length - shown.length;
  return (
    <section className={styles.account} data-testid='mu-board-account' aria-label={t('common.kyrn.boardView.account')}>
      <h4 className={styles.sectionTitle}>{t('common.kyrn.boardView.account')}</h4>
      <ul className={styles.notes}>
        {shown.map((note) => {
          const worded = words(note);
          const fresh = isFresh(note);
          const chip = chipOf(note);
          return (
            <li
              key={note.id}
              className={classNames(styles.note, note.by === 'model' && styles.noteSaid, fresh && styles.fresh)}
              data-testid='mu-board-note'
              data-by={note.by}
              data-fresh={fresh ? 'true' : undefined}
              data-failed={note.failed ? 'true' : undefined}
            >
              <time className={styles.noteTime} dateTime={new Date(note.at).toISOString()}>
                {clock(note.at)}
              </time>
              {/* The harness's and the model's own sentences may be in another script than the app's. */}
              <span className={styles.noteText} dir={worded === undefined ? 'auto' : undefined}>
                {note.failed ? <span className={styles.noteDot} aria-hidden='true' /> : null}
                {chip ? (
                  <span className={styles.who} data-testid='mu-board-note-who' dir='auto'>
                    {chip}
                  </span>
                ) : null}
                {worded ?? note.text}
              </span>
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? (
        <Button type='text' className={styles.more} data-testid='mu-board-more' onClick={() => setAll(true)}>
          {t('common.kyrn.boardView.earlierNotes', { count: hidden })}
        </Button>
      ) : null}
    </section>
  );
}
