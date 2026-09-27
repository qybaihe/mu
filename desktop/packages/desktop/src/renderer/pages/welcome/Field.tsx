import React from 'react';
import choiceStyles from '@/renderer/pages/settings/KyrnSettings/sections/sections.module.css';
import styles from './Welcome.module.css';

type FieldProps = { label: string; problem?: string; children: React.ReactNode };

/** One field of a way in: its label, the control, and what is wrong with it once Next was pressed. */
export default function Field({ label, problem, children }: FieldProps) {
  return (
    <div className={styles.field}>
      <label className={choiceStyles.choiceLabel}>{label}</label>
      {children}
      {problem ? (
        <div className={styles.problem} role='alert'>
          {problem}
        </div>
      ) : null}
    </div>
  );
}
