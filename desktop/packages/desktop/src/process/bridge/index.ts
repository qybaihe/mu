/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { initApplicationBridge } from './applicationBridge';
import { initDialogBridge } from './dialogBridge';
import { initUpdateBridge } from './updateBridge';
import { initSystemSettingsBridge } from './systemSettingsBridge';
import { initWindowControlsBridge } from './windowControlsBridge';
import { initNotificationBridge } from './notificationBridge';
import { initThemeBridge } from './themeBridge';
import { initKyrnBridge } from './kyrnBridge';
import { initKyrnBrowserBridge } from './kyrnBrowserBridge';
import { initNativeBridge } from './nativeBridge';
import { initFolderGitBridge } from '../services/folderGit';
import { initFileRefsBridge } from '../services/fileRefs';
import { initTeamDispatchBridge } from '../services/team/teamDispatch';
import { initTeamWorkspaceBridge } from '../services/team/teamWorkspace';
import { initPositionsBridge } from '../services/team/positions';
import { initSupervisorBridge } from '../services/team/supervisor';
import { initQuickDecisionBridge } from '../services/team/quickDecision';
import { initContextStewardBridge } from '../services/team/contextSteward';
import { initInspectionBridge } from '../services/team/inspection';
import { initWebhookBridge } from '../services/team/webhook';

export type BridgeDependencies = Record<string, never>;

export function initAllBridges(_deps: BridgeDependencies = {}): void {
  initDialogBridge();
  initApplicationBridge();
  initWindowControlsBridge();
  initUpdateBridge();
  initSystemSettingsBridge();
  initNotificationBridge();
  initThemeBridge();
  initKyrnBridge();
  initKyrnBrowserBridge();
  initNativeBridge();
  initFolderGitBridge();
  initFileRefsBridge();
  initTeamDispatchBridge();
  initTeamWorkspaceBridge();
  initPositionsBridge();
  initSupervisorBridge();
  initQuickDecisionBridge();
  initContextStewardBridge();
  initInspectionBridge();
  initWebhookBridge();
}

export {
  initApplicationBridge,
  initDialogBridge,
  initNotificationBridge,
  initSystemSettingsBridge,
  initThemeBridge,
  initUpdateBridge,
  initWindowControlsBridge,
};
export { registerWindowMaximizeListeners } from './windowControlsBridge';
export const disposeAllTeamSessions = (): Promise<void> => Promise.resolve();
