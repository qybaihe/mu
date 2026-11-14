/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';
import { Button, Tooltip } from '@arco-design/web-react';
import { Microphone } from '@icon-park/react';
import { iconColors } from '@/renderer/styles/colors';
import { isElectronDesktop } from '@/renderer/utils/platform';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const SETTING_KEY = 'system.voiceInputCommand';
/** How long the mic stays "listening": a hands-free IME keeps recording until the key fires again, so the click
 * that stops it goes through the same button. Purely cosmetic — recording is owned by the external command. */
const LISTENING_MS = 60_000;

/**
 * Fires the person's configured voice-input command (Settings → System). The command typically synthesizes the
 * IME's voice hotkey, so the dictated text lands in the focused input box — keep the textarea focused by never
 * taking focus on click (`onMouseDown` preventDefault).
 */
const VoiceInputButton: React.FC = () => {
  const { t } = useTranslation();
  const [command, setCommand] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const read = () => {
      const value = configService.get(SETTING_KEY);
      setCommand(typeof value === 'string' && value.trim() ? value.trim() : null);
    };
    read();
    // The backend's settings may still be loading when this mounts; re-read once they arrive (initialize itself
    // does not notify subscribers — only later writes do).
    let cancelled = false;
    void configService.whenReady().then(() => {
      if (!cancelled) read();
    });
    const unsubscribe = configService.subscribe(SETTING_KEY, read);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const trigger = useCallback(async () => {
    // Hands-free IMEs record until the hotkey fires again: one click starts, the next stops. The command itself
    // knows which half it is sending; the button only mirrors it.
    setListening((was) => !was);
    setError(null);
    try {
      const keyId = configService.get('system.voiceInputKey') ?? undefined;
      const result = await ipcBridge.systemSettings.runVoiceCommand.invoke({ command: command ?? undefined, keyId });
      if (!result.ok) setError(result.error ?? 'command failed');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [command]);

  // Safety net: never leave the button stuck "listening" (a pure click-to-talk command needs no stop click).
  useEffect(() => {
    if (!listening) return;
    const timer = setTimeout(() => setListening(false), LISTENING_MS);
    return () => clearTimeout(timer);
  }, [listening]);

  // The mic always shows on desktop: with no configured command it taps right Ctrl (the IME voice hotkey).
  if (!isElectronDesktop()) return null;

  const tooltip = error
    ? t('conversation.sendbox.voiceInputError', { defaultValue: 'Voice input failed: {{error}}', error })
    : listening
      ? t('conversation.sendbox.voiceInputStop', { defaultValue: 'Voice input is running — click again to stop' })
      : t('conversation.sendbox.voiceInput', { defaultValue: 'Voice input' });

  return (
    <Tooltip content={tooltip} position='top'>
      <Button
        shape='circle'
        type='text'
        className='sendbox-voice-input-button'
        icon={<Microphone theme={listening ? 'filled' : 'outline'} size='18' fill={listening ? '#f53f3f' : iconColors.secondary} />}
        onMouseDown={(e) => e.preventDefault()}
        onClick={trigger}
        data-testid='sendbox-voice-input-btn'
        aria-label={tooltip}
      />
    </Tooltip>
  );
};

export default VoiceInputButton;
