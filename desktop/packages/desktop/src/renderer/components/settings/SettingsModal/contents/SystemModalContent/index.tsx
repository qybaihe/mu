/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IGpuStatus, IStartOnBootStatus } from '@/common/adapter/ipcBridge';
import { configService } from '@/common/config/configService';
import AionScrollArea from '@/renderer/components/base/AionScrollArea';
import { notifyManualRestartRequired } from '@/renderer/utils/appRestart';
import { isElectronDesktop, isMacOS } from '@/renderer/utils/platform';
import { Alert, Form, Message, Modal, Switch } from '@arco-design/web-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { useSettingsViewMode } from '../../settingsViewContext';
import DirInputItem from './DirInputItem';
import PreferenceRow from './PreferenceRow';

/**
 * The machine underneath mu: whether it starts with the computer and where it goes when closed, the graphics
 * acceleration, notifications, and the folders it works and logs in. What a conversation waits for and may keep is the
 * conversations page; the language is on the appearance page; the developer tools are a page of their own. Two quiet
 * lists: the switches, then the folders.
 */
const SystemModalContent: React.FC = () => {
  const { t } = useTranslation();
  const isDesktop = isElectronDesktop();
  const [form] = Form.useForm();
  const [modal, modalContextHolder] = Modal.useModal();
  /** A failed directory change: the raw reason, shown under a translated headline. */
  const [error, setError] = useState<{ detail: string } | null>(null);
  const viewMode = useSettingsViewMode();
  const isPageMode = viewMode === 'page';
  const initializingRef = useRef(true);

  const [startOnBoot, setStartOnBoot] = useState<IStartOnBootStatus>({
    supported: false,
    enabled: false,
    isPackaged: false,
    platform: 'web',
  });
  const [closeToTray, setCloseToTray] = useState(false);
  const [gpuStatus, setGpuStatus] = useState<IGpuStatus | null>(null);
  const [notificationEnabled, setNotificationEnabled] = useState(true);
  const [cronNotificationEnabled, setCronNotificationEnabled] = useState(false);

  useEffect(() => {
    if (!isDesktop) {
      return;
    }

    ipcBridge.application.getStartOnBootStatus
      .invoke()
      .then((result) => {
        if (result.success && result.data) {
          setStartOnBoot(result.data);
        }
      })
      .catch(() => {});

    ipcBridge.application.getGpuStatus
      .invoke()
      .then((result) => {
        if (result.success && result.data) {
          setGpuStatus(result.data);
        }
      })
      .catch(() => {});
  }, [isDesktop]);

  useEffect(() => {
    setCloseToTray(configService.get('system.closeToTray') ?? false);
    if (isDesktop) {
      ipcBridge.systemSettings.getCloseToTray
        .invoke()
        .then((enabled) => {
          setCloseToTray(enabled);
          configService.setLocal('system.closeToTray', enabled);
        })
        .catch(() => {});
    }
    setNotificationEnabled(configService.get('system.notificationEnabled') ?? true);
    setCronNotificationEnabled(configService.get('system.cronNotificationEnabled') ?? false);
  }, [isDesktop]);

  const handleCloseToTrayChange = useCallback(
    (checked: boolean) => {
      const previous = closeToTray;
      setCloseToTray(checked);
      configService.setLocal('system.closeToTray', checked);

      if (!isDesktop) {
        configService.set('system.closeToTray', checked).catch(() => {
          setCloseToTray(previous);
          configService.setLocal('system.closeToTray', previous);
        });
        return;
      }

      ipcBridge.systemSettings.setCloseToTray.invoke({ enabled: checked }).catch(() => {
        setCloseToTray(previous);
        configService.setLocal('system.closeToTray', previous);
      });
    },
    [closeToTray, isDesktop]
  );

  const handleHardwareAccelerationChange = useCallback(
    (checked: boolean) => {
      const previous = gpuStatus;
      const optimistic: IGpuStatus = {
        userOverride: checked ? 'force-on' : 'force-off',
        autoDisabled: false,
        crashCount: 0,
        lastCrashAt: gpuStatus?.lastCrashAt ?? null,
      };
      setGpuStatus(optimistic);

      const apply = () => {
        ipcBridge.application.setGpuOverride
          .invoke({ override: checked ? 'force-on' : 'force-off' })
          .then((result) => {
            if (result.success && result.data) {
              setGpuStatus(result.data);
              ipcBridge.application.restart
                .invoke()
                .then((restartResult) => notifyManualRestartRequired(restartResult, t))
                .catch(() => {});
            } else {
              setGpuStatus(previous);
              Message.error(t('settings.hardwareAccelerationUpdateFailed'));
            }
          })
          .catch(() => {
            setGpuStatus(previous);
            Message.error(t('settings.hardwareAccelerationUpdateFailed'));
          });
      };

      modal.confirm({
        title: t('settings.updateConfirm'),
        content: t('settings.hardwareAccelerationRestartConfirm'),
        onOk: apply,
        onCancel: () => setGpuStatus(previous),
      });
    },
    [gpuStatus, modal, t]
  );

  const handleStartOnBootChange = useCallback(
    (checked: boolean) => {
      const previousStatus = startOnBoot;
      setStartOnBoot((prev) => ({ ...prev, enabled: checked }));

      ipcBridge.application.setStartOnBoot
        .invoke({ enabled: checked })
        .then((result) => {
          if (result.success && result.data) {
            setStartOnBoot(result.data);
            return;
          }

          setStartOnBoot(previousStatus);
          if (result.msg) console.warn('[SystemSettings] Start on boot not changed:', result.msg);
          Message.error(
            result.code === 'startOnBootUnsupported'
              ? t('settings.startOnBootUnsupported')
              : t('settings.startOnBootUpdateFailed')
          );
        })
        .catch(() => {
          setStartOnBoot(previousStatus);
          Message.error(t('settings.startOnBootUpdateFailed'));
        });
    },
    [startOnBoot, t]
  );

  const handleNotificationEnabledChange = useCallback((checked: boolean) => {
    setNotificationEnabled(checked);
    configService.set('system.notificationEnabled', checked).catch(() => {
      setNotificationEnabled(!checked);
      configService.setLocal('system.notificationEnabled', !checked);
    });
  }, []);

  const handleCronNotificationEnabledChange = useCallback((checked: boolean) => {
    setCronNotificationEnabled(checked);
    configService.set('system.cronNotificationEnabled', checked).catch(() => {
      setCronNotificationEnabled(!checked);
      configService.setLocal('system.cronNotificationEnabled', !checked);
    });
  }, []);

  // Get system directory info
  const { data: systemInfo } = useSWR('system.dir.info', () => ipcBridge.application.systemInfo.invoke());

  // Initialize form data
  useEffect(() => {
    if (systemInfo) {
      initializingRef.current = true;
      form.setFieldsValue({ workDir: systemInfo.workDir, logDir: systemInfo.logDir });
      requestAnimationFrame(() => {
        initializingRef.current = false;
      });
    }
  }, [systemInfo, form]);

  const preferenceItems = [
    {
      key: 'startOnBoot',
      label: t('settings.startOnBoot'),
      description: startOnBoot.supported ? t('settings.startOnBootDesc') : t('settings.startOnBootUnsupported'),
      component: (
        <Switch
          size='small'
          checked={startOnBoot.enabled}
          onChange={handleStartOnBootChange}
          disabled={!startOnBoot.supported}
        />
      ),
    },
    {
      key: 'closeToTray',
      // On a Mac the closed app lives on in the menu bar, which is what people there call it.
      label: isDesktop && isMacOS() ? t('settings.closeToMenuBar') : t('settings.closeToTray'),
      component: <Switch size='small' checked={closeToTray} onChange={handleCloseToTrayChange} />,
    },
    ...(isDesktop && gpuStatus
      ? [
          {
            key: 'hardwareAcceleration',
            label: t('settings.hardwareAcceleration'),
            description: gpuStatus.autoDisabled
              ? t('settings.hardwareAccelerationAutoDisabled')
              : t('settings.hardwareAccelerationDesc'),
            component: (
              <Switch
                size='small'
                checked={gpuStatus.userOverride !== 'force-off' && !gpuStatus.autoDisabled}
                onChange={handleHardwareAccelerationChange}
              />
            ),
          },
        ]
      : []),
  ];

  const saveDirConfigValidate = (_values: { workDir: string; logDir: string }): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      modal.confirm({
        title: t('settings.updateConfirm'),
        content: t('settings.restartConfirm'),
        onOk: resolve,
        onCancel: reject,
      });
    });
  };

  const savingRef = useRef(false);

  const handleValuesChange = useCallback(
    async (_changedValue: unknown, allValues: Record<string, string>) => {
      if (initializingRef.current || savingRef.current || !systemInfo) return;
      const { workDir, logDir } = allValues;
      const needsRestart = workDir !== systemInfo.workDir || logDir !== systemInfo.logDir;
      if (!needsRestart) return;

      savingRef.current = true;
      setError(null);
      try {
        await saveDirConfigValidate({ workDir, logDir });
        // Pass systemInfo.cacheDir as-is: cacheDir is no longer user-editable
        // (removed from UI), but the backend IPC interface still expects it.
        // Passing the current value ensures existing custom paths are preserved.
        await ipcBridge.application.updateSystemInfo.invoke({ cacheDir: systemInfo.cacheDir, workDir, logDir });
        const restartResult = await ipcBridge.application.restart.invoke();
        notifyManualRestartRequired(restartResult, t);
      } catch (caughtError: unknown) {
        form.setFieldsValue({ workDir: systemInfo.workDir, logDir: systemInfo.logDir });
        if (caughtError) {
          setError({ detail: caughtError instanceof Error ? caughtError.message : String(caughtError) });
        }
      } finally {
        savingRef.current = false;
      }
    },
    [systemInfo, form, saveDirConfigValidate, t]
  );

  return (
    <div className='flex flex-col h-full w-full'>
      {modalContextHolder}

      <AionScrollArea className='flex-1 min-h-0 pb-16px' disableOverflow={isPageMode}>
        <div className='flex flex-col gap-16px'>
          <div className='settings-list'>
            {preferenceItems.map((item) => (
              <PreferenceRow key={item.key} label={item.label} description={item.description}>
                {item.component}
              </PreferenceRow>
            ))}
            <PreferenceRow label={t('settings.notification')}>
              <Switch size='small' checked={notificationEnabled} onChange={handleNotificationEnabledChange} />
            </PreferenceRow>
            {/* The scheduled tasks' own notifications: a row of their own, set in, only while notifications are on. */}
            {notificationEnabled ? (
              <div className='ps-16px'>
                <PreferenceRow label={t('settings.cronNotificationEnabled')}>
                  <Switch
                    size='small'
                    checked={cronNotificationEnabled}
                    onChange={handleCronNotificationEnabledChange}
                  />
                </PreferenceRow>
              </div>
            ) : null}
          </div>

          <Form form={form} layout='vertical' className='settings-list' onValuesChange={handleValuesChange}>
            <DirInputItem label={t('settings.workDir')} field='workDir' />
            <DirInputItem label={t('settings.logDir')} field='logDir' />
          </Form>
          {error && (
            <Alert
              type='error'
              content={
                <div>
                  <span>{t('settings.dirChangeFailed')}</span>
                  {error.detail && <div className='mt-4px text-12px text-t-secondary break-all'>{error.detail}</div>}
                </div>
              }
            />
          )}
        </div>
      </AionScrollArea>
    </div>
  );
};

export default SystemModalContent;
