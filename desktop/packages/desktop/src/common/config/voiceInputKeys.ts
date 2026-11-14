/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** The key the built-in voice tap presses (the IME's voice hotkey), keyed by setting `system.voiceInputKey`.
 * IME voice hotkeys are single keys in practice; anything fancier belongs in the configured external command. */
export const VOICE_INPUT_KEYS = {
  rightCtrl: { vk: 0xa3, extended: true }, // WeType's (and many IMEs') default voice key
  leftCtrl: { vk: 0xa2, extended: false },
  rightShift: { vk: 0xa1, extended: true },
  leftShift: { vk: 0xa0, extended: false },
  f2: { vk: 0x71, extended: false },
  capsLock: { vk: 0x14, extended: false },
} as const;

export type VoiceInputKeyId = keyof typeof VOICE_INPUT_KEYS;

export const DEFAULT_VOICE_INPUT_KEY: VoiceInputKeyId = 'rightCtrl';

export function resolveVoiceInputKey(id: string | undefined): { vk: number; extended: boolean } {
  return VOICE_INPUT_KEYS[(id as VoiceInputKeyId) ?? ''] ?? VOICE_INPUT_KEYS[DEFAULT_VOICE_INPUT_KEY];
}
