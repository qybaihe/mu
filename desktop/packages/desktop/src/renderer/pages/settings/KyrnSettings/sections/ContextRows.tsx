import React from 'react';
import { InputNumber, Switch } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { KyrnSettings } from '@/common/kyrn/types';
import { formatNumber } from '@/renderer/services/i18n/format';
import Row from '../fields/Row';
import fieldStyles from '../fields/fields.module.css';
import { Card } from './SectionShell';

/** The context cap the store accepts besides 0, in tokens. */
const LIMIT_MIN = 8192;
const LIMIT_MAX = 10000000;

type ContextRowsProps = {
  settings: KyrnSettings;
  base: KyrnSettings;
  onChange: (change: (settings: KyrnSettings) => KyrnSettings) => void;
};

/**
 * Automatic compaction and the context cap, shared with pi's settings.json: the top of the context page of the details,
 * above the features that act on the context. The summary-free compaction is one of those features, with its options.
 */
export default function ContextRows({ settings, base, onChange }: ContextRowsProps) {
  const { t, i18n } = useTranslation();
  const threshold = settings.maxContextTokens;
  const invalid = threshold !== 0 && (threshold < LIMIT_MIN || threshold > LIMIT_MAX);
  const bounds = { min: formatNumber(LIMIT_MIN, i18n.language), max: formatNumber(LIMIT_MAX, i18n.language) };
  return (
    <Card testId='mu-context-rows'>
      <Row
        title={t('mu.context.auto')}
        help={t('mu.context.autoHelp')}
        modified={settings.autoCompaction !== base.autoCompaction}
      >
        <Switch
          size='small'
          aria-label={t('mu.context.auto')}
          checked={settings.autoCompaction}
          onChange={(autoCompaction) => onChange((now) => ({ ...now, autoCompaction }))}
        />
      </Row>
      <Row
        title={t('mu.context.limit')}
        help={t('mu.context.limitHelp', bounds)}
        modified={threshold !== base.maxContextTokens}
        problem={invalid ? t('mu.context.limitProblem', bounds) : undefined}
      >
        <InputNumber
          size='small'
          className={fieldStyles.number}
          aria-label={t('mu.context.limit')}
          value={threshold}
          min={0}
          max={LIMIT_MAX}
          precision={0}
          step={LIMIT_MIN}
          suffix={t('mu.units.tokens')}
          onChange={(value) => onChange((now) => ({ ...now, maxContextTokens: typeof value === 'number' ? value : 0 }))}
        />
      </Row>
    </Card>
  );
}
