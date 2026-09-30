/**
 * The native conversation bridge (docs/native-host.md, milestone 2): what the renderer asks the main process, and what
 * the main process pushes, so a conversation can run on the native host (pi in a process of its own) with no AionCore
 * and no ACP in its path. On unless the main process runs with MU_NATIVE_HOST=0, and only where the mu found on the
 * machine can run inside the app (`enabled`).
 *
 * Two parts of the app build against this file at the same time, so it is the source of truth for both:
 *
 * - The main process (process/services/nativeHost/, process/bridge/) implements the providers and pushes the
 *   emitters. It holds one `NativeView` per live host, folds every record of pi into it (`reduce`), numbers the
 *   records, and answers `open` with the view as it stands.
 * - The renderer takes a snapshot with `open`, then folds the records that follow (`seq` greater than the
 *   snapshot's) into its own copy with the same `reduce`. A renderer that reloads, or a second window, opens the
 *   conversation again and gets the same view, run in progress included.
 *
 * Extend this file with optional fields or new methods when a part needs one, and say so in the commit message; do not
 * change what is here incompatibly. No Node APIs: the renderer imports it.
 */
import { bridge } from '../platform/bridge';
import type { DialogAnswer, NativeView, PiCommand, PiRecord, SessionSettings } from '../utils/nativeHost';

/**
 * Why a call failed. The first eleven are the native host manager's own kinds (`NativeHostErrorKind`,
 * process/services/nativeHost/NativeHost.ts; a test keeps the two in step): `off` is MU_NATIVE_HOST=0,
 * `no-harness` and `old-harness` a mu that is missing or too old to run inside the app, `plan` the launcher refusing,
 * `no-models` a pi that stopped for want of a model, `failed` a host that stopped before pi started, `crashed` one that
 * stopped after, `closed` a host that was ended, `timeout` a command pi did not answer, `command` pi refusing one
 * (the message is pi's), `no-folder` a project folder that no longer exists (the message names it). `unknown-conversation`
 * names an id the main process does not know; `invalid` a request the
 * screen should never send. Anything unforeseen on the way (a session file that cannot be read) is `failed`, with its
 * own words as the message.
 */
export type NativeErrorKind =
  | 'off'
  | 'no-harness'
  | 'old-harness'
  | 'plan'
  | 'no-models'
  | 'failed'
  | 'crashed'
  | 'closed'
  | 'timeout'
  | 'command'
  | 'no-folder'
  | 'unknown-conversation'
  | 'invalid';

/**
 * A failure as the renderer gets it. `message` is plain English, for logs and as a detail under the screen's own
 * translated sentence for `kind`; `stderr` is the end of the host's output when it stopped (where a crash says why).
 */
export type NativeFailure = { ok: false; kind: NativeErrorKind; message: string; stderr?: string };
export type NativeResult<T> = { ok: true; data: T } | NativeFailure;

/**
 * How a conversation's host is:
 * - `idle`: no host is running (a conversation read from its session file, or one whose host ended after sitting
 *   idle). The next command that needs pi starts it, resuming the session file.
 * - `starting`: the process runs, pi has not answered yet.
 * - `running`: pi has a model and answers.
 * - `needs-model`: pi runs without a model set up (the guide's job, not a failure); prompts are refused until one is.
 * - `failed`: the host stopped unasked; `error` says how (`kind` `failed`, `crashed` or `no-models`).
 */
export type NativeHostStatus =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'running' }
  | { phase: 'needs-model' }
  | { phase: 'failed'; error: { kind: NativeErrorKind; message: string; stderr: string } };

/** One conversation: a pi session in a project folder. */
export type NativeConversation = {
  /**
   * The session's id (its file header's `id`). A conversation created here has a draft id until its host reports the
   * session's own; `open` and every event use the id the conversation has when they are called, and a change of id
   * is announced by `changed` (with the old id in `replaces`).
   */
  id: string;
  /** The project folder the session works in. */
  cwd: string;
  /** The session's file, once pi has one. */
  sessionFile?: string;
  /** The session's name, else the start of its first message, else ''. */
  title: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
  updatedAt: number;
  /** A host is running for it. */
  live: boolean;
  /**
   * How many messages the session holds (every `message` entry, as pi's own session list counts them). Left out when
   * it is not known: a large file whose middle the list did not read.
   */
  messageCount?: number;
  /** The session file of the session this one was forked or cloned from (its header's `parentSession`). */
  forkedFrom?: string;
  /** A run is in progress: pi has a prompt to answer. Left out when none is (and for a conversation with no host). */
  running?: boolean;
};

/** A conversation as `open` gives it: the view as of `seq`, and how its host is. */
export type NativeSnapshot = {
  conversation: NativeConversation;
  status: NativeHostStatus;
  /** Every record up to and including this one is folded into `view`. */
  seq: number;
  view: NativeView;
  /**
   * Only for a view read from the session file (no host runs): the model, thinking level and permission mode its
   * session runs with when a host resumes it, as its file says (`sessionSettings`), the permission mode `create` named
   * when the file names none. A running host says them itself (`view.host.session`, mu's `permissions.mode` frame).
   */
  session?: SessionSettings;
};

