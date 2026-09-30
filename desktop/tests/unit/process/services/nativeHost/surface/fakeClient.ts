import type {
  NativeAttentionEvent,
  NativeChangedEvent,
  NativeConversation,
  NativeHostStatus,
  NativeRecordEvent,
  NativeReplacedEvent,
  NativeResult,
  NativeStatusEvent,
} from '@/common/kyrn/nativeBridge';
import {
  emptyView,
  reduce,
  type NativeView,
  type PiCommand,
  type PiRecord,
  type SessionSettings,
} from '@/common/utils/nativeHost';
import type { NativeClient } from '@/renderer/pages/native/utils/nativeClient';

/**
 * An in-memory native host for the screens' tests: it holds each conversation's view as the main process would
 * (every record folded with the same reducer, numbered), answers `open` with it, and pushes records, statuses and
 * changes to whoever listens. What a command answers is up to the test (`answer`), and every call is kept (`calls`).
 */

type Hosted = {
  conversation: NativeConversation;
  view: NativeView;
  seq: number;
  status: NativeHostStatus;
  /** What `open` says the session file runs with (the snapshot's `session`). */
  session?: SessionSettings;
};
type Call = {
  method: string;
  id?: string;
  command?: PiCommand;
  dialogId?: string;
  answer?: unknown;
  cwd?: string;
  permissions?: string;
  name?: string;
};

export type FakeHost = {
  client: NativeClient;
  calls: Call[];
  /** A conversation the host knows, with the view it has so far, and what its file says it runs with. */
  add: (
    conversation: Partial<NativeConversation> & { id: string },
    view?: NativeView,
    session?: SessionSettings
  ) => void;
  /**
   * pi writes a record: folded into the host's view and pushed, numbered. Returns its number. A `quiet` one reaches
   * no window, as records a window missed.
   */
  push: (id: string, record: PiRecord, quiet?: boolean) => number;
  play: (id: string, records: readonly PiRecord[]) => void;
  /** A record pushed with a number of the test's choosing, and not folded: a replay, a gap. */
  pushRaw: (event: NativeRecordEvent) => void;
  setStatus: (id: string, status: NativeHostStatus) => void;
  replace: (id: string, view: NativeView) => void;
  change: (event: NativeChangedEvent) => void;
  /** The main process says a conversation wants its person (a run ended, a question). */
  attend: (event: NativeAttentionEvent) => void;
  /** How `request` answers a command; by default every command succeeds with no data. */
  answer: (handler: Answer) => void;
  /** Whether the host is on. */
  enable: (on: boolean) => void;
  /** The folder the person picks next; undefined when they pick none. */
  pick: (folder: string | undefined) => void;
  seqOf: (id: string) => number;
  viewOf: (id: string) => NativeView;
};

type Answer = (id: string, command: PiCommand) => NativeResult<unknown> | Promise<NativeResult<unknown>>;

const succeed: Answer = () => ({ ok: true, data: undefined });

const listen =
  <T>(set: Set<(event: T) => void>) =>
  (listener: (event: T) => void) => {
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };

const unknown = (id: string) =>
  ({ ok: false, kind: 'unknown-conversation', message: `No conversation ${id}` }) as const;

