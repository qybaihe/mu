/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Runtime patches must be imported early
import './utils/ui/runtimePatches';

// Browser adapter setup
import '@/common/adapter/browser';

// React and core dependencies
import type { PropsWithChildren } from 'react';
import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SWRConfig } from 'swr';
import type { TFunction } from 'i18next';

// Context providers
import { ThemeProvider } from './hooks/context/ThemeContext';
import { PreviewProvider } from './pages/conversation/Preview/context/PreviewContext';

// Arco Design
import { ConfigProvider, Modal, Typography } from '@arco-design/web-react';
// Configure Arco Design to use React 18's createRoot, fixing Message component's CopyReactDOM.render error
import '@arco-design/web-react/es/_util/react-19-adapter';
import '@arco-design/web-react/dist/css/arco.css';
import enUS from '@arco-design/web-react/es/locale/en-US';
import jaJP from '@arco-design/web-react/es/locale/ja-JP';
import zhCN from '@arco-design/web-react/es/locale/zh-CN';
import zhTW from '@arco-design/web-react/es/locale/zh-TW';
import koKR from '@arco-design/web-react/es/locale/ko-KR';
import trTR from '@arco-design/web-react/es/locale/tr-TR';
import ruRU from '@arco-design/web-react/es/locale/ru-RU';
import ptBR from '@arco-design/web-react/es/locale/pt-BR';
import deDE from '@arco-design/web-react/es/locale/de-DE';
import esES from '@arco-design/web-react/es/locale/es-ES';
import frFR from '@arco-design/web-react/es/locale/fr-FR';
import { useTranslation } from 'react-i18next';

// Styles
import 'uno.css';
import './styles/arco-override.css';
import './styles/themes/index.css';
import './styles/markdown.css';

// Config service — kick off initialization before i18n / theme modules load,
// so their startup paths (which await configService.whenReady()) observe the
// authoritative settings from the backend instead of the empty cache.
import { configService } from '@/common/config/configService';
configService.initialize().catch((err) => {
  console.error('Failed to initialize config:', err);
});

// i18n
import './services/i18n';
import { isRtlLanguage } from './services/i18n/direction';
import { formatNameList } from './services/i18n/list';
import { registerPwa } from './services/registerPwa';

import { ipcBridge } from '@/common';
import { repairAllCronJobTimeZonesOnce } from '@renderer/pages/cron/repairCronJobTimeZone';
import { bootstrapRendererConfig } from '@renderer/services/bootstrapRenderer';
import { ARCO_COMPONENT_CONFIG } from '@renderer/utils/ui/arcoComponentConfig';

// Components and utilities
import BackendStartingView from './components/layout/BackendStartingView';
import BackendStartupGate from './components/layout/BackendStartupGate';
import GpuAutoDisableNotice from './components/layout/GpuAutoDisableNotice';
import Layout from './components/layout/Layout';
import Router from './components/layout/Router';
import Sider from './components/layout/Sider';
import { ConversationHistoryProvider } from './hooks/context/ConversationHistoryContext';
import type { BackendStartupFailureInfo } from '@/common/types/platform/electron';
import type { IRuntimeStatusEvent, RuntimeFailureKind } from '@/common/adapter/ipcBridge';
import {
  InstallationIntegrityContent,
  InstallationIntegrityModalHost,
  getBackendStartupInstallationDescription,
  getDownloadLatestModalActionProps,
  getRuntimeComponentInstallationDescription,
  showInstallationIntegrityModal,
} from './components/layout/InstallationIntegrityDialog';
import { createRuntimeInstallationReconciler } from './services/runtime/runtimeInstallationReconciler';

// Arco ships several locales that predate its newer components: sections such
// as Form, ColorPicker and the Calendar month/year formats are missing there.
// Backfill anything absent from the English locale so every entry satisfies the
// full locale shape (generalises the previous hand-written ko-KR patch).
type ArcoLocaleInput = Omit<Partial<typeof enUS>, 'Calendar' | 'DatePicker'> & {
  Calendar?: Partial<(typeof enUS)['Calendar']>;
  DatePicker?: Omit<Partial<(typeof enUS)['DatePicker']>, 'Calendar'> & {
    Calendar?: Partial<(typeof enUS)['DatePicker']['Calendar']>;
  };
};

