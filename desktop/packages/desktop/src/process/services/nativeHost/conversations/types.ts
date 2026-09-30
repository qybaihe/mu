import type {
  NativeAttentionEvent,
  NativeChangedEvent,
  NativeConversation,
  NativeRecordEvent,
  NativeReplacedEvent,
  NativeSnapshot,
  NativeStatusEvent,
} from '../../../../common/kyrn/nativeBridge.ts';
import type { DialogAnswer, PiCommand } from '../../../../common/utils/nativeHost/records.ts';
import type { NativeHost } from '../NativeHost.ts';

/** A running host as a conversation uses it: NativeHost in the app, a stand-in in tests. */
export type ConversationHost = Pick<
  NativeHost,
  'state' | 'subscribe' | 'onState' | 'request' | 'respondToDialog' | 'dispose'
>;

/**
 * How a conversation's host is started: in `cwd`, resuming `session` (a session file) when given, with `env` added to
 * what the launcher plans from. Resolves once the host is starting (startNativeHost); throws a NativeHostError when it
 * cannot be (`off`, `no-harness`, `old-harness`, `plan`).
 */
export type StartHost = (input: {
  cwd: string;
  session?: string;
  env: Record<string, string>;
}) => Promise<ConversationHost>;

/** What the native conversations push, in the order it happens: the bridge's emitters in the app. */
export type ConversationEvents = {
  records(event: NativeRecordEvent): void;
  status(event: NativeStatusEvent): void;
  replaced(event: NativeReplacedEvent): void;
  changed(event: NativeChangedEvent): void;
  attention(event: NativeAttentionEvent): void;
};

/** What the bridge asks of the native conversations (NativeConversations). Failures are thrown, never returned. */
export type NativeConversationsApi = {
  list(): Promise<NativeConversation[]>;
  /** `permissions`: the permission mode its mu starts in (MU_PERMISSIONS), mu's default when left out. */
  create(input: { cwd: string; permissions?: string }): Promise<NativeConversation>;
  open(id: string): Promise<NativeSnapshot>;
  request(id: string, command: PiCommand): Promise<unknown>;
  respond(id: string, dialogId: string, answer: DialogAnswer): Promise<void>;
  close(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Names a conversation: pi's `set_session_name` with a host, a `session_info` entry in its file without one. */
  rename(id: string, name: string): Promise<void>;
  /** Ends every host (the app quits). */
  dispose(): Promise<void>;
};