export function createFakeHost(): FakeHost {
  const hosted = new Map<string, Hosted>();
  const calls: Call[] = [];
  const records = new Set<(event: NativeRecordEvent) => void>();
  const statuses = new Set<(event: NativeStatusEvent) => void>();
  const replacements = new Set<(event: NativeReplacedEvent) => void>();
  const changes = new Set<(event: NativeChangedEvent) => void>();
  const attentions = new Set<(event: NativeAttentionEvent) => void>();
  let on = true;
  let picked: string | undefined;
  let handler: Answer = succeed;
  const get = (id: string): Hosted => {
    const found = hosted.get(id);
    if (!found) throw new Error(`The fake host has no conversation ${id}`);
    return found;
  };

  const client: NativeClient = {
    enabled: async () => on,
    list: async () => {
      calls.push({ method: 'list' });
      return { ok: true, data: [...hosted.values()].map((each) => each.conversation) };
    },
    create: async (cwd, permissions) => {
      calls.push({ method: 'create', cwd, ...(permissions ? { permissions } : {}) });
      const conversation: NativeConversation = {
        id: `draft-${hosted.size + 1}`,
        cwd,
        title: '',
        createdAt: 1,
        updatedAt: 1,
        live: false,
      };
      hosted.set(conversation.id, { conversation, view: emptyView(), seq: 0, status: { phase: 'idle' } });
      for (const listener of changes) listener({ conversation });
      return { ok: true, data: conversation };
    },
    open: async (id) => {
      calls.push({ method: 'open', id });
      const found = hosted.get(id);
      if (!found) return unknown(id);
      return {
        ok: true,
        data: {
          conversation: found.conversation,
          status: found.status,
          seq: found.seq,
          view: found.view,
          ...(found.session ? { session: found.session } : {}),
        },
      };
    },
    request: async (id, command) => {
      calls.push({ method: 'request', id, command });
      if (!hosted.has(id)) return unknown(id);
      return handler(id, command);
    },
    respond: async (id, dialogId, answer) => {
      calls.push({ method: 'respond', id, dialogId, answer });
      if (!hosted.has(id)) return unknown(id);
      return { ok: true, data: undefined };
    },
    close: async (id) => {
      calls.push({ method: 'close', id });
      return { ok: true, data: undefined };
    },
    remove: async (id) => {
      calls.push({ method: 'remove', id });
      hosted.delete(id);
      for (const listener of changes) listener({ removed: id });
      return { ok: true, data: undefined };
    },
    rename: async (id, name) => {
      calls.push({ method: 'rename', id, name });
      const found = hosted.get(id);
      if (!found) return unknown(id);
      found.conversation = { ...found.conversation, title: name };
      for (const listener of changes) listener({ conversation: found.conversation });
      return { ok: true, data: undefined };
    },
    onRecord: listen(records),
    onStatus: listen(statuses),
    onReplaced: listen(replacements),
    onChanged: listen(changes),
    onAttention: listen(attentions),
    pickFolder: async () => {
      calls.push({ method: 'pickFolder' });
      return picked;
    },
  };

  const push = (id: string, record: PiRecord, quiet = false): number => {
    const found = get(id);
    found.seq += 1;
    found.view = reduce(found.view, record);
    if (!quiet) for (const listener of records) listener({ id: found.conversation.id, seq: found.seq, record });
    return found.seq;
  };

  return {
    client,
    calls,
    add: (conversation, view = emptyView(), session) => {
      hosted.set(conversation.id, {
        conversation: { cwd: '/project', title: '', createdAt: 1, updatedAt: 1, live: false, ...conversation },
        view,
        seq: 0,
        status: { phase: 'idle' },
        ...(session ? { session } : {}),
      });
    },
    push,
    play: (id, list) => {
      for (const record of list) push(id, record);
    },
    pushRaw: (event) => {
      for (const listener of records) listener(event);
    },
    setStatus: (id, status) => {
      get(id).status = status;
      for (const listener of statuses) listener({ id, status });
    },
    replace: (id, view) => {
      const found = get(id);
      found.view = view;
      found.seq += 1;
      for (const listener of replacements) listener({ id, seq: found.seq, view, conversation: found.conversation });
    },
    change: (event) => {
      if (!('removed' in event)) {
        const old = event.replaces ? hosted.get(event.replaces) : hosted.get(event.conversation.id);
        if (event.replaces) hosted.delete(event.replaces);
        hosted.set(event.conversation.id, {
          view: old?.view ?? emptyView(),
          seq: old?.seq ?? 0,
          status: old?.status ?? { phase: 'idle' },
          conversation: event.conversation,
        });
      }
      for (const listener of changes) listener(event);
    },
    attend: (event) => {
      for (const listener of attentions) listener(event);
    },
    answer: (next) => {
      handler = next;
    },
    enable: (value) => {
      on = value;
    },
    pick: (folder) => {
      picked = folder;
    },
    seqOf: (id) => get(id).seq,
    viewOf: (id) => get(id).view,
  };
}
