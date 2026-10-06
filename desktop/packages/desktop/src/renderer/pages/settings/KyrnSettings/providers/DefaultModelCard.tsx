import React from 'react';
import { Radio } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import AionSelect from '@/renderer/components/base/AionSelect';
import type { LoginStatus } from '@/common/kyrn/login';
import {
  THINKING_LEVELS,
  supportedThinkingLevels,
  type AvailableModels,
  type ModelDefaults,
  type ProviderModel,
  type ThinkingLevel,
} from '@/common/kyrn/models';
import type { KyrnSettings } from '@/common/kyrn/types';
import { thinkingLevelLabel } from '@/renderer/utils/model/thinkingLevel';
import Row from '../fields/Row';
import fieldStyles from '../fields/fields.module.css';
import { Card } from '../sections/SectionShell';
import { providerLabel } from './endpoints';
import { filterModelOption, modelNamesOf, modelOption } from './modelOptions';
import styles from './providers.module.css';

type DefaultModelCardProps = {
  settings: KyrnSettings;
  base: KyrnSettings;
  available: AvailableModels;
  /** Subscriptions signed in to from the app, which a running mu may not have reported yet. */
  accounts?: LoginStatus['signedIn'];
  /** Providers removed on this screen that the snapshot of mu's last connection still lists. */
  hidden?: ReadonlySet<string>;
  onChange: (defaults: ModelDefaults) => void;
};

const UNSET = 'unset';

/** Levels a custom model takes, from the thinking map the model editor writes. */
function modelThinkingLevels(model: ProviderModel): ThinkingLevel[] {
  return supportedThinkingLevels(model.reasoning, model.thinkingLevelMap);
}

/**
 * The model and thinking level a new session starts with (pi's settings.json, which the mu command line reads too).
 * A conversation can still switch in its send box.
 */
export default function DefaultModelCard({
  settings,
  base,
  available,
  accounts = [],
  hidden,
  onChange,
}: DefaultModelCardProps) {
  const { t } = useTranslation();
  const { defaults, providers } = settings.models;
  const listed = hidden?.size
    ? available.providers.filter((provider) => !hidden.has(provider.id))
    : available.providers;
  const custom = providers.find((provider) => provider.id === defaults.provider);
  const reported = listed.find((provider) => provider.id === defaults.provider);
  const account = accounts.find((entry) => entry.provider === defaults.provider);
  const providerIds = [
    ...new Set([
      ...providers.map((p) => p.id),
      ...listed.map((p) => p.id),
      ...accounts.map((entry) => entry.provider),
      defaults.provider,
    ]),
  ];
  const models = custom?.models ?? reported?.models ?? account?.models ?? [];
  const modelIds = [...new Set([...models.map((m) => m.id), defaults.model])].filter(Boolean);
  const names = modelNamesOf(models);

  // Only a custom model says what it can do; for a built-in one pi picks the nearest level it supports.
  const model = custom?.models.find((candidate) => candidate.id === defaults.model);
  const levels = model ? modelThinkingLevels(model) : [...THINKING_LEVELS];
  const noReasoning = Boolean(model) && !model?.reasoning;
  const help = noReasoning
    ? t('mu.defaults.noReasoning')
    : model
      ? t('mu.defaults.levelHelp')
      : t('mu.defaults.levelClamped');

  return (
    <Card testId='mu-defaults'>
      <Row title={t('mu.defaults.provider')} modified={defaults.provider !== base.models.defaults.provider}>
        <AionSelect
          size='small'
          showSearch
          allowClear
          className={fieldStyles.wide}
          aria-label={t('mu.defaults.provider')}
          placeholder={t('mu.defaults.notSet')}
          value={defaults.provider || undefined}
          options={providerIds
            .filter(Boolean)
            .map((id) => ({ value: id, label: providerLabel(t, settings.models, id) }))}
          onChange={(provider?: string) => onChange({ ...defaults, provider: provider ?? '', model: '' })}
        />
      </Row>
      <Row
        title={t('mu.defaults.model')}
        help={defaults.provider ? undefined : t('mu.defaults.pickProvider')}
        modified={defaults.model !== base.models.defaults.model}
      >
        <AionSelect
          size='small'
          showSearch
          allowCreate
          allowClear
          disabled={!defaults.provider}
          className={fieldStyles.wide}
          aria-label={t('mu.defaults.model')}
          placeholder={t('mu.defaults.notSet')}
          value={defaults.model || undefined}
          options={modelIds.map((id) => modelOption(id, names.get(id) ?? ''))}
          filterOption={filterModelOption}
          onChange={(value?: string) => onChange({ ...defaults, model: value ?? '' })}
        />
      </Row>
      <Row
        testId='mu-thinking-level'
        title={t('mu.defaults.level')}
        help={help}
        modified={defaults.thinkingLevel !== base.models.defaults.thinkingLevel}
      >
        <Radio.Group
          type='button'
          size='small'
          className={styles.levels}
          aria-label={t('mu.defaults.level')}
          disabled={noReasoning}
          value={noReasoning ? 'off' : defaults.thinkingLevel || UNSET}
          onChange={(level: ThinkingLevel | typeof UNSET) =>
            onChange({ ...defaults, thinkingLevel: level === UNSET ? '' : level })
          }
        >
          {/* A radio's own `disabled` wins over the group's, so each one says it. */}
          <Radio value={UNSET} disabled={noReasoning}>
            {t('mu.defaults.levelUnset')}
          </Radio>
          {THINKING_LEVELS.map((level) => (
            <Radio key={level} value={level} disabled={noReasoning || !levels.includes(level)}>
              {thinkingLevelLabel(t, level)}
            </Radio>
          ))}
        </Radio.Group>
      </Row>
    </Card>
  );
}
