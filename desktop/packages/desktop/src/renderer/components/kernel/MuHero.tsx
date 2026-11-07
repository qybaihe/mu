import React from 'react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import JudgePulse from '@/renderer/components/brand/JudgePulse';
import { useKernelSummary } from './useKernelSummary';
import styles from './MuHero.module.css';

export type MuHeroProps = {
  /** The page is on its way to a conversation: the hero fades out. */
  leaving?: boolean;
  className?: string;
};

/**
 * The top of the home page: one mono line on whether the judge is ready, and the question. How many decision points
 * act is in the kernel bar below, so it is not said twice.
 */
const MuHero: React.FC<MuHeroProps> = ({ leaving = false, className }) => {
  const { t } = useTranslation();
  const summary = useKernelSummary();
  const off = summary ? summary.mode === 'off' || summary.active + summary.shadow === 0 : false;
  return (
    <header
      className={classNames(styles.hero, leaving && styles.leaving, className)}
      data-testid='mu-hero'
      data-state={leaving ? 'leaving' : 'shown'}
    >
      <div className={styles.eyebrow}>
        <JudgePulse state={off ? 'off' : 'idle'} />
        <span className={styles.judge}>
          {summary
            ? off
              ? t('common.kyrn.hero.judgeOff')
              : t('common.kyrn.hero.judgeReady', { judge: summary.judge })
            : t('common.kyrn.hero.kernel')}
        </span>
      </div>
      <h1 className={styles.title}>{t('common.kyrn.hero.title')}</h1>
    </header>
  );
};

export default MuHero;
