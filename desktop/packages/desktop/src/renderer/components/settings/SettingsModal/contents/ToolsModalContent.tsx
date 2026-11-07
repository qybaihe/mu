/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ImageGenerationModelSetting } from '@/common/config/clientSettings';
import {
  describeImageGenerationResolveFailure,
  removeImageGenerationEnvKeys,
  resolveImageGenerationMcpEnv,
} from '@/common/config/imageGenerationMcpEnv';
import { mcpService } from '@/common/adapter/ipcBridge';
import { type IMcpServer, BUILTIN_IMAGE_GEN_ID, BUILTIN_IMAGE_GEN_NAME } from '@/common/config/storage';
import { isImageGenSupported } from '@/common/utils/imageModelAllowlist';
import { parseError } from '@/common/utils';
import { Button, Message, Modal, Switch, Tooltip } from '@arco-design/web-react';
import { Help, Right } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useConfigModelListWithImage from '@/renderer/hooks/agent/useConfigModelListWithImage';
import MuScrollArea from '@/renderer/components/base/MuScrollArea';
import MuSelect from '@/renderer/components/base/MuSelect';
import TalkToButlerButton from '@/renderer/components/base/TalkToButlerButton';
import AddMcpServerModal from '@/renderer/pages/settings/components/AddMcpServerModal';
import McpServerItem from '@/renderer/pages/settings/ToolsSettings/McpServerItem';
import {
  useMcpServers,
  useMcpConnection,
  useMcpModal,
  useMcpServerCRUD,
  useMcpOAuth,
  useMountedMessage,
} from '@/renderer/hooks/mcp';
import {
  getClientBusinessSetting,
  removeClientBusinessSetting,
  setClientBusinessSetting,
} from '@/renderer/services/clientBusinessSettings';
import classNames from 'classnames';
import { useSettingsTabNavigate, useSettingsViewMode } from '../settingsViewContext';

type MessageInstance = ReturnType<typeof Message.useMessage>[0];

const isBuiltinImageGenServer = (server: IMcpServer) =>
  server.builtin === true && (server.id === BUILTIN_IMAGE_GEN_ID || server.name === BUILTIN_IMAGE_GEN_NAME);
