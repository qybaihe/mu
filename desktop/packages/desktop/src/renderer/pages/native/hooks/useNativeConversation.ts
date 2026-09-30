/**
 * One native conversation as a screen holds it: the main process's snapshot (`open`), then every record that follows,
 * folded with the reducer the main process uses, so this window's view is the main process's view. A window that
 * reloads, or a second one, opens the conversation again and shows the same, run in progress included.
 *
 * Records come numbered: one at or below the view's number is in it already, and one that skips a number means some
 * were missed, so the conversation is opened again. Records that arrive while `open` is answered are held and folded
 * after the snapshot. A draft's id that its session's id replaces (`changed` with `replaces`), and a session's id that a
 * fork or a `/new` moves the conversation from, is followed, not reopened; the session it left is a conversation of
 * its own from then on, which the list announces, and which opening it by its id shows afresh.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  NativeConversation,
  NativeFailure,
  NativeHostStatus,
  NativeRecordEvent,
  NativeResult,
} from '@/common/kyrn/nativeBridge';
import {
  emptyView,
  reduce,
  type DialogAnswer,
  type NativeView,
  type PiCommand,
  type PiImage,
  type SessionSettings,
} from '@/common/utils/nativeHost';
import { useNativeClient } from '../utils/nativeClient';
import { isWorking } from '../utils/statusRow';
import type { OutgoingMessage } from '../utils/toMessages';

/**
 * How a message sent while a run goes reaches it: at its next step, or after it. It goes as a prompt with pi's
 * `streamingBehavior`, so a run that ended just before it arrived is started by it instead of leaving it queued.
 */
export type SendMode = 'steer' | 'followUp';

export type NativeConversationState = {
  /** The conversation's id now: a draft's id gives way to its session's. */
  id: string;
  /** The snapshot has not come yet. */
  loading: boolean;
  /** The conversation could not be opened. */
  failure?: NativeFailure;
  conversation?: NativeConversation;
  host: NativeHostStatus;
  view: NativeView;
  /** The number of the last record in `view`. */
  seq: number;
  /**
   * Which view this is: a new number each time the whole view is replaced (opened, rebuilt by the host, another
   * conversation), never one that a record folded in. A message's id names one message only within one epoch; two
   * sessions both have an `m161`.
   */
  epoch: number;
  /** A prompt the person sent that is not in the conversation yet: pi takes it once Jev has classified it. */
  outgoing?: OutgoingMessage & { users: number };
  /** The last command that failed for a reason the view cannot show (the host could not start, a timeout, …). */
  commandFailure?: NativeFailure;
  /** Dialogs this window answered or let run out, gone before the record that says so arrives. */
  closed: ReadonlySet<string>;
  /**
   * What the session file said the conversation runs with when it was opened with no host (the snapshot's
   * `session`): the model, thinking level and permission mode the next message meets. A running host says them in
   * the view instead.
   */
  settings?: SessionSettings;
};

export type NativeConversationApi = {
  /**
   * What names the conversation on screen: the id it was first opened by, made another (`<id>#<n>`) when the screen
   * opens an id it had left behind, which is another conversation. It stays when a draft's id gives way to its
   * session's, so what belongs to one conversation on screen (a draft in the send box) can be keyed by it.
   */
  key: string;
  /** Opens the conversation again, after it could not be opened. */
  retry: () => void;
  /**
   * A prompt, with the images the person attached; while a run goes, a steering or follow-up message. `command`: the
   * text runs a command an extension answers itself (mu's `/goal …`), which adds no message of the person's: it is no
   * longer on its way once pi took it, whether or not it starts a run.
   */
  send: (
    text: string,
    mode?: SendMode,
    images?: PiImage[],
    options?: { command?: boolean }
  ) => Promise<NativeResult<unknown>>;
  /** Stops the run, or the prompt Jev is still classifying. */
  abort: () => Promise<NativeResult<unknown>>;
  respond: (dialogId: string, answer: DialogAnswer) => Promise<NativeResult<void>>;
  /** A dialog whose time ran out: pi took its default, and says nothing of it. */
  expire: (dialogId: string) => void;
  request: (command: PiCommand) => Promise<NativeResult<unknown>>;
  /** Forgets the last failed command, once the person has read it. */
  clearFailure: () => void;
  /** Names the conversation (the main process: pi's `set_session_name`, or the file); the new title comes as a change. */
  rename: (name: string) => Promise<NativeResult<void>>;
};

const IDLE: NativeHostStatus = { phase: 'idle' };

let epochs = 0;

