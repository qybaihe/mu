import type { UpdateErrorCode, UpdateErrorInfo } from '@/common/update/updateErrors';
import type { InstallerReason, UpdateAction, UpdateState } from '@/common/update/updateTypes';
import { formatNumber } from '@/renderer/services/i18n/format';
import type { TFunction } from 'i18next';

/** The sentence for each update failure the main process reports (common/update/updateErrors.ts). */
const UPDATE_ERROR_KEYS: Record<UpdateErrorCode, string> = {
  network: 'update.errors.network',
  timeout: 'update.errors.timeout',
  noUpdateInfo: 'update.errors.noUpdateInfo',
  serverError: 'update.errors.serverError',
  invalidMetadata: 'update.errors.invalidMetadata',
  checkFailed: 'update.errors.checkFailed',
  downloadFailed: 'update.errors.downloadFailed',
  prepareInstallFailed: 'update.errors.prepareInstallFailed',
  prepareInstallTimeout: 'update.errors.prepareInstallTimeout',
};

/** Why an update comes as an installer to open. */
const INSTALLER_REASON_KEYS: Record<InstallerReason, string> = {
  linux: 'update.installerReason.linux',
  unpackaged: 'update.installerReason.unpackaged',
  autoUpdateFailed: 'update.installerReason.autoUpdateFailed',
};

/** What went wrong, in one plain sentence in the app language. */
export const updateErrorText = (t: TFunction, error: UpdateErrorInfo): string =>
  t(UPDATE_ERROR_KEYS[error.code] ?? 'update.errors.checkFailed', { status: error.status ?? '' });

/** A 0-100 progress value as a percentage in the app language ("42%", "42 %" in fr-FR, "%42" in tr-TR). */
const formatPercent = (percent: number | undefined, language: string): string =>
  formatNumber((percent ?? 0) / 100, language, { style: 'percent', maximumFractionDigits: 0 });

/** A download size in whole megabytes, in the app language; binary units, as the rest of the app counts bytes. */
const formatMegabytes = (bytes: number, language: string): string =>
  formatNumber(Math.max(1, Math.round(bytes / 1024 ** 2)), language, { maximumFractionDigits: 0 });

/** What the update in hand is, in a few words: the notice's title and the status line of 关于 (About). */
export const updateHeadline = (t: TFunction, language: string, state: UpdateState): string | null => {
  const version = state.version ?? '';
  switch (state.phase) {
    case 'upToDate':
      return t('update.upToDateTitle');
    case 'failed':
      return state.error ? updateErrorText(t, state.error) : null;
    case 'found':
      // "发现新版本 x.y.z（约 N MB）", without the size when the update feed does not give it.
      return state.size
        ? t('update.foundVersionSize', { version, size: formatMegabytes(state.size, language) })
        : t('update.foundVersion', { version });
    case 'downloading':
      return t('update.downloadingVersion', { version, percent: formatPercent(state.percent, language) });
    case 'ready':
    case 'installing':
      return t('update.readyTitle', { version });
    case 'available':
      return t('update.availableVersion', { version });
    case 'downloadingInstaller':
      return t('update.downloadingInstaller', { percent: formatPercent(state.percent, language) });
    case 'installerReady':
      return t('update.installerReadyTitle', { version });
    case 'idle':
      return null;
  }
};

/** The sentences under the headline: what failed, and why this update comes as an installer to open. */
export const updateDetails = (t: TFunction, state: UpdateState): string[] => {
  const lines: string[] = [];
  if (state.phase === 'ready' && state.lastInstallFailed) lines.push(t('update.lastInstallFailed'));
  if (state.phase === 'available') {
    if (state.error) lines.push(updateErrorText(t, state.error));
    if (state.installerReason) lines.push(t(INSTALLER_REASON_KEYS[state.installerReason]));
  }
  return lines;
};

/** The one step the update in hand asks for, if any: the button with the accent colour. */
export const updateMainAction = (
  t: TFunction,
  state: UpdateState
): { action: UpdateAction; label: string; busy?: boolean } | null => {
  switch (state.phase) {
    case 'found':
      return { action: 'download', label: t('update.download') };
    case 'ready':
      return { action: 'restart', label: t('update.restartToUpdate') };
    case 'installing':
      return { action: 'restart', label: t('update.preparingInstall'), busy: true };
    case 'available':
      return state.installerName
        ? { action: 'downloadInstaller', label: t('update.downloadInstaller') }
        : { action: 'openReleasePage', label: t('update.openReleasePage') };
    case 'installerReady':
      return { action: 'openInstaller', label: t('update.openInstaller') };
    default:
      return null;
  }
};