const areEnvRecordsEqual = (a: Record<string, string>, b: Record<string, string>) => {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) => a[key] === b[key]);
};
const ModalMcpManagementSection: React.FC<{
  message: MessageInstance;
  mcpServers: IMcpServer[];
  extensionMcpServers: IMcpServer[];
  setMcpServers: React.Dispatch<React.SetStateAction<IMcpServer[]>>;
  saveMcpServers: (serversOrUpdater: IMcpServer[] | ((prev: IMcpServer[]) => IMcpServer[])) => Promise<void>;
  isPageMode?: boolean;
}> = ({ message, mcpServers, extensionMcpServers, setMcpServers, saveMcpServers, isPageMode }) => {
  const { t } = useTranslation();
  const { oauthStatus, loggingIn, checkOAuthStatus, markLoginRequired, clearLoginRequired, login } = useMcpOAuth();
  const visibleMcpServers = useMemo(
    () => mcpServers.filter((server) => !isBuiltinImageGenServer(server)),
    [mcpServers]
  );

  const handleAuthRequired = useCallback(
    (server: IMcpServer) => {
      markLoginRequired(server.id);
    },
    [markLoginRequired]
  );
  const handleAuthResolved = useCallback(
    (server: IMcpServer) => {
      clearLoginRequired(server.id);
    },
    [clearLoginRequired]
  );

  const { testingServers, handleTestMcpConnection, handleTestMcpConnections } = useMcpConnection(
    setMcpServers,
    message,
    handleAuthRequired,
    handleAuthResolved
  );
  const {
    showMcpModal,
    editingMcpServer,
    deleteConfirmVisible,
    serverToDelete,
    mcpCollapseKey,
    showAddMcpModal,
    showEditMcpModal,
    hideMcpModal,
    showDeleteConfirm,
    hideDeleteConfirm,
    toggleServerCollapse,
  } = useMcpModal();
  const { handleAddMcpServer, handleBatchImportMcpServers, handleEditMcpServer, handleDeleteMcpServer } =
    useMcpServerCRUD(saveMcpServers);

  const handleOAuthLogin = useCallback(
    async (server: IMcpServer) => {
      const result = await login(server);

      if (result.success) {
        message.success(t('settings.mcpOAuthLoginSuccessNamed', { name: server.name }));
        void handleTestMcpConnection(server);
      } else {
        message.error(
          result.error
            ? t('settings.mcpOAuthLoginFailedNamedWithDetail', { name: server.name, error: result.error })
            : t('settings.mcpOAuthLoginFailedNamed', { name: server.name })
        );
      }
    },
    [login, message, t, handleTestMcpConnection]
  );

  const wrappedHandleAddMcpServer = useCallback(
    async (serverData: Omit<IMcpServer, 'id' | 'created_at' | 'updated_at'>) => {
      const addedServer = await handleAddMcpServer(serverData);
      if (addedServer) {
        void handleTestMcpConnection(addedServer, { notify: false });
      }
    },
    [handleAddMcpServer, handleTestMcpConnection]
  );

  const wrappedHandleEditMcpServer = useCallback(
    async (serverToEdit: IMcpServer | undefined, serverData: Omit<IMcpServer, 'id' | 'created_at' | 'updated_at'>) => {
      const updatedServer = await handleEditMcpServer(serverToEdit, serverData);
      if (updatedServer) {
        void handleTestMcpConnection(updatedServer, { notify: false });
      }
    },
    [handleEditMcpServer, handleTestMcpConnection]
  );

  const wrappedHandleBatchImportMcpServers = useCallback(
    async (serversData: Omit<IMcpServer, 'id' | 'created_at' | 'updated_at'>[]) => {
      const addedServers = await handleBatchImportMcpServers(serversData);
      if (addedServers && addedServers.length > 0) {
        await handleTestMcpConnections(addedServers, { concurrency: 4, notify: false });
      }
      return addedServers;
    },
    [handleBatchImportMcpServers, handleTestMcpConnections]
  );

  const [importMode, setImportMode] = useState<'json' | 'oneclick'>('json');

  useEffect(() => {
    const httpServers = mcpServers.filter(
      (s) => s.transport.type === 'http' || s.transport.type === 'sse' || s.transport.type === 'streamable_http'
    );
    if (httpServers.length > 0) {
      httpServers.forEach((server) => {
        void checkOAuthStatus(server);
      });
    }
  }, [mcpServers, checkOAuthStatus]);

  const handleConfirmDelete = useCallback(async () => {
    if (!serverToDelete) return;
    hideDeleteConfirm();
    await handleDeleteMcpServer(serverToDelete);
  }, [serverToDelete, hideDeleteConfirm, handleDeleteMcpServer]);

  const renderAddButton = () => {
    return (
      <TalkToButlerButton
        label={t('settings.mcpAddServer')}
        chatLabel={t('settings.talkToButler.addViaChat', { defaultValue: 'Add in a conversation' })}
        prompt={t('settings.talkToButler.prompt.addMcp', { defaultValue: 'Help me set up an MCP server.' })}
        extraActions={[
          {
            key: 'json',
            label: t('settings.mcpImportFromJSON'),
            onClick: () => {
              setImportMode('json');
              showAddMcpModal();
            },
          },
          {
            key: 'oneclick',
            label: t('settings.mcpOneKeyImport'),
            onClick: () => {
              setImportMode('oneclick');
              showAddMcpModal();
            },
          },
        ]}
      />
    );
  };

  return (
    <section className='settings-group min-h-0'>
      <div className='flex gap-8px items-center justify-between'>
        <h3 className='settings-group__title'>{t('settings.mcpSettings')}</h3>
        <div>{renderAddButton()}</div>
      </div>

      <div className='flex-1 min-h-0'>
        {visibleMcpServers.length === 0 && extensionMcpServers.length === 0 ? (
          <div className='settings-list'>
            <div className='py-24px text-center text-t-secondary text-13px'>{t('settings.mcpNoServersFound')}</div>
          </div>
        ) : (
          <MuScrollArea className={classNames('max-h-360px', isPageMode && 'max-h-none')} disableOverflow={isPageMode}>
            {/* One row per server between hairlines, no boxes. The line sits on a wrapper (settings-list draws it),
                because a borderless Arco collapse clears any border of its own. */}
            <div className='settings-list'>
              {visibleMcpServers.map((server) => (
                <div key={server.id}>
                  <McpServerItem
                    server={server}
                    isCollapsed={mcpCollapseKey[server.id] || false}
                    isTestingConnection={testingServers[server.id] || false}
                    oauthStatus={oauthStatus[server.id]}
                    isLoggingIn={loggingIn[server.id]}
                    onToggleCollapse={() => toggleServerCollapse(server.id)}
                    onTestConnection={handleTestMcpConnection}
                    onEditServer={showEditMcpModal}
                    onDeleteServer={showDeleteConfirm}
                    onOAuthLogin={handleOAuthLogin}
                  />
                </div>
              ))}
              {extensionMcpServers.map((server) => (
                <div key={server.id}>
                  <McpServerItem
                    server={server}
                    isCollapsed={mcpCollapseKey[server.id] || false}
                    isTestingConnection={false}
                    onToggleCollapse={() => toggleServerCollapse(server.id)}
                    onTestConnection={handleTestMcpConnection}
                    onEditServer={() => {}}
                    onDeleteServer={() => {}}
                    isReadOnly
                  />
                </div>
              ))}
            </div>
          </MuScrollArea>
        )}
      </div>

      <AddMcpServerModal
        visible={showMcpModal}
        server={editingMcpServer}
        existingServerNames={mcpServers.map((server) => server.name)}
        onCancel={hideMcpModal}
        onSubmit={
          editingMcpServer
            ? (serverData) => wrappedHandleEditMcpServer(editingMcpServer, serverData)
            : wrappedHandleAddMcpServer
        }
        onBatchImport={wrappedHandleBatchImportMcpServers}
        importMode={importMode}
      />

      <Modal
        title={t('settings.mcpDeleteServer')}
        visible={deleteConfirmVisible}
        onCancel={hideDeleteConfirm}
        onOk={handleConfirmDelete}
        okButtonProps={{ status: 'danger' }}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
      >
        <p>{t('settings.mcpDeleteConfirm')}</p>
      </Modal>
    </section>
  );
};

