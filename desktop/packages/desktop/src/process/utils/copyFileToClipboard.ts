/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Put a file itself on the OS clipboard (paste into Explorer/Finder), for the copy action of a
 * reply's video card. The path the window sends is re-checked here, on the fileRef service's
 * bar: one line, absolute, no control characters, a regular file — and a video extension, the
 * only kind the card shows. Nothing is ever run and the path never appears in any script text:
 * Windows reads it from the child's environment (`$env:MU_CLIP_PATH`), macOS receives it as a
 * separate osascript argument. Errors are codes only, so a path never travels back to the window.
 */
import { execFile } from 'child_process';
import { isAbsolute } from 'path';
import { hasControlCharacter, isVideoPath } from '@/common/chat/fileRefs/pathLike';
import { regularFile } from '@process/services/fileRefs/resolveFileRefs';

/** How long a path from the window may be. */
const LONGEST_PATH = 4096;

/** The shell invocation the copy uses, injectable so a test can watch what would run. */
export type ShellRun = (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => Promise<void>;

/** Runs the OS shell utility without a shell (execFile passes argv and env directly). */
const defaultRun: ShellRun = (command, args, options) =>
  new Promise<void>((resolve, reject) =>
    execFile(command, args, { ...options, windowsHide: true, timeout: 10_000 }, (error) =>
      error ? reject(error) : resolve()
    )
  );

/**
 * Copies `filePath` to the OS clipboard. Throws an Error whose message is one of the codes
 * `INVALID_PATH`, `FILE_NOT_FOUND`, `CLIPBOARD_FAILED`, `UNSUPPORTED_PLATFORM` — never a path.
 */
export async function copyFileToClipboard(filePath: string, run: ShellRun = defaultRun): Promise<void> {
  if (
    typeof filePath !== 'string' ||
    !filePath ||
    filePath.length > LONGEST_PATH ||
    hasControlCharacter(filePath) ||
    !isAbsolute(filePath) ||
    !isVideoPath(filePath)
  )
    throw new Error('INVALID_PATH');
  if (!(await regularFile(filePath))) throw new Error('FILE_NOT_FOUND');

  // A constant script: the path reaches PowerShell through the child's environment, so no
  // character of it — quotes included — is ever parsed as script text.
  const setFromEnv = 'Set-Clipboard -LiteralPath $env:MU_CLIP_PATH';
  const env = { ...process.env, MU_CLIP_PATH: filePath };
  if (process.platform !== 'win32' && process.platform !== 'darwin')
    throw new Error(`UNSUPPORTED_PLATFORM:${process.platform}`);
  try {
    if (process.platform === 'win32') {
      const encoded = Buffer.from(setFromEnv, 'utf16le').toString('base64');
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { env });
    } else {
      await run(
        'osascript',
        ['-e', 'on run {filePath}', '-e', 'set the clipboard to (POSIX file filePath)', '-e', 'end run', filePath],
        { env }
      );
    }
  } catch (error) {
    // The utility's own words (PowerShell may quote the path in them) stay in the main-process log;
    // only the code below crosses back to the window.
    console.error('[copyFileToClipboard] shell utility failed:', error);
    throw new Error('CLIPBOARD_FAILED');
  }
}
