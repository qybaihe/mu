import React, { useMemo } from 'react';
import { Button, Tooltip } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { Activity } from '@/common/kyrn/types';
import JudgePulse from '@/renderer/components/brand/JudgePulse';
import { gaugeReadings, wholePercent } from '@/renderer/pages/conversation/KyrnPanel/Board/gauges';
import { judgeCards } from '@/renderer/pages/conversation/KyrnPanel/Judge/activity';
import { useCurrentConversation } from '@/renderer/pages/conversation/explorer/currentConversationStore';
import { useNativeActivity } from '@/renderer/pages/native/utils/nativeActivityStore';
import { formatNumber } from '@/renderer/services/i18n/format';
import { useKernelSummary } from './useKernelSummary';
import styles from './KernelBar.module.css';

const NO_EVENTS: Activity[] = [];

/** What the judge has done in the conversation on screen. */
function judgeActivity(events: Activity[]) {
  const cards = judgeCards(events);
  const answered = cards.filter((card) => card.state !== 'pending' && card.state !== 'rule');
  const last = answered.findLast((card) => typeof card.latencyMs === 'number');
  return {
    verdicts: answered.length,
    judging: cards.some((card) => card.state === 'pending'),
    lastMs: last?.latencyMs,
  };
}

/**
 * The strip along the bottom of the window: which judge answers and how many decision points act on it, and for the
 * conversation on screen, how many verdicts it gave, how fast the last one came, and how full the context and the
 * cache are. Mono, quiet, always there: the kernel's heartbeat.
 */
const KernelBar: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const summary = useKernelSummary();
  const conversationId = useCurrentConversation();
  const activity = useNativeActivity(conversationId);
  const events = activity?.events ?? NO_EVENTS;
  const judge = useMemo(() => judgeActivity(events), [events]);
  const readings = useMemo(() => gaugeReadings(events), [events]);
  const percent = (value: number) =>
    formatNumber(wholePercent(value) / 100, i18n.language, { style: 'percent', maximumFractionDigits: 0 });

  if (!summary) return <footer className={styles.bar} data-testid='mu-kernel-bar' />;
  const off = summary.mode === 'off' || summary.active + summary.shadow === 0;
  const via = summary.via === 'local' ? t('common.kyrn.kernel.local') : summary.via;

  return (
    <footer className={styles.bar} data-testid='mu-kernel-bar'>
      <div className={styles.group}>
        <Tooltip content={t('common.kyrn.kernel.judgeHint')} position='tl' mini>
          <Button
            type='text'
            className={styles.judge}
            data-testid='mu-kernel-judge'
            onClick={() => void navigate('/settings/judges')}
          >
            <JudgePulse state={off ? 'off' : judge.judging ? 'judging' : 'idle'} />
            <span className={styles.name}>{summary.judge}</span>
            {via ? <span>{via}</span> : null}
            {summary.free ? <span className={styles.tag}>{t('common.kyrn.kernel.free')}</span> : null}
            {summary.fallbacks > 0 ? <span>+{summary.fallbacks}</span> : null}
          </Button>
        </Tooltip>
        <span className={styles.rule} aria-hidden='true' />
        <span className={styles.item} data-testid='mu-kernel-points'>
          {off
            ? t('common.kyrn.kernel.off')
            : t('common.kyrn.kernel.points', { active: summary.active, total: summary.total })}
          {!off && summary.shadow > 0 ? (
            <span className={styles.dim}>{t('common.kyrn.kernel.shadow', { count: summary.shadow })}</span>
          ) : null}
        </span>
      </div>
      {activity ? (
        <div className={styles.group} data-testid='mu-kernel-session'>
          <span className={styles.item}>
            <span className={styles.value}>{formatNumber(judge.verdicts, i18n.language)}</span>
            {t('common.kyrn.kernel.verdicts', { count: judge.verdicts })}
          </span>
          {judge.lastMs !== undefined ? (
            <span className={styles.item}>
              {t('common.kyrn.kernel.last')}
              <span className={styles.value}>{formatNumber(Math.round(judge.lastMs), i18n.language)} ms</span>
            </span>
          ) : null}
          <span className={styles.rule} aria-hidden='true' />
          <span className={styles.item}>
            {t('common.kyrn.kernel.context')}
            <span className={styles.meter} aria-hidden='true'>
              <span style={{ width: `${Math.min(100, readings.context ?? 0)}%` }} />
            </span>
            <span className={styles.value}>{readings.context === undefined ? '—' : percent(readings.context)}</span>
          </span>
          <span className={styles.item}>
            {t('common.kyrn.kernel.cache')}
            <span className={styles.value}>
              {readings.sessionCache === undefined ? '—' : percent(readings.sessionCache)}
            </span>
          </span>
        </div>
      ) : null}
    </footer>
  );
};

export default KernelBar;
