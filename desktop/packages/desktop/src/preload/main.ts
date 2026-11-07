/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { ADAPTER_BRIDGE_EVENT_KEY } from '../common/adapter/constant';

/**
 * @description 注入到renderer进程中, 用于与main进程通信
 * */
contextBridge.exposeInMainWorld('electronAPI', {
  emit: (name: string, data: unknown) => {
    return ipcRenderer
      .invoke(
        ADAPTER_BRIDGE_EVENT_KEY,
        JSON.stringify({
          name: name,
          data: data,
        })
      )
      .catch((error) => {
        console.error('IPC invoke error:', error);
        throw error;
      });
  },
  on: (callback: (payload: { event: unknown; value: unknown }) => void) => {
    const handler = (event: unknown, value: unknown) => {
      callback({ event, value });
    };
    ipcRenderer.on(ADAPTER_BRIDGE_EVENT_KEY, handler);
    return () => {
      ipcRenderer.off(ADAPTER_BRIDGE_EVENT_KEY, handler);
    };
  },
  // 获取拖拽文件/目录的绝对路径 / Get absolute path for dragged file/directory
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  recoverCorruptedDatabase: () => ipcRenderer.invoke('backend:recover-corrupted-database'),
  openLogFolder: () => ipcRenderer.invoke('backend:open-log-folder'),
});

// Synchronously fetch the backend port and expose it to the renderer
// via contextBridge (direct window assignment is invisible under contextIsolation).
const backendPort = ipcRenderer.sendSync('get-backend-port') as number;
const initialLanguage = ipcRenderer.sendSync('get-initial-language') as string | null;
const backendStartupFailed = ipcRenderer.sendSync('get-backend-startup-failed') as boolean;
const backendStartupFailure = ipcRenderer.sendSync('get-backend-startup-failure') as unknown;
const nodeRuntimeDeferred = ipcRenderer.sendSync('get-node-runtime-deferred') as boolean;
contextBridge.exposeInMainWorld('__backendPort', backendPort > 0 ? backendPort : 0);
contextBridge.exposeInMainWorld('__initialLanguage', initialLanguage ?? null);
contextBridge.exposeInMainWorld('__muE2ETest', process.env.MU_E2E_TEST === '1');
contextBridge.exposeInMainWorld('__backendStartupFailed', backendStartupFailed === true);
contextBridge.exposeInMainWorld('__backendStartupFailure', backendStartupFailure ?? null);
// The person put the Node.js runtime download off at this start: see common/adapter/nodeRuntimeDeferral.ts.
contextBridge.exposeInMainWorld('__nodeRuntimeDeferred', nodeRuntimeDeferred === true);

// Backend startup state bridge: `getState` re-reads the current failure info on
// mount (resolves the "READY arrived before the renderer subscribed" race), and
// `subscribe` receives subsequent ready/exit pushes on the backend-startup-state
// channel. All communication stays behind the preload contextBridge.
contextBridge.exposeInMainWorld('__backendStartupBridge', {
  getState: () => ipcRenderer.sendSync('get-backend-startup-failure'),
  subscribe: (callback: (state: unknown) => void) => {
    const handler = (_event: unknown, value: unknown) => callback(value);
    ipcRenderer.on('backend-startup-state', handler);
    return () => {
      ipcRenderer.off('backend-startup-state', handler);
    };
  },
});

// 托盘事件监听 - 将 IPC 事件转换为 DOM 事件
// Tray event listeners - convert IPC events to DOM events
const trayEvents = [
  'tray:navigate-to-guid',
  'tray:navigate-to-conversation',
  'tray:open-about',
  'tray:pause-all-tasks',
];

for (const channel of trayEvents) {
  ipcRenderer.on(channel, (_event, ...args) => {
    window.dispatchEvent(new CustomEvent(channel, { detail: args[0] }));
  });
}
