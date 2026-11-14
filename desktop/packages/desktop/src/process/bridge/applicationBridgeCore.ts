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
  // writes files, so the main process asks the OS shell utility. One path per call: the UI
  // copies the file a card or a row names. -EncodedCommand carries the script as UTF-16LE
  // base64, so spaces, quotes and unicode in the path cannot break PowerShell's parsing.
  ipcBridge.fs.copyFileToClipboard.provider(async ({ path: filePath }) => {
    if (!filePath) throw new Error('EMPTY_PATH');
    const { execFile } = await import('child_process');
    const run = (command: string, args: string[]) =>
      new Promise<void>((resolve, reject) =>
        execFile(command, args, { windowsHide: true }, (error) => (error ? reject(error) : resolve()))
      );
    if (process.platform === 'win32') {
      const script = `Set-Clipboard -LiteralPath '${filePath.replace(/'/g, "''")}'`;
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
    } else if (process.platform === 'darwin') {
      await run('osascript', ['-e', `set the clipboard to (POSIX file "${filePath.replace(/"/g, '\\"')}")`]);
    } else {
      throw new Error(`UNSUPPORTED_PLATFORM:${process.platform}`);
    }
    return true;
  });
}
