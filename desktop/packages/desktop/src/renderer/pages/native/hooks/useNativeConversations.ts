/**
 * The native conversations for the sidebar: the main process's list, newest first, kept as it changes (`changed`: a new
 * conversation, a title, a host that starts or ends, a draft whose session gave it its id, one removed), and read
 * again when the window comes back to the front: a session the command line made meanwhile has no `changed` (nothing
 * in this app made it). And whether the native host is on at all: with it off, no native screen exists.
 */
import { useEffect, useState } from 'react';
import type { NativeChangedEvent, NativeConversation, NativeFailure } from '@/common/kyrn/nativeBridge';
import { useNativeClient, type NativeClient } from '../utils/nativeClient';

export type NativeConversationList = {
  conversations: NativeConversation[];
  loading: boolean;
  failure?: NativeFailure;
};

const newestFirst = (list: NativeConversation[]): NativeConversation[] =>
  list.toSorted((a, b) => b.updatedAt - a.updatedAt);

/** The list is not read again for a window that comes back sooner than this after the last read. */
const REREAD_MS = 1000;

export function useNativeConversations(enabled: boolean): NativeConversationList {
  const client = useNativeClient();
  const [list, setList] = useState<NativeConversationList>({ conversations: [], loading: enabled });
  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    // Changes that come while the list is read are applied to it once it is in.
    const early: NativeChangedEvent[] = [];
    let read = false;
    let reading = false;
    let readAt = 0;
    const apply = (conversations: NativeConversation[], event: NativeChangedEvent): NativeConversation[] => {
      if ('removed' in event) return conversations.filter((each) => each.id !== event.removed);
      const others = conversations.filter((each) => each.id !== event.conversation.id && each.id !== event.replaces);
      return newestFirst([...others, event.conversation]);
    };
    const stop = client.onChanged((event) => {
      if (!read) {
        early.push(event);
        return;
      }
      // Read again meanwhile: the answer may have been made before this change, so it is applied to that too.
      if (reading) early.push(event);
      setList((old) => ({ ...old, conversations: apply(old.conversations, event) }));
    });
    const load = () => {
      reading = true;
      readAt = Date.now();
      void client.list().then((result) => {
        reading = false;
        if (disposed) return;
        const changes = early.splice(0);
        if (result.ok === false) {
          // The first read that fails says so; a later one leaves the list as it was.
          if (!read) setList({ conversations: [], loading: false, failure: result });
          read = true;
          return;
        }
        read = true;
        setList({ conversations: changes.reduce(apply, newestFirst(result.data)), loading: false });
      });
    };
    setList((old) => ({ ...old, loading: true }));
    load();
    const back = () => {
      if (!read || reading || document.visibilityState === 'hidden' || Date.now() - readAt < REREAD_MS) return;
      load();
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      disposed = true;
      stop();
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, [client, enabled]);
  return list;
}

/**
 * Whether the native host is on, as the main process says once per window: undefined until it has said. A main
 * process that does not answer at all (one without the native host) leaves it undefined, which shows nothing.
 */
let known: Promise<boolean> | undefined;
let knownFor: NativeClient | undefined;
/** The answer once it came, so a screen drawn later has it at once. */
let answered: boolean | undefined;

export function useNativeEnabled(): boolean | undefined {
  const client = useNativeClient();
  const [enabled, setEnabled] = useState<boolean | undefined>(() => (knownFor === client ? answered : undefined));
  useEffect(() => {
    let disposed = false;
    if (!known || knownFor !== client) {
      knownFor = client;
      answered = undefined;
      const asking = client.enabled().then(
        (on) => on === true,
        () => false
      );
      known = asking;
      void asking.then((on) => {
        if (known === asking) answered = on;
      });
    }
    void known.then((on) => {
      if (!disposed) setEnabled(on);
    });
    return () => {
      disposed = true;
    };
  }, [client]);
  return enabled;
}