const completeArcoLocale = (locale: ArcoLocaleInput): typeof enUS => ({
  ...enUS,
  ...locale,
  Calendar: {
    ...enUS.Calendar,
    ...locale.Calendar,
    monthFormat: locale.Calendar?.monthFormat ?? enUS.Calendar.monthFormat,
    yearFormat: locale.Calendar?.yearFormat ?? enUS.Calendar.yearFormat,
  },
  DatePicker: {
    ...enUS.DatePicker,
    ...locale.DatePicker,
    Calendar: {
      ...enUS.DatePicker.Calendar,
      ...locale.DatePicker?.Calendar,
      monthFormat: locale.DatePicker?.Calendar?.monthFormat ?? enUS.Calendar.monthFormat,
      yearFormat: locale.DatePicker?.Calendar?.yearFormat ?? enUS.Calendar.yearFormat,
    },
  },
  Form: locale.Form ?? enUS.Form,
  ColorPicker: locale.ColorPicker ?? enUS.ColorPicker,
});

// Every language the app ships that Arco publishes a locale for. Arco has no
// uk-UA or fa-IR locale; those get buildAppArcoLocale below.
const arcoLocales: Record<string, typeof enUS> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'ja-JP': jaJP,
  'ko-KR': completeArcoLocale(koKR),
  'en-US': enUS,
  'tr-TR': completeArcoLocale(trTR),
  'ru-RU': completeArcoLocale(ruRU),
  'pt-BR': completeArcoLocale(ptBR),
  'de-DE': completeArcoLocale(deDE),
  'es-ES': completeArcoLocale(esES),
  'fr-FR': completeArcoLocale(frFR),
};

/**
 * For a language Arco publishes no locale for (uk-UA, fa-IR): the texts users meet most (dialog buttons, "No data",
 * upload actions) come from the app's own translations; the rest (date pickers, pagination) stay English.
 */
const buildAppArcoLocale = (t: TFunction): typeof enUS => {
  const okCancel = { okText: t('common.confirm'), cancelText: t('common.cancel') };
  return completeArcoLocale({
    Modal: okCancel,
    Popconfirm: okCancel,
    Drawer: okCancel,
    Empty: { noData: t('common.noData') },
    Upload: {
      ...enUS.Upload,
      cancel: t('common.cancel'),
      delete: t('common.delete'),
      upload: t('common.upload'),
      reupload: t('common.retry'),
    },
  });
};

const INSTALLATION_INTEGRITY_FAILURES = new Set<RuntimeFailureKind>([
  'bundled_resource_missing',
  'bundled_resource_invalid',
  'validation_failed',
]);

function isInstallationIntegrityFailure(kind: RuntimeFailureKind | undefined): boolean {
  return INSTALLATION_INTEGRITY_FAILURES.has(kind ?? 'unknown');
}

function resolveRuntimeResourceLabel(event: IRuntimeStatusEvent, t: TFunction): string {
  if (event.resource === 'node') {
    return t('settings.runtimeResource.node');
  }
  if (event.resource_id === 'codex-acp') {
    return t('settings.runtimeResource.codexAcp');
  }
  if (event.resource_id === 'claude-agent-acp') {
    return t('settings.runtimeResource.claudeAgentAcp');
  }
  return t('settings.runtimeResource.acpTool');
}

const RuntimeFailureDialogs: React.FC = () => {
  const { t } = useTranslation();
  const [modal, modalContextHolder] = Modal.useModal();

  useEffect(() => {
    const reconciler = createRuntimeInstallationReconciler({
      showDialog: (event) => {
        const resource = resolveRuntimeResourceLabel(event, t);
        const description = getRuntimeComponentInstallationDescription(t, resource);
        const controller = showInstallationIntegrityModal(modal, t, description);
        return { close: () => controller.close() };
      },
    });

    const offStatus = ipcBridge.runtime.statusChanged.on((event: IRuntimeStatusEvent) => {
      // Reconcile install-integrity failures and node ready events (spec 8/13.4).
      if (
        (event.phase === 'failed' && isInstallationIntegrityFailure(event.failure_kind)) ||
        (event.phase === 'ready' && event.resource === 'node')
      ) {
        reconciler.handleStatus(event);
        return;
      }

      // Non-integrity failures keep the existing generic error modal (unchanged).
      if (event.phase !== 'failed') {
        return;
      }
      const resource = resolveRuntimeResourceLabel(event, t);
      modal.error({
        title: t('common.error'),
        content: <InstallationIntegrityContent description={t('settings.runtimeStatus.failedUnknown', { resource })} />,
        okText: t('common.confirm'),
        closable: false,
        maskClosable: false,
      });
    });

    return () => {
      offStatus();
      reconciler.dispose();
    };
  }, [modal, t]);

  return <>{modalContextHolder}</>;
};

