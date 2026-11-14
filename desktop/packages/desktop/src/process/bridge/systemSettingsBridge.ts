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

/** Taps a key system-wide via SendInput — used for the IME's voice hotkey (right Ctrl by default: WeType and
 * several other Chinese IMEs ship with it). PowerShell is the only dependency-free way to reach the Win32 API from
 * the main process. INPUT must be 40 bytes on x64: explicit layout pins the union (largest member MOUSEINPUT) while
 * the struct only names the KEYBDINPUT arm. */
const TAP_KEY_PS = `
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
  public static void Tap(ushort vk, bool extended) {
    uint flag = extended ? 0x0001u : 0u;
    INPUT[] x = new INPUT[2];
    x[0].type = 1; x[0].ki.wVk = vk; x[0].ki.dwFlags = flag;
    x[1].type = 1; x[1].ki.wVk = vk; x[1].ki.dwFlags = flag | 0x0002u;
    SendInput(2, x, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
[MuTap]::Tap({vk}, {ext})
`;

const tapKeyScript = (vk: number, extended: boolean) => TAP_KEY_PS.replace('{vk}', `0x${vk.toString(16)}`).replace('{ext}', extended ? '$true' : '$false');

/** Runs the person's configured voice-input command, or — with no command configured — taps right Ctrl on Windows
 * (the IME voice hotkey). Returns ok:false instead of throwing so the button can surface the error in its tooltip. */
async function fireVoiceInput(command: string | undefined, keyId: string | undefined): Promise<{ ok: boolean; error?: string }> {
  try {
    if (command && command.trim()) {
      await new Promise<void>((resolve, reject) => {
        exec(command, { timeout: 60_000, windowsHide: true }, (error) => (error ? reject(error) : resolve()));
      });
    } else if (platform() === 'win32') {
      const { vk, extended } = resolveVoiceInputKey(keyId);
      await new Promise<void>((resolve, reject) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', tapKeyScript(vk, extended)],
          { timeout: 15_000, windowsHide: true },
          (error) => (error ? reject(error) : resolve())
        );
      });
    } else {
      return { ok: false, error: 'No voice input command configured (the built-in key tap is Windows-only)' };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function initSystemSettingsBridge(): void {
  // Voice input: the mic button in the send box fires this. With a configured command it runs that; otherwise it
  // taps right Ctrl so the IME's dictation (e.g. WeType's voice hotkey) starts and types into the focused input.
  ipcBridge.systemSettings.runVoiceCommand.provider(async ({ command, keyId }) => fireVoiceInput(command, keyId));

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
