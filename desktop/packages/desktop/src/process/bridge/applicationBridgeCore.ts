/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Platform-agnostic application bridge handlers.
 * Safe to use in both Electron and WebUI server mode.
 * Electron-only handlers (restart, devtools, zoom, CDP) remain in applicationBridge.ts.
 */
import os from 'os';
import path from 'path';
import { ipcBridge } from '@/common';
import { createSkillFileService } from '@process/services/skills';
import { copyFileToClipboard } from '@process/utils/copyFileToClipboard';
import { getSystemDir, ProcessEnv } from '@process/utils/initStorage';
import { copyDirectoryRecursively, getConfigPath, getDataPath, resolveCliSafePath } from '@process/utils';
import { DIRS_KEY } from '@/common/platform/legacyNames';

export function initApplicationBridgeCore(): void {
  const skillFiles = createSkillFileService();
  ipcBridge.fs.listSkillFiles.provider(({ skill_location }) => skillFiles.list(skill_location));
  ipcBridge.fs.readSkillFile.provider(({ skill_location, relative_path }) =>
    skillFiles.read(skill_location, relative_path)
  );

  // application.systemInfo is served by the backend via HTTP; updateSystemInfo
  // and getPath below remain buildProvider (true IPC) because they need
  // main-process-only APIs (copyDirectoryRecursively, os.homedir()).
  ipcBridge.application.updateSystemInfo.provider(async ({ cacheDir, workDir, logDir }) => {
    const oldDir = getSystemDir();
    const safeCacheDir = resolveCliSafePath(cacheDir, getConfigPath());
    const safeWorkDir = resolveCliSafePath(workDir, getDataPath());
    const safeLogDir = logDir ? resolveCliSafePath(logDir, oldDir.logDir) : oldDir.logDir;

    if (oldDir.cacheDir !== safeCacheDir) {
      await copyDirectoryRecursively(oldDir.cacheDir, safeCacheDir);
    }
    await ProcessEnv.set(DIRS_KEY, { cacheDir: safeCacheDir, workDir: safeWorkDir, logDir: safeLogDir });
  });

  ipcBridge.application.getPath.provider(({ name }) => {
    // Resolve common paths without Electron
    const home = os.homedir();
    const map: Record<string, string> = {
      home,
      desktop: path.join(home, 'Desktop'),
      downloads: path.join(home, 'Downloads'),
    };
    return Promise.resolve(map[name] ?? home);
  });

  // A file on the OS clipboard the user can paste into Explorer/Finder — no web clipboard API
  // writes files, so the main process asks the OS shell utility. One path per call: the UI copies
  // the file a video card names. utils/copyFileToClipboard re-validates the path (a regular video
  // file the card could show) and keeps it out of any script text: the window gets error codes
  // only, never a path. A 10s bound on the child covers a wedged shell utility; a WebUI renderer
  // with no provider connected is failed fast by the caller's own invoke timeout, which falls
  // back to copying the path.
  ipcBridge.fs.copyFileToClipboard.provider(async ({ path: filePath }) => {
    await copyFileToClipboard(filePath);
    return true;
  });
}
