import { app, shell } from 'electron';
import { join } from 'node:path';
import { nativeBridge, type NativeFailure, type NativeResult } from '../../common/kyrn/nativeBridge';
import type { DialogAnswer, PiCommand, PiCommandType } from '../../common/utils/nativeHost/records';
import { muHome } from '../agent/kyrn/naming';
import { isNativeHostEnabled, nativeHostReady, startNativeHost } from '../services/nativeHost';
import { NativeHostError } from '../services/nativeHost/NativeHost';
import { cleanName } from '../services/nativeHost/conversations/Conversation';
import { NativeRequestError } from '../services/nativeHost/conversations/errors';
import { hostEnv } from '../services/nativeHost/conversations/hostEnv';
import { NativeConversations } from '../services/nativeHost/conversations/NativeConversations';
import type { ConversationEvents, NativeConversationsApi } from '../services/nativeHost/conversations/types';
import { AcpBindings } from '../services/nativeHost/sessions/acpBindings';
import { sessionFolders } from '../services/nativeHost/sessions/folders';

/**
 * The native conversation bridge's main-process side (common/kyrn/nativeBridge.ts, docs/native-host.md): every
 * provider answers from the native conversations, and what they push goes to every window. Failures are answered, never
 * thrown: the generic bridge would only log an exception, and the renderer would wait for ever.
 */

/** Why a call failed, as the renderer gets it: the manager's own kinds, and `failed` for anything unforeseen. */
export function nativeFailure(error: unknown): NativeFailure {
  if (error instanceof NativeHostError)
    return { ok: false, kind: error.kind, message: error.message, ...(error.stderr ? { stderr: error.stderr } : {}) };
  if (error instanceof NativeRequestError) return { ok: false, kind: error.kind, message: error.message };
  // A file the store could not read, a folder that went away: something failed on the way, with its own words.
  return { ok: false, kind: 'failed', message: error instanceof Error ? error.message : String(error) };
}

async function answer<T>(work: () => T | Promise<T>): Promise<NativeResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    return nativeFailure(error);
  }
}

const OFF: NativeFailure = {
  ok: false,
  kind: 'off',
  message: 'The native host is off: MU_NATIVE_HOST=0 turned it off',
};

/**
 * The largest answer sent to the renderer. The IPC adapter drops a message over 50 MB (common/adapter/main.ts), and
 * the call would then never be answered; a view that large (a session of about 50 MB of tool output) fails instead.
 */
const LARGEST_ANSWER = 48 * 1024 * 1024;

/** `result`, or a failure when it would not cross to the renderer. */
export function sendable<T>(result: NativeResult<T>, largest: number = LARGEST_ANSWER): NativeResult<T> {
  if (!result.ok) return result;
  const size = JSON.stringify(result).length;
  if (size <= largest) return result;
  const megabytes = Math.round(size / 1024 / 1024);
  return { ok: false, kind: 'failed', message: `The conversation is too large to show (${megabytes} MB)` };
}

const invalid = (message: string): NativeRequestError => new NativeRequestError('invalid', message);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** An id as the screen has it: a conversation's, a dialog's. One line of text, not too long. */
function readId(value: unknown, what: string): string {
  if (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\r\n]/.test(value) &&
    !value.includes('\u0000')
  )
    return value;
  throw invalid(`Invalid ${what}`);
}

/** The commands pi's RPC mode takes (PiCommand). A type the list lacks, or one it has too many, does not compile. */
const COMMAND_TYPES = {
  prompt: true,
  steer: true,
  follow_up: true,
  abort: true,
  clear_queue: true,
  new_session: true,
  get_state: true,
  set_model: true,
  cycle_model: true,
  get_available_models: true,
  set_thinking_level: true,
  cycle_thinking_level: true,
  get_available_thinking_levels: true,
  set_steering_mode: true,
  set_follow_up_mode: true,
  compact: true,
  set_auto_compaction: true,
  set_auto_retry: true,
  abort_retry: true,
  bash: true,
  abort_bash: true,
  get_session_stats: true,
  export_html: true,
  switch_session: true,
  fork: true,
  clone: true,
  get_fork_messages: true,
  get_entries: true,
  get_tree: true,
  get_last_assistant_text: true,
  set_session_name: true,
  get_messages: true,
  get_commands: true,
} satisfies Record<PiCommandType, true>;

const isCommandType = (value: unknown): value is PiCommandType =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(COMMAND_TYPES, value);

/**
 * A command for pi: one of the types it takes, and the fields the main process itself reads. pi checks the rest and
 * says what is wrong in its own words (kind `command`). An `id` the screen sent is dropped: the manager pairs its own.
 */
export function readCommand(value: unknown): PiCommand {
  if (!isObject(value) || !isCommandType(value.type)) throw invalid('Invalid command');
  const { id: _id, ...command } = value;
  if (
    (value.type === 'prompt' || value.type === 'steer' || value.type === 'follow_up') &&
    typeof value.message !== 'string'
  )
    throw invalid(`A ${value.type} needs a message`);
  if (value.type === 'switch_session' && typeof value.sessionPath !== 'string')
    throw invalid('A switch_session needs a sessionPath');
  if (value.type === 'fork' && typeof value.entryId !== 'string') throw invalid('A fork needs an entryId');
  return command as PiCommand;
}

/** An answer to a dialog: a value, a confirmation, or a cancel. */
export function readAnswer(value: unknown): DialogAnswer {
  if (isObject(value)) {
    if (value.cancelled === true) return { cancelled: true };
    if (typeof value.confirmed === 'boolean') return { confirmed: value.confirmed };
    if (typeof value.value === 'string') return { value: value.value };
  }
  throw invalid('Invalid dialog answer');
}