// Global SWR default: do NOT revalidate every query on window focus. Focus
// refetch (SWR's default) made the app re-hit /api/assistants, /api/skills,
// /api/conversations, etc. on every window focus — often twice (same endpoint
// under different SWR keys) — even though those are kept fresh by WebSocket
// events (conversation.listChanged, team events, extensions.state-changed) or
// in-app `mutate` after edits. Queries that genuinely need focus refresh (e.g.
// Google auth/subscription status, which change in an external browser) opt back
// in per-hook with `revalidateOnFocus: true`.
const SWR_DEFAULTS = { revalidateOnFocus: false } as const;

const AppProviders: React.FC<PropsWithChildren> = ({ children }) =>
  React.createElement(
    SWRConfig,
    { value: SWR_DEFAULTS },
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        PreviewProvider,
        null,
        React.createElement(
          React.Fragment,
          null,
          React.createElement(RuntimeFailureDialogs, null),
          React.createElement(GpuAutoDisableNotice, null),
          children
        )
      )
    )
  );

const Config: React.FC<PropsWithChildren> = ({ children }) => {
  const {
    t,
    i18n: { language },
  } = useTranslation();
  const arcoLocale = useMemo(() => arcoLocales[language] ?? buildAppArcoLocale(t), [language, t]);

  // No `theme` here: Arco writes a primaryColor inline on <body>, one value for both appearances. mu's primary,
  // per appearance, is in styles/themes/mu-arco.css.
  return React.createElement(
    ConfigProvider,
    { locale: arcoLocale, rtl: isRtlLanguage(language), componentConfig: ARCO_COMPONENT_CONFIG },
    children
  );
};

const Main = () => {
  const [configReady, setConfigReady] = useState(false);

  useEffect(() => {
    void bootstrapRendererConfig().finally(() => setConfigReady(true));
  }, []);

  useEffect(() => {
    void repairAllCronJobTimeZonesOnce();
  }, []);

  if (!configReady) {
    return null;
  }

  return (
    <Router
      layout={
        <ConversationHistoryProvider>
          <Layout sider={<Sider />} />
        </ConversationHistoryProvider>
      }
    />
  );
};

