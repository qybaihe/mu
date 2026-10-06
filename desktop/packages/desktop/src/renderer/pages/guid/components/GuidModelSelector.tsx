/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IProvider, TProviderWithModel } from '@/common/config/storage';
import RuntimeSelectorPill from '@/renderer/components/agent/RuntimeSelectorPill';
import { modelLevelMenu } from '@/renderer/pages/conversation/platforms/acp/Composer/ModelLevelMenu';
import { filterModelMenu, modelMenu } from '@/renderer/pages/conversation/platforms/acp/Composer/modelMenu';
import { iconColors } from '@/renderer/styles/colors';
import { getModelDisplayLabel } from '@/renderer/utils/model/agentLogo';
import type { AgentRuntimeDerivedOption } from '@/renderer/utils/model/agentRuntimeCatalog';
import { useModelNames } from '@/renderer/hooks/agent/useModelNames';
import { useProviderNames } from '@/renderer/hooks/agent/useProviderNames';
import { modelDisplayName, providerDisplayName } from '@/renderer/utils/model/providerName';
import type { AcpModelInfo } from '../types';
import { getAvailableModels } from '../utils/modelUtils';
import { Button, Dropdown, Menu, Tooltip } from '@arco-design/web-react';
import { Brain, Down, Plus } from '@icon-park/react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  composeRuntimeSelectorLabel,
  RuntimeSelectorModelList,
  type RuntimeSelectorModelGroup,
} from '@/renderer/components/agent/runtimeSelectorOptions';

type GuidModelSelectorProps = {
  // Gemini model state
  isGeminiMode: boolean;
  modelList: IProvider[];
  current_model: TProviderWithModel | undefined;
  setCurrentModel: (model: TProviderWithModel) => Promise<void>;

  // ACP model state
  currentAcpCachedModelInfo: AcpModelInfo | null;
  selectedAcpModel: string | null;
  setSelectedAcpModel: React.Dispatch<React.SetStateAction<string | null>>;
  thoughtLevelOption?: AgentRuntimeDerivedOption | null;
  onThoughtLevelSelect?: (value: string) => void;
  /**
   * The model new conversations start on (`provider/model-id`): what the chip shows while nothing is picked, since a
   * send without a pick starts on it. Without it the chip shows the model the agent reported last.
   */
  defaultModel?: string;
  /** Makes the picked model the default. */
  onMakeDefault?: (model: string) => void;
};

/** Composite id for a provider+model pair, so the shared flat model list can track selection. */
const providerCompositeId = (providerId: string, modelName: string) => `${providerId}::${modelName}`;

type AcpModelChipProps = {
  info: AcpModelInfo;
  selected: string | null;
  onSelect: (model: string) => void;
  thoughtLevel: {
    currentValue?: string | null;
    options: ReadonlyArray<{ value: string; label?: string | null }>;
  } | null;
  onThoughtLevelSelect?: (value: string) => void;
  label: string;
  defaultModel?: string;
  onMakeDefault?: (model: string) => void;
};

/**
 * The model · thinking chip of the home page: the same pill and the same menu as a conversation's, fed by the models
 * the agent reported last. The model picked here opens to the thinking levels; the pick is kept for the next send.
 */