/**
 * What the main process pushes.
 *
 * `records`: every record pi writes for a conversation, in order, numbered by `seq` (1 more than the one before).
 * The renderer ignores one whose `seq` is not above its snapshot's. Records arrive as pi wrote them (pi's RPC mode
 * already sends a `message_update` as its delta alone, without the partial message), plus the `extension_ui_response`
 * the main process synthesizes when a dialog is answered (so every window closes the dialog), or when it ends without
 * an answer (`cancelled: true` once its `timeout` passed: pi then takes the default and says nothing). mu's notices
 * are among them as mu sends them (a `notify` request, a `checkpoint.off` frame): the view folds them like any other
 * record. Left out: a prompt pi refused because another mu held the model store, while the main process sends it
 * again; and the responses of commands that only read (`get_entries`, `get_tree`, `get_messages`,
 * `get_fork_messages`, `get_available_models`, `get_available_thinking_levels`, `get_commands`,
 * `get_last_assistant_text`, `export_html`), whose data goes to whoever asked as the answer to its request.
 */
export type NativeRecordEvent = { id: string; seq: number; record: PiRecord };
/** The host's status changed. */
export type NativeStatusEvent = { id: string; status: NativeHostStatus };
/**
 * The main process rebuilt a conversation's view (the session changed under it: `new_session`, `switch_session`,
 * `fork`, `clone`, tree navigation; or a session was read from its file). The renderer replaces its copy and takes
 * `seq` as the new baseline.
 */
export type NativeReplacedEvent = { id: string; seq: number; view: NativeView; conversation: NativeConversation };
/** The set of conversations, or one of them, changed (a new one, a title, `live`, an id that replaced a draft's). */
export type NativeChangedEvent = { conversation: NativeConversation; replaces?: string } | { removed: string };
/**
 * A conversation wants its person: a run ended (`done`; `error` when it failed; never for one the person stopped) or
 * pi waits on an answer (`question`: a dialog, a permission the person is asked). A run that another follows within a
 * moment (a goal's next step, a queued message) does not end one. `title` is the conversation's title as it is then.
 * What to do with it (a system notification, a mark in the list) is the renderer's, which knows what is on screen.
 */
export type NativeAttentionEvent = { id: string; kind: 'done' | 'error' | 'question'; title: string };

export const nativeBridge = {
  /**
   * Whether conversations run on the native host: on unless MU_NATIVE_HOST=0, and only with a mu that can run inside
   * the app (an older one, which the packaged app may carry, leaves them on AionCore). Everything below fails with
   * `off` when MU_NATIVE_HOST=0.
   */
  enabled: bridge.buildProvider<boolean, void>('mu.native.enabled'),
  /**
   * The conversations of this computer's mu, newest first, read from pi's session files (the CLI's sessions
   * included), plus drafts made here that have no file yet. Reading files starts no host.
   */
  list: bridge.buildProvider<NativeResult<NativeConversation[]>, void>('mu.native.list'),
  /**
   * A new conversation in a project folder. No host starts until a command needs pi. `permissions`: the permission
   * mode its mu starts in (`full`, `jev`, `ask`: MU_PERMISSIONS), mu's own default when left out.
   */
  create: bridge.buildProvider<NativeResult<NativeConversation>, { cwd: string; permissions?: string }>(
    'mu.native.create'
  ),
  /**
   * The view of a conversation. A conversation with a live host answers with the main process's view; one without
   * is read from its session file (no host starts to show history). `seq` is 0 for a view read from a file.
   */
  open: bridge.buildProvider<NativeResult<NativeSnapshot>, { id: string }>('mu.native.open'),
  /**
   * Sends a command to pi and answers with its response data (`get_state`, `set_model`, `prompt`, `steer`,
   * `follow_up`, `abort`, `get_commands`, ...). A `prompt` resolves when pi accepted it; the turn's end is the
   * `agent_settled` record. A command that needs pi starts the host first when none runs.
   */
  request: bridge.buildProvider<NativeResult<unknown>, { id: string; command: PiCommand }>('mu.native.request'),
  /** Answers a dialog pi waits on (`select`, `confirm`, `input`, `editor`), by the `id` of its request. */
  respond: bridge.buildProvider<NativeResult<void>, { id: string; dialogId: string; answer: DialogAnswer }>(
    'mu.native.respond'
  ),
  /** Ends a conversation's host. The conversation stays, and its session file. */
  close: bridge.buildProvider<NativeResult<void>, { id: string }>('mu.native.close'),
  /** Deletes a conversation: ends its host and removes its session file. */
  remove: bridge.buildProvider<NativeResult<void>, { id: string }>('mu.native.remove'),
  /**
   * Names a conversation (its session's name, the list's title): pi's `set_session_name` when a host runs, else a
   * `session_info` entry appended to the session file as pi writes it. The new title comes as `changed`.
   */
  rename: bridge.buildProvider<NativeResult<void>, { id: string; name: string }>('mu.native.rename'),
  records: bridge.buildEmitter<NativeRecordEvent>('mu.native.records'),
  status: bridge.buildEmitter<NativeStatusEvent>('mu.native.status'),
  replaced: bridge.buildEmitter<NativeReplacedEvent>('mu.native.replaced'),
  changed: bridge.buildEmitter<NativeChangedEvent>('mu.native.changed'),
  attention: bridge.buildEmitter<NativeAttentionEvent>('mu.native.attention'),
};