const BackendStartupFailureDialog: React.FC<{ failure: BackendStartupFailureInfo }> = ({ failure }) => {
  const { t, i18n } = useTranslation();

  const isIncompatibleRuntime = failure.reason === 'backend_incompatible_runtime';
  const isPackageArchitectureMismatch = failure.reason === 'backend_package_architecture_mismatch';
  const isDataMigrationFailure = failure.reason === 'backend_data_migration_failed';
  const isDatabaseNewerThanApp = failure.reason === 'backend_database_newer_than_app';
  const isLocalDataRepairFailure = failure.reason === 'backend_local_data_repair_failed';
  const isRecoverableDatabaseCorruption = failure.reason === 'backend_recoverable_database_corruption';
  const isTransientConcurrentStartup = failure.reason === 'backend_transient_concurrent_startup';
  const isStartupDirectoryFailure = failure.reason === 'backend_startup_directory_unavailable';
  const isBackendExited = failure.reason === 'backend_startup_exited';
  const isPortReportTimeout = failure.reason === 'backend_startup_port_report_timeout';
  const isIncompleteInstallation = failure.reason === 'backend_incomplete_installation';
  const title = t('common.backendStartup.incompatibleRuntime.title');
  const description = isIncompatibleRuntime
    ? t('common.backendStartup.incompatibleRuntime.description')
    : isPackageArchitectureMismatch
      ? t('common.backendStartup.packageArchitectureMismatch.description', {
          packageArch: failure.packageArch ?? 'x64',
          deviceArch: failure.deviceArch ?? 'arm64',
          expectedArch: failure.expectedDownloadArch ?? 'arm64',
        })
      : isDatabaseNewerThanApp
        ? failure.appVersion
          ? t('common.backendStartup.databaseNewerThanApp.descriptionWithVersion', {
              currentVersion: failure.appVersion,
            })
          : t('common.backendStartup.databaseNewerThanApp.description')
        : isDataMigrationFailure
          ? t('common.backendStartup.dataMigration.description')
          : isLocalDataRepairFailure
            ? t('common.backendStartup.localDataRepair.description')
            : isTransientConcurrentStartup
              ? t('common.backendStartup.transientConcurrentStartup.description')
              : isStartupDirectoryFailure
                ? t('common.backendStartup.startupDirectory.description')
                : isRecoverableDatabaseCorruption
                  ? t('common.backendStartup.recoverableDatabaseCorruption.description')
                  : isBackendExited
                    ? t('common.backendStartup.exited.description')
                    : isPortReportTimeout
                      ? t('common.backendStartup.portReportTimeout.description')
                      : isIncompleteInstallation
                        ? getBackendStartupInstallationDescription(t)
                        : t('common.backendStartup.startupFailed.description');
  const requiredVersions = failure.requiredVersions?.length
    ? formatNameList(
        failure.requiredVersions.map((version) => `GLIBC_${version}`),
        i18n.language
      )
    : undefined;

  if (!isIncompatibleRuntime && !isPackageArchitectureMismatch) {
    return (
      <div className='min-h-screen bg-bg-1'>
        <InstallationIntegrityModalHost
          description={description}
          diagnosticsKind={
            isTransientConcurrentStartup
              ? 'transient_concurrent_startup'
              : isRecoverableDatabaseCorruption
                ? 'recoverable_database_corruption'
                : isStartupDirectoryFailure
                  ? 'startup_directory'
                  : isLocalDataRepairFailure
                    ? 'local_data_repair'
                    : isDatabaseNewerThanApp
                      ? 'database_newer_than_app'
                      : isDataMigrationFailure
                        ? 'data_migration'
                        : isBackendExited
                          ? 'backend_exited'
                          : isPortReportTimeout
                            ? 'port_report_timeout'
                            : isIncompleteInstallation
                              ? 'incomplete_installation'
                              : 'startup_failed'
          }
        />
      </div>
    );
  }

  if (isPackageArchitectureMismatch) {
    return (
      <div className='min-h-screen bg-bg-1'>
        <Modal
          visible
          closable={false}
          maskClosable={false}
          title={t('common.backendStartup.packageArchitectureMismatch.title')}
          {...getDownloadLatestModalActionProps(t)}
        >
          <InstallationIntegrityContent description={description} />
        </Modal>
      </div>
    );
  }

  return (
    <div className='min-h-screen bg-bg-1'>
      <Modal visible closable={false} maskClosable={false} footer={null} title={title}>
        <div className='text-t-primary'>
          <Typography.Paragraph className='mb-0 text-t-secondary'>{description}</Typography.Paragraph>
          {requiredVersions ? (
            <Typography.Paragraph className='mt-12px mb-0 text-12px text-t-tertiary'>
              {t('common.backendStartup.incompatibleRuntime.requiredVersions', { versions: requiredVersions })}
            </Typography.Paragraph>
          ) : null}
        </div>
      </Modal>
    </div>
  );
};

void registerPwa();

const root = createRoot(document.getElementById('root')!);
root.render(
  <BackendStartupGate
    renderStarting={() => (
      <Config>
        <BackendStartingView />
      </Config>
    )}
    renderFailure={(failure) => (
      <Config>
        <BackendStartupFailureDialog failure={failure} />
      </Config>
    )}
    renderApp={() => (
      // Config (Arco's locale and direction) goes outside AppProviders: the feedback modal, the runtime failure
      // dialogs and the GPU notice mounted there use Arco's built-in texts too.
      <Config>
        <AppProviders>
          <Main />
        </AppProviders>
      </Config>
    )}
  />
);
