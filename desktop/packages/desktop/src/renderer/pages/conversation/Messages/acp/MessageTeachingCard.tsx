import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lightning } from '@icon-park/react';
import { type TeachingCard } from './teachingCard';
import styles from './MessageTeachingCard.module.css';

/**
 * The teaching card of a turn (`turn.teaching`), folded to one quiet row by default: why the answer went the way it
 * went, one click from the reason and the options that were ruled out. It is for the person who watched the turn
 * happen, in the writer's own words — never part of the model's reply, and never a tool call box.
 */
export default function MessageTeachingCard({ card }: { card: TeachingCard }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div data-testid='mu-teaching-card' data-kind={card.kind} data-open={open}>
      <button
        type='button'
        className={styles.row}
        data-testid='mu-teaching-fold'
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <Lightning theme='outline' size='13' className='flex-none' aria-hidden='true' />
        <span className={styles.summary}>
          {t(`mu.teaching.folded.${card.kind}`)}
          {open ? null : <span className={styles.openWord}>{t('mu.teaching.open')}</span>}
        </span>
      </button>
      {open ? (
        <div className={styles.detail} data-testid='mu-teaching-why'>
          <p className={styles.why}>{card.why}</p>
          {card.ruledOut.length > 0 ? (
            <p className={styles.ruledOut}>
              {t('mu.teaching.ruledOut')}
              {card.ruledOut.map((item, index) => (
                <span key={item} className={styles.option}>
                  {item}
                  {index < card.ruledOut.length - 1 ? ' ·' : null}
                </span>
              ))}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