/** Permission modes are words (`full`, `jev`, `ask`), as mu names them. */
const MODE_ID = /^[a-z][a-z0-9-]{0,31}$/;

function readCreate(value: unknown): { cwd: string; permissions?: string } {
  if (!isObject(value) || typeof value.cwd !== 'string' || !value.cwd) throw invalid('A conversation needs a folder');
  if (value.permissions === undefined) return { cwd: value.cwd };
  if (typeof value.permissions !== 'string' || !MODE_ID.test(value.permissions))
    throw invalid('Invalid permission mode');
  return { cwd: value.cwd, permissions: value.permissions };
}

/** The longest session name taken: a title, not a document. */
const NAME_LIMIT = 500;

/** A new name for a conversation: text that is not empty once pi has cleaned it (one line, trimmed). */
export function readName(value: unknown): string {
  const name = typeof value === 'string' ? cleanName(value) : '';
  if (!name) throw invalid('A conversation needs a name');
  if (name.length > NAME_LIMIT) throw invalid('That name is too long');
  return name;
}

const params = (value: unknown): Record<string, unknown> => (isObject(value) ? value : {});

/**
 * Answers every provider of the bridge from `conversations`, or with `off` for all but `enabled` when there are none
 * (MU_NATIVE_HOST=0). `ready` is the rest of `enabled`: whether the mu on this machine can run inside the app (the
 * screens show the native host only when it can, and an older mu leaves every conversation on AionCore).
 */
export function registerNativeBridge(
  conversations: NativeConversationsApi | undefined,
  ready: () => Promise<boolean> | boolean = () => true
): void {
  nativeBridge.enabled.provider(() => (conversations === undefined ? false : ready()));
  if (!conversations) {
    nativeBridge.list.provider(() => OFF);
    nativeBridge.create.provider(() => OFF);
    nativeBridge.open.provider(() => OFF);
    nativeBridge.request.provider(() => OFF);
    nativeBridge.respond.provider(() => OFF);
    nativeBridge.close.provider(() => OFF);
    nativeBridge.remove.provider(() => OFF);
    nativeBridge.rename.provider(() => OFF);
    return;
  }
  nativeBridge.list.provider(() => answer(() => conversations.list()));
  nativeBridge.create.provider((input) => answer(() => conversations.create(readCreate(input))));
  nativeBridge.open.provider(async (input) =>
    sendable(await answer(() => conversations.open(readId(params(input).id, 'conversation'))))
  );
  nativeBridge.request.provider((input) =>
    answer(() => {
      const { id, command } = params(input);
      return conversations.request(readId(id, 'conversation'), readCommand(command));
    })
  );
  nativeBridge.respond.provider((input) =>
    answer(() => {
      const { id, dialogId, answer: given } = params(input);
      return conversations.respond(readId(id, 'conversation'), readId(dialogId, 'dialog'), readAnswer(given));
    })
  );
  nativeBridge.close.provider((input) => answer(() => conversations.close(readId(params(input).id, 'conversation'))));
  nativeBridge.remove.provider((input) => answer(() => conversations.remove(readId(params(input).id, 'conversation'))));
  nativeBridge.rename.provider((input) =>
    answer(() => {
      const { id, name } = params(input);
      return conversations.rename(readId(id, 'conversation'), readName(name));
    })
  );
}

/** What the native conversations push, sent to every window. */
export const bridgeEvents: ConversationEvents = {
  records: (event) => nativeBridge.records.emit(event),
  status: (event) => nativeBridge.status.emit(event),
  replaced: (event) => nativeBridge.replaced.emit(event),
  changed: (event) => nativeBridge.changed.emit(event),
  attention: (event) => nativeBridge.attention.emit(event),
};

/** How long the app's quit waits for the hosts to end (each gets pi's own shutdown, then a kill). */
const QUIT_WAIT_MS = 5000;

let conversations: NativeConversations | undefined;

/**
 * The native conversations in the app, unless MU_NATIVE_HOST=0: the bridge answers from them, and every host ends
 * before the app quits. Turned off, every provider but `enabled` answers `off`. Whether the mu on this machine can
 * run inside the app is looked at once, now, so the first window finds the answer waiting (`nativeHostReady`).
 */
export function initNativeBridge(): void {
  if (!isNativeHostEnabled()) {
    registerNativeBridge(undefined);
    return;
  }
  const bindings = new AcpBindings(() => join(muHome(), 'acp-sessions'));
  const native = new NativeConversations({
    events: bridgeEvents,
    startHost: ({ cwd, session, env }) =>
      startNativeHost({ cwd, ...(session ? { session } : {}), env: { ...process.env, ...env } }),
    folders: () => sessionFolders(),
    env: (conversation) => hostEnv(conversation),
    // A removed conversation's session goes to the bin, where the person can still get it back.
    trash: (file) => shell.trashItem(file),
    // Sessions AionCore's mu conversations run (the ACP adapter's records) are listed there, not here as well.
    bound: () => bindings.files(),
  });
  conversations = native;
  const ready = nativeHostReady();
  registerNativeBridge(native, () => ready);
  let ending = false;
  let ended = false;
  app.on('before-quit', (event) => {
    if (ended) return;
    if (native.liveCount === 0) {
      ended = true;
      void native.dispose();
      return;
    }
    event.preventDefault();
    if (ending) return;
    ending = true;
    const waited = new Promise<void>((resolve) => setTimeout(resolve, QUIT_WAIT_MS).unref());
    void Promise.race([native.dispose(), waited]).finally(() => {
      ended = true;
      app.quit();
    });
  });
}

/** The native conversation mu names by MU_DESKTOP_SESSION when it drives the app's browser (kyrnBrowserBridge.ts). */
export const nativeConversationOf = (desktopSession: string): string | undefined =>
  conversations?.conversationOf(desktopSession);