const AcpModelChip: React.FC<AcpModelChipProps> = ({
  info,
  selected,
  onSelect,
  thoughtLevel,
  onThoughtLevelSelect,
  label,
  defaultModel,
  onMakeDefault,
}) => {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState('');
  const current = selected ?? defaultModel ?? info.current_model_id;
  const names = useProviderNames();
  const groups = useMemo(
    () =>
      filterModelMenu(
        modelMenu(
          {
            currentValue: current,
            options: info.available_models.map((model) => ({
              value: model.id,
              label: model.label,
              description: model.description,
            })),
          },
          thoughtLevel,
          {},
          (id) => providerDisplayName(t, id, names)
        ),
        query
      ),
    [current, info.available_models, thoughtLevel, query, t, names]
  );

  const pick = (model: string, level?: string) => {
    setVisible(false);
    setQuery('');
    if (model !== current) onSelect(model);
    if (level) onThoughtLevelSelect?.(level);
  };

  return (
    // The composer sits mid-page: the menu opens below the chip, flush right.
    <Dropdown
      trigger='click'
      position='br'
      popupVisible={visible}
      onVisibleChange={(open) => {
        setVisible(open);
        if (!open) setQuery('');
      }}
      droplist={modelLevelMenu(t, {
        groups,
        total: info.available_models.length,
        query,
        onQuery: setQuery,
        current,
        level: thoughtLevel?.currentValue,
        onPick: pick,
        defaultModel,
        ...(onMakeDefault && current
          ? {
              onMakeDefault: () => {
                setVisible(false);
                onMakeDefault(current);
              },
            }
          : {}),
      })}
    >
      <span className='inline-flex min-w-0'>
        <RuntimeSelectorPill
          testId='guid-model-selector'
          className='sendbox-model-btn agent-mode-compact-pill'
          label={label}
          leading={<Brain theme='outline' size='14' fill={iconColors.secondary} className='shrink-0' />}
          trailing={<Down size={12} className='text-t-tertiary shrink-0' />}
          onClick={() => setVisible((open) => !open)}
        />
      </span>
    </Dropdown>
  );
};

