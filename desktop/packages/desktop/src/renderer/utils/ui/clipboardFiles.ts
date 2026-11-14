/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Puts the files themselves on the OS clipboard when the Electron preload bridge
 * is available, so the person can open any folder in Explorer/Finder and paste
 * (Ctrl+V). Returns false when unavailable or unsupported — the caller then
 * falls back to copying the path list as plain text (WebUI, or a platform
 * without a file clipboard).
 */
export const copyFilesToClipboard = async (paths: string[]): Promise<boolean> => {
  const valid = paths.filter((path) => typeof path === 'string' && path.length > 0);
  if (valid.length === 0) return false;
  const write = window.electronAPI?.writeFilesToClipboard;
  if (!write) return false;
  try {
    return (await write(valid)) === true;
  } catch (error) {
    console.error('copyFilesToClipboard failed:', error);
    return false;
  }
};
