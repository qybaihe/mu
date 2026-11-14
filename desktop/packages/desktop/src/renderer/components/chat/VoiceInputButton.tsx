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
import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

const COMMAND_KEY = 'system.voiceInputCommand';
const KEY_ID_KEY = 'system.voiceInputKey';

/**
 * Push-to-talk mic for the send box. Press-and-hold presses the IME voice hotkey (right Ctrl by default: WeType
 * and most Chinese IMEs ship with it), release lifts it — so the IME records exactly while the button is down and
 * types the transcript into the focused textarea. A configured external command (Settings → System) runs instead,
 * once, on press. The button never takes focus (`onPointerDown` preventDefault): the dictated text must land in
 * the textarea the person was typing in.
 */
const VoiceInputButton: React.FC = () => {
  const { t } = useTranslation();
  const [pressed, setPressed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const holdingRef = useRef(false); // refuse releases we did not initiate (pointerup without a press)

  const fire = useCallback(async (action: 'down' | 'up') => {
    try {
      const command = configService.get(COMMAND_KEY);
      const keyId = configService.get(KEY_ID_KEY);
      const result = await ipcBridge.systemSettings.runVoiceCommand.invoke({
        command: typeof command === 'string' && command.trim() ? command : undefined,
        keyId: typeof keyId === 'string' ? keyId : undefined,
        action,
      });
      if (!result.ok) setError(result.error ?? 'command failed');
      else setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Settings (command / key) are read at press time, so nothing to subscribe to: the button reads fresh every press.

  // The mic always shows on desktop: with no configured command it presses the configured key (the IME voice hotkey).
  if (!isElectronDesktop()) return null;

  const tooltip = error
    ? t('conversation.sendbox.voiceInputError', { defaultValue: 'Voice input failed: {{error}}', error })
    : t('conversation.sendbox.voiceInputHold', { defaultValue: 'Hold to talk, release to send' });

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault(); // keep the textarea focused — the transcript types into it
    event.currentTarget.setPointerCapture(event.pointerId); // release lands on us even if dragged away
    if (holdingRef.current) return;
    holdingRef.current = true;
    setPressed(true);
    void fire('down');
  };

  const release = () => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    setPressed(false);
    void fire('up');
  };

  return (
    <Tooltip content={tooltip} position='top'>
      <Button
        shape='circle'
        type='text'
        className='sendbox-voice-input-button'
        icon={<Microphone theme={pressed ? 'filled' : 'outline'} size='18' fill={pressed ? '#f53f3f' : iconColors.secondary} />}
        onPointerDown={onPointerDown}
        onPointerUp={release}
        onPointerCancel={release}
        data-testid='sendbox-voice-input-btn'
        aria-label={tooltip}
      />
    </Tooltip>
  );
};

export default VoiceInputButton;