const GuidModelSelector: React.FC<GuidModelSelectorProps> = ({
  isGeminiMode,
  modelList,
  current_model,
  setCurrentModel,
  currentAcpCachedModelInfo,
  selectedAcpModel,
  setSelectedAcpModel,
  thoughtLevelOption,
  onThoughtLevelSelect,
  defaultModel,
  onMakeDefault,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const names = useModelNames();
  // A send without a pick starts on the default model: that is what the chip names until one is picked.
  const shownAcpModel = selectedAcpModel ?? defaultModel ?? null;
  const defaultModelLabel = t('common.defaultModel');

  // 过滤掉被禁用的 provider
  const enabledModelList = React.useMemo(() => {
    return modelList.filter((p) => p.enabled !== false);
  }, [modelList]);

  const geminiSelectedLabel = React.useMemo(() => {
    if (!current_model?.use_model) return '';
    return current_model.use_model;
  }, [current_model?.use_model]);

  const geminiButtonLabel = React.useMemo(() => {
    return getModelDisplayLabel({
      selected_value: current_model?.use_model,
      selectedLabel: geminiSelectedLabel,
      defaultModelLabel,
      fallbackLabel: defaultModelLabel,
    });
  }, [current_model?.use_model, defaultModelLabel, geminiSelectedLabel]);

  const acpSelectedLabel = React.useMemo(() => {
    if (shownAcpModel)
      return (
        currentAcpCachedModelInfo?.available_models?.find((m) => m.id === shownAcpModel)?.label ||
        modelDisplayName(shownAcpModel, names)
      );
    return currentAcpCachedModelInfo?.current_model_label || currentAcpCachedModelInfo?.current_model_id || '';
  }, [
    currentAcpCachedModelInfo?.available_models,
    currentAcpCachedModelInfo?.current_model_id,
    currentAcpCachedModelInfo?.current_model_label,
    names,
    shownAcpModel,
  ]);

  const acpButtonLabel = React.useMemo(() => {
    return getModelDisplayLabel({
      selected_value: shownAcpModel || currentAcpCachedModelInfo?.current_model_id,
      selectedLabel: acpSelectedLabel,
      defaultModelLabel,
      fallbackLabel: defaultModelLabel,
    });
  }, [acpSelectedLabel, currentAcpCachedModelInfo?.current_model_id, defaultModelLabel, shownAcpModel]);
  const selectedThoughtLevelValue = thoughtLevelOption?.currentValue || thoughtLevelOption?.options[0]?.value || '';
  const normalizedThoughtLevelOption =
    thoughtLevelOption && thoughtLevelOption.options.length > 0
      ? {
          ...thoughtLevelOption,
          currentValue: selectedThoughtLevelValue || null,
        }
      : null;
  const combinedAcpButtonLabel = composeRuntimeSelectorLabel({
    t,
    modelLabel: acpButtonLabel,
    thoughtLevel: normalizedThoughtLevelOption,
  });

  if (isGeminiMode) {
    // Provider-grouped models (e.g. aionrs). Build groups + a composite-id lookup
    // so the shared model list can search across providers and map back on select.
    const providerModelGroups: RuntimeSelectorModelGroup[] = [];
    const providerModelLookup = new Map<string, { provider: IProvider; modelName: string }>();
    for (const provider of enabledModelList) {
      const available_models = getAvailableModels(provider);
      if (available_models.length === 0) continue;
      providerModelGroups.push({
        key: provider.id,
        title: provider.name,
        models: available_models.map((modelName) => {
          const id = providerCompositeId(provider.id, modelName);
          providerModelLookup.set(id, { provider, modelName });
          return { id, label: modelName };
        }),
      });
    }
    const currentProviderModelId = current_model
      ? providerCompositeId(current_model.id, current_model.use_model || '')
      : null;
    const addModelItem = (
      <Menu.Item key='add-model' className='text-12px text-t-secondary' onClick={() => navigate('/settings/providers')}>
        <Plus theme='outline' size='12' />
        {t('settings.addModel')}
      </Menu.Item>
    );

    return (
      <Dropdown
        trigger='hover'
        droplist={
          <Menu selectedKeys={currentProviderModelId ? [currentProviderModelId] : []}>
            {providerModelGroups.length === 0
              ? [
                  <Menu.Item
                    key='no-models'
                    className='px-12px py-12px text-t-secondary text-14px text-center flex justify-center items-center'
                    disabled
                  >
                    {t('settings.noAvailableModels')}
                  </Menu.Item>,
                  addModelItem,
                ]
              : [
                  <RuntimeSelectorModelList
                    key='model-list'
                    groups={providerModelGroups}
                    currentModelId={currentProviderModelId}
                    onSelect={(id) => {
                      const entry = providerModelLookup.get(id);
                      if (!entry) return;
                      setCurrentModel({ ...entry.provider, use_model: entry.modelName } as TProviderWithModel).catch(
                        (error) => {
                          console.error('Failed to set current model:', error);
                        }
                      );
                    }}
                  />,
                  addModelItem,
                ]}
          </Menu>
        }
      >
        <Button
          className={'sendbox-model-btn guid-config-btn'}
          shape='round'
          size='small'
          data-testid='guid-model-selector'
        >
          <span className='flex items-center gap-6px min-w-0'>
            <Brain theme='outline' size='14' fill={iconColors.secondary} className='shrink-0' />
            <span className='guid-model-label'>{geminiButtonLabel}</span>
            <Down theme='outline' size='12' fill={iconColors.secondary} className='shrink-0' />
          </span>
        </Button>
      </Dropdown>
    );
  }

  // The agent's remembered models: the conversation's model · thinking menu, by provider, in the same pill.
  if (currentAcpCachedModelInfo && currentAcpCachedModelInfo.available_models?.length > 0) {
    return (
      <AcpModelChip
        info={currentAcpCachedModelInfo}
        selected={selectedAcpModel}
        onSelect={setSelectedAcpModel}
        thoughtLevel={normalizedThoughtLevelOption}
        onThoughtLevelSelect={onThoughtLevelSelect}
        label={combinedAcpButtonLabel}
        defaultModel={defaultModel}
        onMakeDefault={onMakeDefault}
      />
    );
  }

  // Fallback: no model switching
  return (
    <Tooltip content={t('conversation.welcome.modelSwitchNotSupported')} position='top'>
      <Button className={'sendbox-model-btn guid-config-btn'} shape='round' size='small' style={{ cursor: 'default' }}>
        <span className='flex items-center gap-6px min-w-0'>
          <Brain theme='outline' size='14' fill={iconColors.secondary} className='shrink-0' />
          <span className='guid-model-label'>{defaultModelLabel}</span>
        </span>
      </Button>
    </Tooltip>
  );
};

export default GuidModelSelector;
