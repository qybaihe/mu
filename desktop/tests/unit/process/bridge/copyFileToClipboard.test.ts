/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The clipboard copy of a reply's video file, watched at the boundary that matters: what the
 * shell utility is asked to run. A path with PowerShell's other single quotes (U+2018–U+201B)
 * or any other hostile name must appear nowhere in the command or its arguments — only in the
 * child's environment — and what comes back to the window must be a code, not a path.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFileToClipboard, type ShellRun } from '@process/utils/copyFileToClipboard';

const realPlatform = process.platform;

function withPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  vi.restoreAllMocks();
});

/** A regular video file in a temp folder, so the existence check passes. */
function videoFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'copy-file-clipboard-'));
  const file = join(dir, name);
  writeFileSync(file, 'x');
  return file;
}

/** Records every shell invocation and how it failed, if it was told to. */
function recordingRun(failure?: Error) {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const run: ShellRun = async (command, args, options) => {
    calls.push({ command, args, env: options.env });
    if (failure) throw failure;
  };
  return { calls, run };
}

describe('copyFileToClipboard', () => {
  it('on win32, the script is a constant and the path rides the environment', async () => {
    withPlatform('win32');
    // PowerShell also treats U+2018–U+201B as single quotes; the name must never reach the script.
    // (No backslash or colon: those cannot occur in a Windows file name.)
    const file = videoFile(`a\u2019; Start-Process calc; \u2019b.mp4`);
    const { calls, run } = recordingRun();

    await copyFileToClipboard(file, run);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.command).toBe('powershell.exe');
    const script = Buffer.from(call.args[3]!, 'base64').toString('utf16le');
    expect(script).toBe('Set-Clipboard -LiteralPath $env:MU_CLIP_PATH');
    // Nothing the window sent is parsed as script text: not in the command, the arguments, or the script.
    const askedToRun = [call.command, ...call.args, script].join('\n');
    expect(askedToRun).not.toContain(file);
    expect(askedToRun).not.toContain('Start-Process');
    expect(call.env.MU_CLIP_PATH).toBe(file);
  });

  it('on darwin, the path is one argv entry, never spliced into the script lines', async () => {
    withPlatform('darwin');
    const file = videoFile(`quote\u2019in \u2019name.mp4`);
    const { calls, run } = recordingRun();

    await copyFileToClipboard(file, run);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.command).toBe('osascript');
    const scriptLines = call.args.filter((arg) => arg !== file);
    expect(scriptLines.join('\n')).not.toContain("'");
    expect(call.args[call.args.length - 1]).toBe(file);
  });

  it('rejects a path that is not a video the card could show, before anything runs', async () => {
    withPlatform('win32');
    const { calls, run } = recordingRun();

    await expect(copyFileToClipboard(join(tmpdir(), 'notes.txt'), run)).rejects.toThrow('INVALID_PATH');
    await expect(copyFileToClipboard('relative/video.mp4', run)).rejects.toThrow('INVALID_PATH');
    await expect(copyFileToClipboard('', run)).rejects.toThrow('INVALID_PATH');
    await expect(copyFileToClipboard(`${videoFile('a.mp4')}\nanother`, run)).rejects.toThrow('INVALID_PATH');
    expect(calls).toHaveLength(0);
  });

  it('rejects a video that is not there anymore', async () => {
    withPlatform('win32');
    const { calls, run } = recordingRun();

    await expect(copyFileToClipboard(join(tmpdir(), 'missing.mp4'), run)).rejects.toThrow('FILE_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('fails with a code, not the utility words that quote the path', async () => {
    withPlatform('win32');
    const file = videoFile('a.mp4');
    const failure = new Error(
      `Set-Clipboard : Cannot bind argument to parameter 'LiteralPath' because it is null: '${file}'`
    );
    const { run } = recordingRun(failure);

    await expect(copyFileToClipboard(file, run)).rejects.toThrow('CLIPBOARD_FAILED');
    expect(console.error).toHaveBeenCalled();
  });

  it('says which platforms have no file clipboard', async () => {
    withPlatform('linux');
    const { calls, run } = recordingRun();

    await expect(copyFileToClipboard(videoFile('a.mp4'), run)).rejects.toThrow(/^UNSUPPORTED_PLATFORM:/);
    expect(calls).toHaveLength(0);
  });
});
