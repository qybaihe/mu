/**
 * What the native screens ask the main process, as plain functions over the native bridge (common/kyrn/nativeBridge.ts).
 * The screens take it from a context, so a test hands them a client of its own (an in-memory host) instead of the IPC.
 */
import { createContext, useContext } from 'react';
import { ipcBridge } from '@/common';
import {
  nativeBridge,
  type NativeAttentionEvent,
  type NativeChangedEvent,
  type NativeConversation,
  type NativeRecordEvent,
  type NativeReplacedEvent,
  type NativeResult,
  type NativeSnapshot,
  type NativeStatusEvent,
} from '@/common/kyrn/nativeBridge';
import type { DialogAnswer, PiCommand } from '@/common/utils/nativeHost';
import { isElectronDesktop } from '@/renderer/utils/platform';

export type NativeClient = {
  enabled: () => Promise<boolean>;
  list: () => Promise<NativeResult<NativeConversation[]>>;
  /** A new conversation in `cwd`; `permissions` is the mode its mu starts in (mu's own default when left out). */
  create: (cwd: string, permissions?: string) => Promise<NativeResult<NativeConversation>>;
  open: (id: string) => Promise<NativeResult<NativeSnapshot>>;
  request: (id: string, command: PiCommand) => Promise<NativeResult<unknown>>;
  respond: (id: string, dialogId: string, answer: DialogAnswer) => Promise<NativeResult<void>>;
  close: (id: string) => Promise<NativeResult<void>>;
  remove: (id: string) => Promise<NativeResult<void>>;
  /** Names a conversation; its new title comes as a change. */
  rename: (id: string, name: string) => Promise<NativeResult<void>>;
  /** Each returns the function that stops listening. */
  onRecord: (listener: (event: NativeRecordEvent) => void) => () => void;
  onStatus: (listener: (event: NativeStatusEvent) => void) => () => void;
  onReplaced: (listener: (event: NativeReplacedEvent) => void) => () => void;
  onChanged: (listener: (event: NativeChangedEvent) => void) => () => void;
  /** A conversation wants its person: a run ended, or pi asks something (see NativeAttentionEvent). */
  onAttention: (listener: (event: NativeAttentionEvent) => void) => () => void;
  /** Asks the person for a project folder; undefined when they chose none. */
  pickFolder: () => Promise<string | undefined>;
};

/**
 * The client over the app's IPC. The native host is for the desktop app's own window: a browser on the WebUI has no
 * folder dialog, notification or bin of the native screens' kind, and nothing has tested them there, so it stays on the
 * classic path (`enabled` is false without asking).
 */
export const bridgeClient: NativeClient = {
  enabled: () => (isElectronDesktop() ? nativeBridge.enabled.invoke() : Promise.resolve(false)),
  list: () => nativeBridge.list.invoke(),
  create: (cwd, permissions) => nativeBridge.create.invoke(permissions ? { cwd, permissions } : { cwd }),
  open: (id) => nativeBridge.open.invoke({ id }),
  request: (id, command) => nativeBridge.request.invoke({ id, command }),
  respond: (id, dialogId, answer) => nativeBridge.respond.invoke({ id, dialogId, answer }),
  close: (id) => nativeBridge.close.invoke({ id }),
  remove: (id) => nativeBridge.remove.invoke({ id }),
  rename: (id, name) => nativeBridge.rename.invoke({ id, name }),
  onRecord: (listener) => nativeBridge.records.on(listener),
  onStatus: (listener) => nativeBridge.status.on(listener),
  onReplaced: (listener) => nativeBridge.replaced.on(listener),
  onChanged: (listener) => nativeBridge.changed.on(listener),
  onAttention: (listener) => nativeBridge.attention.on(listener),
  pickFolder: async () =>
    (await ipcBridge.dialog.showOpen.invoke({ properties: ['openDirectory', 'createDirectory'] }))?.[0],
};

export const NativeClientContext = createContext<NativeClient>(bridgeClient);

export const useNativeClient = (): NativeClient => useContext(NativeClientContext);
