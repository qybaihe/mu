/**
 * The computer stays awake while a conversation runs: a long run is not cut short because nobody touched the keyboard.
 * Only idle sleep is held off (the display may still turn off, a closed lid still sleeps), and only while something
 * runs: a native conversation's run, or a classic conversation's reply. On unless the person turns it off in the
 * system settings (`system.keepAwakeWhileRunning`). Mounted once, with the layout; the main process holds the lock.
 */
import { useEffect, useState } from 'react';
import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';
import { useConversationActivitySets } from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';
import { useNativeConversations, useNativeEnabled } from '@/renderer/pages/native/hooks/useNativeConversations';
import { isElectronDesktop } from '@/renderer/utils/platform';

const SETTING = 'system.keepAwakeWhileRunning';

/** Whether the person keeps the computer awake during runs: on unless turned off, followed as it changes. */
export function useKeepAwakeSetting(): boolean {
  const [on, setOn] = useState(() => configService.get(SETTING) !== false);
  useEffect(() => {
    setOn(configService.get(SETTING) !== false);
    return configService.subscribe(SETTING, (value) => setOn(value !== false));
  }, []);
  return on;
}

export function useKeepAwakeWhileRunning(): void {
  const wanted = useKeepAwakeSetting();
  const { conversations } = useNativeConversations(useNativeEnabled() === true);
  const { generatingConversationIds } = useConversationActivitySets();
  const running = conversations.some((conversation) => conversation.running) || generatingConversationIds.size > 0;
  const on = wanted && running;
  useEffect(() => {
    if (!isElectronDesktop()) return;
    void ipcBridge.systemSettings.keepAwakeWhileRunning.invoke({ on }).catch(() => {
      // An older main process cannot hold the computer awake: the run goes on as before.
    });
  }, [on]);
}