const ToolsModalContent: React.FC = () => {
  const { t } = useTranslation();
  const [rawMcpMessage, mcpMessageContext] = Message.useMessage({ maxCount: 10 });
  // ELECTRON-1A1: guard message calls so async MCP callbacks that resolve after this
  // component unmounts don't hit a null Arco context holder (null.addInstance crash).
  const mcpMessage = useMountedMessage(rawMcpMessage);
  const [imageGenerationModel, setImageGenerationModel] = useState<ImageGenerationModelSetting | undefined>();
  const [isUpdatingImageGeneration, setIsUpdatingImageGeneration] = useState(false);
  const { modelListWithImage: data } = useConfigModelListWithImage();
  const { mcpServers, extensionMcpServers, saveMcpServers, setMcpServers, isMcpServersLoading } = useMcpServers();
  const builtinImageGenServer = useMemo(() => mcpServers.find(isBuiltinImageGenServer), [mcpServers]);
  const isImageGenerationServerLoading = isMcpServersLoading && !builtinImageGenServer;

  const imageGenerationModelList = useMemo(() => {
    if (!data) return [];
    return (data || [])
      .map((provider) => ({
        ...provider,
        models: provider.models.filter((modelName) => isImageGenSupported(provider, modelName)),
      }))
      .filter((provider) => provider.models.length > 0);
  }, [data]);

  useEffect(() => {
    const loadConfigs = async () => {
      try {
        const storedModel = await getClientBusinessSetting('tools.imageGenerationModel');
        if (storedModel) {
          setImageGenerationModel(storedModel);
        }
      } catch (error) {
        console.error('Failed to load tools config:', error);
      }
    };

    void loadConfigs();
  }, []);

  // Sync image generation model config to the built-in MCP server's transport.env
  const syncMcpServerEnv = useCallback(
    async (model: Partial<ImageGenerationModelSetting>) => {
      const builtinServer = mcpServers.find(isBuiltinImageGenServer);
      if (!builtinServer || builtinServer.transport.type !== 'stdio') return;

      const existingEnv = builtinServer.transport.env || {};
      let env: Record<string, string>;

      if (!model.id && !model.use_model) {
        env = removeImageGenerationEnvKeys(existingEnv);
        console.info('[ImageGen] Cleared built-in MCP image env because image generation model is unset');
      } else {
        const resolution = resolveImageGenerationMcpEnv(model, data || [], existingEnv);
        if (resolution.ok === false) {
          console.error('[ImageGen] Failed to resolve image MCP provider', {
            reason: resolution.reason,
            message: resolution.message,
            candidates: resolution.candidates,
          });
          throw new Error(describeImageGenerationResolveFailure(t, resolution));
        }

        env = {
          ...removeImageGenerationEnvKeys(existingEnv),
          ...resolution.env,
        };
        console.info(
          '[ImageGen] Syncing built-in MCP image env via %s, provider id: %s, platform: %s, model: %s, api key present: %s',
          resolution.source,
          resolution.provider.id,
          resolution.provider.platform,
          resolution.model,
          resolution.provider.api_key ? 'yes' : 'no'
        );
      }

      if (areEnvRecordsEqual(existingEnv, env)) {
        return;
      }

      const updatedTransport = { ...builtinServer.transport, env };
      const original_json = JSON.stringify(
        {
          mcpServers: {
            [builtinServer.name]: {
              command: updatedTransport.command,
              args: updatedTransport.args || [],
              env,
            },
          },
        },
        null,
        2
      );

      const updatedServer = await mcpService.updateServer.invoke({
        id: builtinServer.id,
        data: {
          transport: updatedTransport,
          original_json,
        },
      });
      await saveMcpServers((prevServers) =>
        prevServers.map((server) => (server.id === updatedServer.id ? { ...server, ...updatedServer } : server))
      );
    },
    [data, mcpServers, saveMcpServers, t]
  );

  // Keep the saved image model as a provider/model reference. Secrets stay in providers.
  useEffect(() => {
    if (!imageGenerationModel || !data) return;

    const currentProvider = data.find((p) => p.id === imageGenerationModel.id);

    if (!currentProvider) {
      setImageGenerationModel(undefined);
      removeClientBusinessSetting('tools.imageGenerationModel').catch((error) => {
        console.error('Failed to remove image generation model config:', error);
      });
      void syncMcpServerEnv({}).catch((error) => {
        console.error('Failed to clear image generation MCP env after provider removal:', error);
      });
      return;
    }

    const sanitizedModel = {
      ...imageGenerationModel,
      name: currentProvider.name,
      platform: currentProvider.platform,
      base_url: '',
      api_key: '',
    };

    if (imageGenerationModel.api_key || imageGenerationModel.base_url) {
      setImageGenerationModel(sanitizedModel);
      setClientBusinessSetting('tools.imageGenerationModel', sanitizedModel).catch((error) => {
        console.error('Failed to sanitize image generation model config:', error);
      });
    }

    void syncMcpServerEnv(sanitizedModel).catch((error) => {
      console.error('Failed to sync image generation MCP env after provider change:', error);
    });
  }, [data, imageGenerationModel, syncMcpServerEnv]);

  const handleImageGenerationModelChange = useCallback(
    (value: Partial<ImageGenerationModelSetting>) => {
      setImageGenerationModel((prev) => {
        const newImageGenerationModel = {
          ...prev,
          id: value.id,
          name: value.name,
          platform: value.platform,
          base_url: '',
          api_key: '',
          use_model: value.use_model,
        } as ImageGenerationModelSetting;
        setClientBusinessSetting('tools.imageGenerationModel', newImageGenerationModel).catch((error) => {
          console.error('Failed to update image generation model config:', error);
        });
        // Sync env vars to the built-in MCP server
        void syncMcpServerEnv(newImageGenerationModel).catch((error) => {
          console.error('Failed to sync image generation MCP env:', error);
          mcpMessage.error(t('settings.mcpSyncFailed', { error: parseError(error) }));
        });
        return newImageGenerationModel;
      });
    },
    [mcpMessage, syncMcpServerEnv, t]
  );

  const handleImageGenerationToggle = useCallback(
    async (checked: boolean) => {
      if (!builtinImageGenServer) return;

      setIsUpdatingImageGeneration(true);
      try {
        if (checked) {
          if (!imageGenerationModel?.id || !imageGenerationModel.use_model) {
            mcpMessage.error(t('settings.mcpSyncError'));
            return;
          }
          await syncMcpServerEnv(imageGenerationModel);
        }
        const updatedServer = await mcpService.toggleServer.invoke({ id: builtinImageGenServer.id });
        await saveMcpServers((prevServers) =>
          prevServers.map((server) => (server.id === updatedServer.id ? { ...server, ...updatedServer } : server))
        );

        if (updatedServer.enabled !== checked) {
          mcpMessage.error(checked ? t('settings.mcpSyncError') : t('settings.mcpRemoveError'));
          return;
        }

        setImageGenerationModel((prev) => {
          if (!prev) return prev;
          const next = { ...prev, switch: checked };
          setClientBusinessSetting('tools.imageGenerationModel', next).catch((error) => {
            console.error('Failed to sync image generation switch state:', error);
          });
          return next;
        });
      } catch (error) {
        console.error('Failed to toggle image generation MCP server:', error);
        mcpMessage.error(t('settings.mcpSyncFailed', { error: parseError(error) }));
      } finally {
        setIsUpdatingImageGeneration(false);
      }
    },
    [builtinImageGenServer, imageGenerationModel, mcpMessage, saveMcpServers, syncMcpServerEnv, t]
  );

  const viewMode = useSettingsViewMode();
  const isPageMode = viewMode === 'page';
  const navigateToSettingsTab = useSettingsTabNavigate();
  const isImageGenerationModelUnavailable = !imageGenerationModelList.length || !imageGenerationModel?.use_model;

  return (
    <div className='flex flex-col h-full w-full'>
      {mcpMessageContext}

      {/* Content Area: the MCP servers, then image generation, as quiet lists with no boxes. */}
      <MuScrollArea className='flex-1 min-h-0 pb-16px' disableOverflow={isPageMode}>
        <div className='flex flex-col gap-16px'>
          {/* MCP 工具配置 */}
          <div className='flex flex-col min-h-0'>
            <div className='flex-1 min-h-0'>
              <MuScrollArea
                className={classNames('h-full', isPageMode && 'overflow-visible')}
                disableOverflow={isPageMode}
              >
                <ModalMcpManagementSection
                  message={mcpMessage}
                  mcpServers={mcpServers}
                  extensionMcpServers={extensionMcpServers}
                  setMcpServers={setMcpServers}
                  saveMcpServers={saveMcpServers}
                  isPageMode={isPageMode}
                />
              </MuScrollArea>
            </div>
          </div>
          {/* 图像生成: the switch, then the model it draws with. */}
          <div className='settings-list'>
            <div className='flex items-center justify-between gap-24px py-12px'>
              <span className='text-14px font-500 leading-22px text-t-primary'>{t('settings.imageGeneration')}</span>
              <Switch
                size='small'
                aria-label={t('settings.imageGeneration')}
                disabled={
                  isUpdatingImageGeneration ||
                  isImageGenerationServerLoading ||
                  !builtinImageGenServer ||
                  (!builtinImageGenServer.enabled && isImageGenerationModelUnavailable)
                }
                checked={Boolean(builtinImageGenServer?.enabled) && !isImageGenerationServerLoading}
                loading={isImageGenerationServerLoading}
                onChange={handleImageGenerationToggle}
              />
            </div>

            <div className='flex flex-col gap-8px py-12px md:flex-row md:items-center md:justify-between md:gap-24px'>
              <div className='flex min-w-0 items-center gap-6px'>
                <span className='text-14px font-500 leading-22px text-t-primary'>
                  {t('settings.imageGenerationModel')}
                </span>
                <Tooltip
                  content={
                    <div className='space-y-4px'>
                      <div>{t('settings.imageGenSupportedTooltipTitle')}</div>
                      <ul className='list-disc ps-16px m-0'>
                        <li>{t('settings.imageGenSupportedTooltipGemini')}</li>
                        <li>{t('settings.imageGenSupportedTooltipOpenRouter')}</li>
                        <li>{t('settings.imageGenSupportedTooltipAntigravity')}</li>
                      </ul>
                      <div>{t('settings.imageGenUnsupportedTooltip')}</div>
                    </div>
                  }
                >
                  <span className='inline-flex shrink-0 cursor-help text-t-tertiary hover:text-t-secondary'>
                    <Help theme='outline' size='14' fill='currentColor' />
                  </span>
                </Tooltip>
              </div>
              <div className='w-full md:w-280px md:shrink-0'>
                {imageGenerationModelList.length > 0 ? (
                  <MuSelect
                    value={
                      imageGenerationModel?.id && imageGenerationModel?.use_model
                        ? `${imageGenerationModel.id}|${imageGenerationModel.use_model}`
                        : undefined
                    }
                    onChange={(value) => {
                      const [platformId, modelName] = value.split('|');
                      const platform = imageGenerationModelList.find((p) => p.id === platformId);
                      if (platform) {
                        handleImageGenerationModelChange({
                          ...platform,
                          use_model: modelName,
                        });
                      }
                    }}
                  >
                    {imageGenerationModelList.map(({ models, ...platform }) => (
                      <MuSelect.OptGroup label={platform.name} key={platform.id}>
                        {models.map((modelName) => (
                          <MuSelect.Option key={platform.id + modelName} value={platform.id + '|' + modelName}>
                            {modelName}
                          </MuSelect.Option>
                        ))}
                      </MuSelect.OptGroup>
                    ))}
                  </MuSelect>
                ) : (
                  <div className='text-13px text-t-secondary flex flex-wrap items-center gap-4px md:justify-end'>
                    <span>{t('settings.noAvailable')}</span>
                    {navigateToSettingsTab ? (
                      // In the text colour with a trailing chevron: it reads as the way there, not as more of the sentence.
                      <Button
                        type='text'
                        size='small'
                        className='!px-4px !text-t-primary !font-500'
                        onClick={() => navigateToSettingsTab('providers')}
                      >
                        <span className='inline-flex items-center gap-2px'>
                          {t('settings.goToModelSettings')}
                          <Right
                            theme='outline'
                            size={12}
                            fill='currentColor'
                            data-testid='go-to-model-settings-chevron'
                          />
                        </span>
                      </Button>
                    ) : (
                      t('settings.goToModelSettings')
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </MuScrollArea>
    </div>
  );
};

export default ToolsModalContent;
