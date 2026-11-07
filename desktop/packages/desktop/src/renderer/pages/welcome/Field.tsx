import React from 'react';
import choiceStyles from '@/renderer/pages/settings/KyrnSettings/sections/sections.module.css';
import styles from './Welcome.module.css';

type FieldProps = { label: string; problem?: string; warning?: string; children: React.ReactNode };

/**
 * One field of a way in: its label, the control, and what is wrong with it once Next was pressed. A warning is not a
 * problem: it says what to know about a value that is allowed, and never stops Next.
 */
export default function Field({ label, problem, warning, children }: FieldProps) {
  return (
    <div className={styles.field}>
      <label className={choiceStyles.choiceLabel}>{label}</label>
      {children}
      {problem ? (
        <div className={styles.problem} role='alert'>
          {problem}
        </div>
      ) : warning ? (
        <div className={styles.warning} data-testid='mu-field-warning'>
          {warning}
        </div>
      ) : null}
    </div>
  );
}
