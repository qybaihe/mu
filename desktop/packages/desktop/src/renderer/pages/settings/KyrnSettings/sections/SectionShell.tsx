import React from 'react';
import classNames from 'classnames';
import SettingsPageHeader from '../../components/SettingsPageHeader';
import styles from './sections.module.css';

type SectionShellProps = {
  id: string;
  title: string;
  description?: React.ReactNode;
  /** Right of the title: a search box, an add button, a switch. */
  actions?: React.ReactNode;
  /** Above the title: the way back from a page that is opened from another one. */
  back?: React.ReactNode;
  children: React.ReactNode;
};

/**
 * One page of mu's settings: the page title, as on every settings page, then the content. The section is a size
 * container: see sections.module.css.
 */
export default function SectionShell({ id, title, description, actions, back, children }: SectionShellProps) {
  return (
    <section className={styles.section} data-testid={`mu-section-${id}`} aria-label={title}>
      {back}
      <SettingsPageHeader sticky={false} title={title} description={description} actions={actions} />
      {children}
    </section>
  );
}

type CardProps = {
  title?: React.ReactNode;
  badges?: React.ReactNode;
  /** Right end of the card head: a switch, a reset button. */
  extra?: React.ReactNode;
  summary?: React.ReactNode;
  dim?: boolean;
  testId?: string;
  children?: React.ReactNode;
};

/** A group of rows: an optional small title, a line under it, then the rows between hairlines. No box around them. */
export function Card({ title, badges, extra, summary, dim, testId, children }: CardProps) {
  const hasBody = React.Children.toArray(children).length > 0;
  return (
    <div className={styles.card} data-testid={testId}>
      {title ? (
        <div className={styles.cardHead}>
          <span className={styles.cardTitle}>{title}</span>
          {badges}
          <span className={styles.cardSpacer} />
          {extra}
        </div>
      ) : null}
      {summary ? <div className={styles.cardSummary}>{summary}</div> : null}
      {hasBody ? <div className={classNames(styles.cardBody, dim && styles.dim)}>{children}</div> : null}
    </div>
  );
}