const initial = (id: string): NativeConversationState => ({
  id,
  loading: true,
  host: IDLE,
  view: emptyView(),
  seq: 0,
  epoch: ++epochs,
  closed: new Set(),
});

const userCount = (view: NativeView): number => view.messages.filter((message) => message.role === 'user').length;

/** The state with the outgoing prompt gone once the conversation has it. */
function settleOutgoing(state: NativeConversationState): NativeConversationState {
  if (!state.outgoing || userCount(state.view) <= state.outgoing.users) return state;
  const { outgoing: _taken, ...rest } = state;
  return rest;
}

let sent = 0;

/**
 * What a screen holds of the conversation it shows: the id it opened it by (`first`), the ids that are that conversation
 * now (`ids`), and how many conversations the screen has shown (`n`), which makes opening an id it left behind another
 * one.
 */
type Followed = { key: string; first: string; ids: Set<string>; n: number };

const follow = (id: string, n: number): Followed => ({
  key: n === 0 ? id : `${id}#${n}`,
  first: id,
  ids: new Set([id]),
  n,
});

export function useNativeConversation(requestedId: string): NativeConversationState & NativeConversationApi {
  const client = useNativeClient();
  const [state, setState] = useState<NativeConversationState>(() => initial(requestedId));
  const latest = useRef(state);
  // The ids this conversation has had: a route that follows a draft's new id is the same conversation. Once the route
  // has caught up, the ids before are not: a session the conversation moved on from (a fork) is a conversation of its
  // own, and the route to it opens it.
  const followed = useRef<Followed>(follow(requestedId, 0));
  if (!followed.current.ids.has(requestedId)) followed.current = follow(requestedId, followed.current.n + 1);
  if (requestedId === latest.current.id && followed.current.ids.size > 1) followed.current.ids = new Set([requestedId]);
  const key = followed.current.key;
  // The effect's own `open`, for `retry`.
  const reopen = useRef<(() => Promise<void>) | undefined>(undefined);
  const commit = useCallback((change: (old: NativeConversationState) => NativeConversationState) => {
    const next = change(latest.current);
    if (next === latest.current) return;
    latest.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    const mine = followed.current;
    const has = (id: string): boolean => mine.ids.has(id);
    let disposed = false;
    // Records that came before the snapshot: folded once it is in.
    let held: NativeRecordEvent[] | undefined = [];
    // Another conversation in the same screen: nothing of the last one stays.
    if (latest.current.id !== mine.first) commit(() => initial(mine.first));

    const open = async (): Promise<void> => {
      held = held ?? [];
      const result = await client.open(latest.current.id);
      if (disposed) return;
      const waiting = held ?? [];
      held = undefined;
      if (result.ok === false) {
        commit((old) => ({ ...old, loading: false, failure: result }));
        return;
      }
      const { conversation, status, session } = result.data;
      let { seq, view } = result.data;
      for (const event of waiting)
        if (event.seq === seq + 1) {
          view = reduce(view, event.record);
          seq = event.seq;
        }
      commit((old) =>
        settleOutgoing({
          ...old,
          loading: false,
          failure: undefined,
          conversation,
          host: status,
          view,
          seq,
          epoch: ++epochs,
          settings: session,
        })
      );
    };

    const fold = (event: NativeRecordEvent): void => {
      if (held) {
        held.push(event);
        return;
      }
      const old = latest.current;
      if (old.failure || event.seq <= old.seq) return;
      if (event.seq > old.seq + 1) {
        // Some records never came: the snapshot has them.
        void open();
        return;
      }
      commit((current) => settleOutgoing({ ...current, view: reduce(current.view, event.record), seq: event.seq }));
    };

    const stops = [
      client.onRecord((event) => {
        if (has(event.id)) fold(event);
      }),
      client.onStatus((event) => {
        if (has(event.id)) commit((old) => ({ ...old, host: event.status }));
      }),
      client.onReplaced((event) => {
        if (!has(event.id)) return;
        held = undefined;
        commit((old) =>
          settleOutgoing({
            ...old,
            view: event.view,
            seq: event.seq,
            epoch: ++epochs,
            conversation: event.conversation,
            closed: new Set(),
          })
        );
      }),
      client.onChanged((event) => {
        if ('removed' in event) {
          if (has(event.removed))
            commit((old) => ({
              ...old,
              failure: {
                ok: false,
                kind: 'unknown-conversation',
                message: `Conversation ${event.removed} was removed`,
              },
            }));
          return;
        }
        const { conversation, replaces } = event;
        if (replaces && has(replaces)) mine.ids.add(conversation.id);
        // Not a move of this conversation: a session it moved on from is announced as a conversation of its own, and
        // is no change to this one.
        else if (conversation.id !== latest.current.id) return;
        if (has(conversation.id)) commit((old) => ({ ...old, id: conversation.id, conversation }));
      }),
    ];
    reopen.current = open;
    void open();
    return () => {
      disposed = true;
      reopen.current = undefined;
      for (const stop of stops) stop();
    };
  }, [client, commit, key]);

  const retry = useCallback(() => {
    const open = reopen.current;
    if (!open) return;
    commit((old) => ({ ...old, loading: true, failure: undefined }));
    void open();
  }, [commit]);

  // A prompt stopped while Jev classified it may still start its run once pi takes it: stop that run too.
  const stopTaken = useRef(false);

  const fail = useCallback(
    <T>(result: NativeResult<T>): NativeResult<T> => {
      if (result.ok === false) commit((old) => ({ ...old, commandFailure: result }));
      return result;
    },
    [commit]
  );

  const request = useCallback(
    async (command: PiCommand) => fail(await client.request(latest.current.id, command)),
    [client, fail]
  );

  const send = useCallback(
    async (
      text: string,
      mode: SendMode = 'steer',
      images: PiImage[] = [],
      options: { command?: boolean } = {}
    ): Promise<NativeResult<unknown>> => {
      const now = latest.current;
      const attached = images.length > 0 ? { images } : {};
      if (isWorking(now.view)) return request({ type: 'prompt', message: text, ...attached, streamingBehavior: mode });
      sent += 1;
      const outgoing = {
        id: `outgoing-${sent}`,
        text,
        at: Date.now(),
        users: userCount(now.view),
        ...(images.length ? { images: images.map(({ mimeType, data }) => ({ mimeType, data })) } : {}),
      };
      stopTaken.current = false;
      commit((old) => ({ ...old, outgoing, commandFailure: undefined }));
      const result = await client.request(now.id, { type: 'prompt', message: text, ...attached });
      if (result.ok === false) {
        stopTaken.current = false;
        // pi refusing the prompt is a record the view shows; anything else is said here.
        commit((old) => {
          const next = { ...old };
          if (old.outgoing?.id === outgoing.id) delete next.outgoing;
          if (result.kind !== 'command') next.commandFailure = result;
          return next;
        });
        return result;
      }
      if (stopTaken.current) {
        stopTaken.current = false;
        await client.request(latest.current.id, { type: 'abort' });
      }
      const taken = () =>
        commit((old) => {
          if (old.outgoing?.id !== outgoing.id) return old;
          const { outgoing: _answered, ...rest } = old;
          return rest;
        });
      if (options.command) {
        taken();
        return result;
      }
      // A command an extension answers itself (`/lessons`) starts no run and adds no message: pi, asked, says it
      // runs nothing, and the prompt is no longer on its way.
      if (latest.current.outgoing?.id === outgoing.id && !isWorking(latest.current.view)) {
        const asked = await client.request(latest.current.id, { type: 'get_state' });
        const busy = asked.ok && (asked.data as { isStreaming?: unknown; isCompacting?: unknown } | undefined);
        if (!busy || (busy.isStreaming !== true && busy.isCompacting !== true)) taken();
      }
      return result;
    },
    [client, commit, request]
  );

  const abort = useCallback(async () => {
    if (latest.current.outgoing) stopTaken.current = true;
    return request({ type: 'abort' });
  }, [request]);

  const respond = useCallback(
    async (dialogId: string, answer: DialogAnswer) => {
      commit((old) => ({ ...old, closed: new Set([...old.closed, dialogId]) }));
      const result = await client.respond(latest.current.id, dialogId, answer);
      if (result.ok === false)
        commit((old) => {
          const closed = new Set(old.closed);
          closed.delete(dialogId);
          return { ...old, closed, commandFailure: result };
        });
      return result;
    },
    [client, commit]
  );

  const expire = useCallback(
    (dialogId: string) => commit((old) => ({ ...old, closed: new Set([...old.closed, dialogId]) })),
    [commit]
  );

  const clearFailure = useCallback(
    () =>
      commit((old) => {
        if (!old.commandFailure) return old;
        const { commandFailure: _read, ...rest } = old;
        return rest;
      }),
    [commit]
  );

  const rename = useCallback((name: string) => client.rename(latest.current.id, name), [client]);

  return useMemo(
    () => ({ ...state, key, retry, send, abort, respond, expire, request, clearFailure, rename }),
    [state, key, retry, send, abort, respond, expire, request, clearFailure, rename]
  );
}
