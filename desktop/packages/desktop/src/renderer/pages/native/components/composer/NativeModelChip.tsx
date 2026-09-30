/**
 * The model a native conversation answers with and how hard it thinks, in one chip at the right of the send box
 * (`model · level`), with the look and the menu of the chip in mu's other conversations (Composer/ComposerModelChip):
 * every model pi offers by provider, and a model that takes more than one level opens to its levels, so one pick sets
 * both. Opening it asks pi what it offers (which starts mu when it is not running); showing it starts nothing. A
 * switch waits for the run to end, as elsewhere.
 */
import { Dropdown, Menu, Tooltip } from '@arco-design/web-react';
import { Brain, Down } from '@icon-park/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import RuntimeSelectorPill from '@/renderer/components/agent/RuntimeSelectorPill';
import { composeRuntimeSelectorLabel } from '@/renderer/components/agent/runtimeSelectorOptions';
import { useProviderNames } from '@/renderer/hooks/agent/useProviderNames';
import { modelLevelMenu } from '@/renderer/pages/conversation/platforms/acp/Composer/ModelLevelMenu';
import { filterModelMenu, modelMenu } from '@/renderer/pages/conversation/platforms/acp/Composer/modelMenu';
import { iconColors } from '@/renderer/styles/colors';
import { providerDisplayName } from '@/renderer/utils/model/providerName';
import type { NativeModels } from '../../hooks/useNativeModels';

const NativeModelChip: React.FC<{
  models: NativeModels;
  /** A run goes, or a message is on its way: the switch waits. */
  busy: boolean;
}> = ({ models, busy }) => {
  const { t } = useTranslation();
  const names = useProviderNames();
  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState('');
  const { model, level, source, offer, loading, switching, load, pick } = models;
  // Each time the menu opens, pi is asked again: a provider set up meanwhile shows.
  useEffect(() => {
    if (visible) void load();
  }, [load, visible]);

  const groups = useMemo(
    () =>
      offer
        ? filterModelMenu(
            modelMenu(
              { currentValue: model, options: offer.options },
              offer.currentLevels ? { options: offer.currentLevels.map((value) => ({ value })) } : null,
              offer.levels,
              (id) => providerDisplayName(t, id, names)
            ),
            query
          )
        : [],
    [model, names, offer, query, t]
  );

  // mu runs without a model: the chip says so and opens the list to pick one.
  const noModel = source === 'host' && !model;
  const modelLabel = model
    ? offer?.options.find((option) => option.value === model)?.label || model.slice(model.indexOf('/') + 1)
    : t('common.defaultModel');
  const label = noModel
    ? t('mu.noModel.chip')
    : composeRuntimeSelectorLabel({
        t,
        modelLabel,
        thoughtLevel: level ? { currentValue: level, options: [] } : null,
      });
  const disabled = busy || switching;

  const close = () => {
    setVisible(false);
    setQuery('');
  };

  const droplist =
    !offer && loading ? (
      <Menu>
        <div className='px-12px py-10px text-12px text-t-tertiary text-center' data-testid='native-model-loading'>
          {t('common.loading')}
        </div>
      </Menu>
    ) : (
      modelLevelMenu(t, {
        groups,
        total: offer?.options.length ?? 0,
        query,
        onQuery: setQuery,
        current: model,
        level,
        onPick: (value, picked) => {
          close();
          void pick(value, picked);
        },
      })
    );

  const pill = (
    <span
      data-testid='native-model-chip'
      data-model={model ?? ''}
      data-level={level ?? ''}
      data-source={source}
      className='inline-flex min-w-0'
    >
      <RuntimeSelectorPill
        testId='native-model-pill'
        className='sendbox-model-btn agent-mode-compact-pill'
        label={label}
        leading={<Brain theme='outline' size='14' fill={iconColors.secondary} className='shrink-0' />}
        trailing={<Down size={12} className='text-t-tertiary shrink-0' />}
        loading={switching}
        disabled={disabled}
        onClick={() => setVisible((open) => !open)}
      />
    </span>
  );

  if (disabled)
    // A disabled button fires no hover; the reason sits on the wrapper.
    return busy ? (
      <Tooltip content={t('conversation.composer.modelBusy')} position='top'>
        {pill}
      </Tooltip>
    ) : (
      pill
    );

  return (
    <Dropdown
      trigger='click'
      position='tr'
      popupVisible={visible}
      onVisibleChange={(open) => {
        setVisible(open);
        if (!open) setQuery('');
      }}
      droplist={droplist}
    >
      {pill}
    </Dropdown>
  );
};

export default NativeModelChip;
