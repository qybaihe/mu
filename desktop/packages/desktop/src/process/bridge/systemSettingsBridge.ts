/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 系统设置桥接模块
 * System Settings Bridge Module
 *
 * 负责���理系统级设置的读写操作（如关闭到托盘）
 * Handles read/write operations for system-level settings (e.g. close to tray)
 */

import { ipcBridge } from '@/common';
import { electronPowerSaveBlocker } from '@/common/electronSafe';
import { resolveVoiceInputKey } from '@/common/config/voiceInputKeys';
import { exec, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { platform } from 'node:os';
import { applyAppLanguage } from '@process/services/i18n';
import { createOrUpdateTray, destroyTray, setCloseToTrayEnabled } from '@process/utils/tray';
import { readCloseToTraySetting, writeCloseToTraySetting } from '@process/utils/closeToTraySetting';

/** The one hold on idle sleep the app keeps while a conversation runs; null while it may sleep. */
let awakeHold: number | null = null;

/**
 * While a conversation runs and the person has not turned it off, the computer does not go to sleep when idle
 * (`prevent-app-suspension`: the display may still turn off). The window says when that starts and ends.
 */
export function holdAwake(on: boolean): void {
  const blocker = electronPowerSaveBlocker;
  if (!blocker) return;
  if (on && (awakeHold === null || !blocker.isStarted(awakeHold))) awakeHold = blocker.start('prevent-app-suspension');
  else if (!on && awakeHold !== null) {
    if (blocker.isStarted(awakeHold)) blocker.stop(awakeHold);
    awakeHold = null;
  }
}

/**
 * Push-to-talk for the IME voice hotkey (right Ctrl by default: WeType and most Chinese IMEs ship with it).
 *
 * Holding a key needs the press and the release sent separately, and spawning PowerShell costs ~1s of Add-Type per
 * run — so the process stays resident: it compiles the SendInput shim once, then reads `down|up|tap <vk-hex> <0|1>`
 * lines from stdin. INPUT must be 40 bytes on x64: explicit layout pins the union (largest member MOUSEINPUT) while
 * the struct only names the KEYBDINPUT arm.
 */
const KEY_WORKER_PS = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MuTap {
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit, Size = 40)]
  struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }
  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint n, INPUT[] inputs, int size);
  public static void Key(ushort vk, bool ext, bool down) {
    INPUT x = new INPUT();
    x.type = 1; x.ki.wVk = vk;
    x.ki.dwFlags = (ext ? 0x0001u : 0u) | (down ? 0u : 0x0002u);
    SendInput(1, new INPUT[] { x }, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
[Console]::Out.WriteLine('READY')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $p = $line.Split(' ')
  if ($p.Length -ne 3) { continue }
  $vk = [Convert]::ToUInt16($p[1], 16)
  $ext = $p[2] -eq '1'
  if ($p[0] -eq 'down' -or $p[0] -eq 'tap') { [MuTap]::Key($vk, $ext, $true) }
  if ($p[0] -eq 'up' -or $p[0] -eq 'tap') { [MuTap]::Key($vk, $ext, $false) }
  [Console]::Out.WriteLine('OK')
}
`;

type KeyAction = 'down' | 'up' | 'tap';

/** Resident PowerShell speaking the `down|up|tap` line protocol; null once idle-reaped or dead. */
let keyWorker: ChildProcess | null = null;
let keyWorkerIdleTimer: NodeJS.Timeout | null = null;

function killKeyWorker() {
  if (keyWorkerIdleTimer) {
    clearTimeout(keyWorkerIdleTimer);
    keyWorkerIdleTimer = null;
  }
  const worker = keyWorker;
  keyWorker = null;
  worker?.kill();
}

/** Keeps the worker only while the person may press again soon; `unref` lets the app quit regardless. */
function scheduleKeyWorkerKill() {
  if (keyWorkerIdleTimer) clearTimeout(keyWorkerIdleTimer);
  keyWorkerIdleTimer = setTimeout(() => killKeyWorker(), 60_000);
  keyWorkerIdleTimer.unref?.();
}

function ensureKeyWorker(): ChildProcess {
  if (keyWorker && keyWorker.exitCode === null && !keyWorker.killed) return keyWorker;
  const worker = execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', KEY_WORKER_PS],
    { timeout: 0, windowsHide: true }
  );
  worker.on('exit', () => {
    if (keyWorker === worker) {
      keyWorker = null;
      if (keyWorkerIdleTimer) clearTimeout(keyWorkerIdleTimer);
    }
  });
  worker.stdin?.on('error', () => {}); // the person released while the worker was still exiting
  keyWorker = worker;
  return worker;
}

/** Fires the voice input: a configured command runs as-is (once, on press — a plain command has no release half);
 * otherwise the resident worker presses or releases the configured key system-wide. Windows-only without a command. */
async function fireVoiceInput(command: string | undefined, keyId: string | undefined, action: KeyAction): Promise<{ ok: boolean; error?: string }> {
  try {
    if (command && command.trim()) {
      if (action === 'up') return { ok: true };
      await new Promise<void>((resolve, reject) => {
        exec(command, { timeout: 60_000, windowsHide: true }, (error) => (error ? reject(error) : resolve()));
      });
      return { ok: true };
    }
    if (platform() !== 'win32') {
      return { ok: false, error: 'No voice input command configured (the built-in key is Windows-only)' };
    }
    const { vk, extended } = resolveVoiceInputKey(keyId);
    ensureKeyWorker().stdin?.write(`${action} ${vk.toString(16)} ${extended ? 1 : 0}\n`);
    scheduleKeyWorkerKill();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function initSystemSettingsBridge(): void {
  // Voice input: the mic button in the send box fires this — press holds the key, release lifts it (push-to-talk).
  // With a configured command it runs that instead (once, on press).
  ipcBridge.systemSettings.runVoiceCommand.provider(async ({ command, keyId, action }) => fireVoiceInput(command, keyId, action));

  ipcBridge.systemSettings.keepAwakeWhileRunning.provider(async ({ on }) => holdAwake(on === true));

  ipcBridge.systemSettings.getCloseToTray.provider(async () => readCloseToTraySetting());

  ipcBridge.systemSettings.setCloseToTray.provider(async ({ enabled }) => {
    await writeCloseToTraySetting(enabled);
    setCloseToTrayEnabled(enabled);
    if (enabled) {
      createOrUpdateTray();
    } else {
      destroyTray();
    }
  });

  // The renderer changed the app language: switch the main process's own texts. applyAppLanguage rebuilds the
  // application menu and the tray once i18next is in the new language (see onAppLanguageApplied in index.ts).
  ipcBridge.systemSettings.syncMainLanguage.provider(async ({ language }) => {
    try {
      await applyAppLanguage(language);
    } catch (error) {
      console.error('[SystemSettings] Main process could not switch language:', error);
    }
  });
}
