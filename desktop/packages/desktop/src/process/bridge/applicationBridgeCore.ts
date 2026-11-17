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
import { execFile } from 'child_process';
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
  // writes files, so the main process asks the OS shell utility. One path per call: the UI copies
  // the file a video card names. The path is never spliced into script text: win32 sends a
  // UTF-16LE base64 -EncodedCommand (PowerShell parses none of it), darwin hands the path to
  // osascript as a separate argv entry its `on run` handler receives (execFile passes argv
  // directly — there is no shell to escape out of). A 10s bound on the child covers a wedged
  // shell utility; a WebUI renderer with no provider connected is failed fast by the caller's
  // own invoke timeout, which falls back to copying the path.
  ipcBridge.fs.copyFileToClipboard.provider(async ({ path: filePath }) => {
    if (!filePath) throw new Error('EMPTY_PATH');
    const run = (command: string, args: string[]) =>
      new Promise<void>((resolve, reject) =>
        execFile(command, args, { windowsHide: true, timeout: 10_000 }, (error) => (error ? reject(error) : resolve()))
      );
    if (process.platform === 'win32') {
      // Set-Clipboard -LiteralPath takes the path verbatim; a single quote inside it is doubled,
      // the only escaping a PowerShell single-quoted string needs. -EncodedCommand carries the
      // script as base64 UTF-16LE, so spaces, quotes and unicode in the path cannot break parsing.
      const script = `Set-Clipboard -LiteralPath '${filePath.replaceAll("'", "''")}'`;
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
    } else if (process.platform === 'darwin') {
      await run('osascript', [
        '-e',
        'on run {filePath}',
        '-e',
        'set the clipboard to (POSIX file filePath)',
        '-e',
        'end run',
        filePath,
      ]);
    } else {
      throw new Error(`UNSUPPORTED_PLATFORM:${process.platform}`);
    }
    return true;
  });
}
