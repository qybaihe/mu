/**
 * The Jev panel's record of the native conversation on screen. The native page publishes what its view holds here
 * (`toActivity`), and the work panel reads it for that conversation instead of asking the main process for the mu
 * bridge's telemetry, which a native conversation does not have. One conversation at a time: the one on screen. With
 * it, the folder the conversation works in (`cwd`), once known: the panel's lessons and files are read by it.
 */
import { useSyncExternalStore } from 'react';
import type { KyrnActivity } from '@/renderer/pages/conversation/KyrnPanel';

type Published = { conversationId: string; activity: KyrnActivity; cwd?: string };

let published: Published | undefined;
const listeners = new Set<() => void>();

/** What the native page on screen holds, or undefined once it is gone. */
export function publishNativeActivity(next: Published | undefined): void {
  if (
    next?.conversationId === published?.conversationId &&
    next?.activity === published?.activity &&
    next?.cwd === published?.cwd
  )
    return;
  published = next;
  for (const listener of listeners) listener();
}

/** Ends what a page published, unless another page has published since. */
export function withdrawNativeActivity(conversationId: string): void {
  if (published?.conversationId === conversationId) publishNativeActivity(undefined);
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const read = (): Published | undefined => published;

/** The activity of a native conversation on screen, or undefined for any other conversation. */
export function useNativeActivity(conversationId: string | null): KyrnActivity | undefined {
  const current = useSyncExternalStore(subscribe, read, read);
  return conversationId && current?.conversationId === conversationId ? current.activity : undefined;
}

/** The folder of the native conversation on screen, once known; undefined for any other conversation. */
export function useNativeFolder(conversationId: string | null): string | undefined {
  const current = useSyncExternalStore(subscribe, read, read);
  return conversationId && current?.conversationId === conversationId ? current.cwd : undefined;
}
