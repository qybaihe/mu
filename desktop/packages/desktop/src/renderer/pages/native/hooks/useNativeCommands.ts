/**
 * pi's slash commands for a native conversation's `/` menu (`get_commands`: mu's and its extensions' own, prompt
 * templates, skills). Asked once each time a host is running, and when the person starts a command in a conversation
 * whose list is not known yet (that starts the host: the command needs it to run anyway).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SlashCommandItem } from '@/common/chat/slash/types';
import type { NativeHostStatus, NativeResult } from '@/common/kyrn/nativeBridge';
import type { PiCommand } from '@/common/utils/nativeHost';
import { extensionCommandNames, slashItems } from '../components/composer/composerModel';

/** The `/` menu's items, and the names of the commands an extension answers itself (composerModel.ts). */
export type NativeCommands = { items: SlashCommandItem[]; extensions: ReadonlySet<string> };

const NONE: NativeCommands = { items: [], extensions: new Set() };

export function useNativeCommands(
  host: NativeHostStatus,
  draft: string,
  request: (command: PiCommand) => Promise<NativeResult<unknown>>
): NativeCommands {
  const [commands, setCommands] = useState<NativeCommands>(NONE);
  // Asked for the host that runs now: a host started again may have other commands.
  const asked = useRef(false);

  const load = useCallback(async () => {
    if (asked.current) return;
    asked.current = true;
    const result = await request({ type: 'get_commands' });
    if (result.ok === false) {
      asked.current = false;
      return;
    }
    setCommands({ items: slashItems(result.data), extensions: extensionCommandNames(result.data) });
  }, [request]);

  useEffect(() => {
    if (host.phase !== 'running') return;
    asked.current = false;
    void load();
  }, [host.phase, load]);

  const starting = draft.startsWith('/');
  useEffect(() => {
    if (starting && commands.items.length === 0) void load();
  }, [commands.items.length, load, starting]);

  return commands;
}
