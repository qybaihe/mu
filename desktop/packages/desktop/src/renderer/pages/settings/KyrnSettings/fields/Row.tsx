import React from 'react';
import { useTranslation } from 'react-i18next';
import OneLine from '@/renderer/components/settings/OneLine';
import styles from './fields.module.css';

/** Small marker for anything that differs from the default. */
export function ModifiedMark({ show }: { show: boolean }) {
  const { t } = useTranslation();
  if (!show) return null;
  return (
    <span className={styles.modified} data-testid='mu-modified'>
      {t('mu.modified')}
    </span>
  );
}

type RowProps = {
  title: React.ReactNode;
  /** One sentence on the setting, on one line; the rest opens from it. */
  help?: string;
  /** Shows the marker next to the title. */
  modified?: boolean;
  /** Extra badges after the title. */
  badges?: React.ReactNode;
  /** A message under the row: why the value cannot be saved. */
  problem?: string;
  children?: React.ReactNode;
  testId?: string;
};

/** One setting: what it is on the left, its control on the right; stacked when the section is narrow. */
export default function Row({ title, help, modified = false, badges, problem, children, testId }: RowProps) {
  return (
    <div className={styles.row} data-testid={testId}>
      <div className={styles.rowText}>
        <div className={styles.rowTitle}>
          <span>{title}</span>
          {badges}
          <ModifiedMark show={modified} />
        </div>
        {help ? <OneLine text={help} /> : null}
      </div>
      <div className={styles.rowControl}>{children}</div>
      {problem ? (
        <div className={styles.problem} role='alert'>
          {problem}
        </div>
      ) : null}
    </div>
  );
}
