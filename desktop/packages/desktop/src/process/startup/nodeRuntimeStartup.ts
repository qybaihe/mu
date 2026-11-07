import { app, dialog, nativeImage } from 'electron';
import type { TFunction } from 'i18next';
import path from 'node:path';
import { translatorFor } from '@process/services/i18n';
import { ProcessConfig } from '@process/utils/initStorage';
import {
  hasManagedNodeRuntime,
  managedNodeRuntime,
  megabytes,
  planNodeRuntime,
  type ManagedNodeRuntime,
  type NodeRuntimeChoice,
  type NodeRuntimePlan,
} from './nodeRuntimeConsent';

/** The native question before the Node.js download: 下载 / 稍后, with what comes from where, how large, and to where. */
async function askNodeRuntimeDownload(runtime: ManagedNodeRuntime, t: TFunction): Promise<NodeRuntimeChoice> {
  // No window exists yet: bring the app forward so the question is not left behind another one. Only an unpackaged
  // build asks, and its alert would carry Electron's icon: give it the μ one the dock shows.
  app.focus({ steal: true });
  const icon = nativeImage.createFromPath(path.join(process.cwd(), 'resources', 'app_dev.png'));
  const { response } = await dialog.showMessageBox({
    ...(icon.isEmpty() ? {} : { icon }),
    type: 'question',
    buttons: [t('common.nodeRuntime.download'), t('common.nodeRuntime.later')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: t('common.nodeRuntime.title'),
    message: t('common.nodeRuntime.message'),
    detail: t('common.nodeRuntime.detail', {
      version: runtime.version,
      size: megabytes(runtime.bytes),
      folder: runtime.dir,
    }),
  });
  return response === 0 ? 'download' : 'later';
}

/**
 * Decide, before the backend starts, whether it may download the Node.js runtime (see nodeRuntimeConsent.ts). Asks
 * in the app language when one is saved on this computer, else in the system's.
 */
export function planStartupNodeRuntime(options: {
  dataDir: string;
  isPackaged: boolean;
  systemLocale: string;
}): Promise<NodeRuntimePlan> {
  const runtime = managedNodeRuntime(options.dataDir, process.platform, process.arch);
  return planNodeRuntime({
    isPackaged: options.isPackaged,
    isE2E: process.env.MU_E2E_TEST === '1',
    preset: process.env.MU_NODE_RUNTIME,
    runtime,
    installed: runtime ? hasManagedNodeRuntime(runtime, process.platform) : false,
    ask: async (found) => {
      const language = (await ProcessConfig.get('language').catch((): undefined => undefined)) || options.systemLocale;
      return askNodeRuntimeDownload(found, await translatorFor(language));
    },
  });
}
