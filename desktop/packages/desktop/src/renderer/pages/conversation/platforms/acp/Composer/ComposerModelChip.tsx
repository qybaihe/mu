/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import RuntimeSelectorPill from '@/renderer/components/agent/RuntimeSelectorPill';
import { composeRuntimeSelectorLabel } from '@/renderer/components/agent/runtimeSelectorOptions';
import { useAcpConfigOptions, type AcpConfigOptionsPort } from '@/renderer/hooks/agent/useAcpConfigOptions';
import { useProviderNames } from '@/renderer/hooks/agent/useProviderNames';
import { iconColors } from '@/renderer/styles/colors';
import { providerDisplayName } from '@/renderer/utils/model/providerName';
import { Dropdown, Message, Tooltip } from '@arco-design/web-react';
import { Brain, Down } from '@icon-park/react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { modelLevelMenu } from './ModelLevelMenu';
import { applyModelPick, configErrorMessageKey, levelsOf, modelMenu, visibleModelMenu } from './modelMenu';
import { useModelLevels } from './useModelLevels';

/**
 * The model this conversation runs on and how hard it thinks, in one chip: `model · level`.
 *
 * Opening it lists the models the session offers (the short list until the person asks for all) and, under them, the
 * levels of the model in use; a pick switches through the session's own options. The chip only ever shows what the
 * runtime reports, the answer to a switch or a pushed update, never the pick itself. No model list, no chip. mu refuses
 * a switch during a turn, so the chip waits too.
 */
const ComposerModelChip: React.FC<{
  conversation_id: string;
  /** A turn is running: the runtime takes no switch until it ends. */
  busy: boolean;
  prepareRuntime?: () => Promise<void>;
  prepareSetRuntime?: () => Promise<void>;
  configOptionsPort?: AcpConfigOptionsPort;
}> = ({ conversation_id, busy, prepareRuntime, prepareSetRuntime, configOptionsPort }) => {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const { model, thoughtLevel, setStatus, setConfigOption, isConfigOptionBlocked } = useAcpConfigOptions({
    conversation_id,
    prepareRuntime,
    prepareSetRuntime,
    configOptionsPort,
  });
  const revision = model ? `${model.currentValue ?? ''}|${model.options.length}` : '';
  const recorded = useModelLevels(conversation_id, Boolean(model), revision);
  const names = useProviderNames();
  const all = useMemo(
    () => (model ? modelMenu(model, thoughtLevel, recorded, (id) => providerDisplayName(t, id, names)) : []),
    [model, thoughtLevel, recorded, t, names]
  );
  const shown = useMemo(
    () => visibleModelMenu(all, { query, showAll, keep: [model?.currentValue] }),
    [all, model?.currentValue, query, showAll]
  );

  if (!model || model.options.length === 0) return null;

  const setting = setStatus.state === 'setting';
  const disabled = busy || setting || isConfigOptionBlocked(model.id);
  const current = model.options.find((option) => option.value === model.currentValue);
  // mu without a model reports none (older conversations: pi's placeholder `unknown/unknown`). The chip says so, with
  // no thinking level, and opens the list to pick one.
  const noModel = !model.currentValue || model.currentValue === 'unknown/unknown';
  const modelLabel = noModel ? t('mu.noModel.chip') : current?.label || model.currentValue || t('common.defaultModel');

  const close = () => {
    setVisible(false);
    setQuery('');
    setShowAll(false);
  };

  const pick = (value: string, level?: string) => {
    close();
    if (disabled) return;
    void applyModelPick(setConfigOption, { model, thoughtLevel }, { model: value, level }).catch((error: unknown) => {
      Message.error(t(configErrorMessageKey(error)));
    });
  };

  const droplist = modelLevelMenu(t, {
    groups: shown.groups,
    total: model.options.length,
    query,
    onQuery: setQuery,
    current: model.currentValue,
    level: thoughtLevel?.currentValue,
    levels: levelsOf(all, model.currentValue),
    hidden: shown.hidden,
    showAll,
    onShowAll: setShowAll,
    onPick: pick,
  });

  const pill = (
    <span
      data-testid='composer-model-chip'
      data-model={noModel ? '' : model.currentValue}
      className='inline-flex min-w-0'
    >
      <RuntimeSelectorPill
        testId='composer-model-pill'
        className='sendbox-model-btn agent-mode-compact-pill'
        label={noModel ? modelLabel : composeRuntimeSelectorLabel({ t, modelLabel, thoughtLevel })}
        leading={<Brain theme='outline' size='14' fill={iconColors.secondary} className='shrink-0' />}
        trailing={<Down size={12} className='text-t-tertiary shrink-0' />}
        loading={setting}
        disabled={disabled}
        onClick={() => setVisible((open) => !open)}
      />
    </span>
  );

  if (disabled) {
    // A disabled button fires no hover; the reason sits on the wrapper.
    return busy ? (
      <Tooltip content={t('conversation.composer.modelBusy')} position='top'>
        {pill}
      </Tooltip>
    ) : (
      pill
    );
  }

  return (
    // The chip sits at the right of the box, beside the send button: the menu opens above it, flush right.
    <Dropdown
      trigger='click'
      position='tr'
      popupVisible={visible}
      onVisibleChange={(open) => {
        if (open) setVisible(true);
        else close();
      }}
      droplist={droplist}
    >
      {pill}
    </Dropdown>
  );
};

export default ComposerModelChip;
