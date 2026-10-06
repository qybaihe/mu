import React from 'react';
import { useTranslation } from 'react-i18next';
import { closeFirstHint, useFirstHint, type FirstHintId } from './firstHints';
import styles from './FirstHint.module.css';

/** A one-sentence hint the first time something appears, with 知道了 to close it for good (see `useFirstHint`). */
export default function FirstHint({ id, wants, text }: { id: FirstHintId; wants: boolean; text: string }) {
  const { t } = useTranslation();
  if (!useFirstHint(id, wants)) return null;
  return (
    <div className={styles.hint} role='note' data-testid={`mu-first-hint-${id}`}>
      <span className={styles.text}>{text}</span>
      <button
        type='button'
        className={styles.close}
        data-testid={`mu-first-hint-${id}-close`}
        onClick={() => closeFirstHint(id)}
      >
        {t('common.firstHint.close')}
      </button>
    </div>
  );
}
