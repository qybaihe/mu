import { randomUUID } from 'node:crypto';
import { appendFile, open, stat } from 'node:fs/promises';
import type { NativeConversation, NativeHostStatus, NativeSnapshot } from '../../../../common/kyrn/nativeBridge.ts';
import { readPresentation } from '../../../../common/utils/nativeHost/presentation.ts';
import {
  asList,
  asNumber,
  asObject,
  asText,
  DIALOG_METHODS,
  hasModel,
  type DialogAnswer,
  type JsonObject,
  type PiCommand,
  type PiCommandType,
  type PiRecord,
  type PiSessionState,
} from '../../../../common/utils/nativeHost/records.ts';
import { fromEntries, reduce } from '../../../../common/utils/nativeHost/reducer.ts';
import type { SessionSettings } from '../../../../common/utils/nativeHost/settings.ts';
import { emptyView, type NativeView } from '../../../../common/utils/nativeHost/view.ts';
import { NativeHostError, type NativeHostState } from '../NativeHost.ts';
import type { SessionRead, SessionViewRead } from '../sessions/readSession.ts';
import type { StoredSession } from '../sessions/SessionStore.ts';
import {
  addEntry,
  clip,
  maskSecrets,
  messageText,
  type SessionHeader,
  type SessionSummary,
} from '../sessions/summary.ts';
import { followsBranch } from './branch.ts';
import { findModel, MODEL_WAITS_MS, PROMPT_MODEL_WAITS_MS, type ModelChoice } from './modelSearch.ts';
import type { ConversationEvents, ConversationHost, StartHost } from './types.ts';

/**
 * One native conversation in the main process (docs/native-host.md, M2): a pi session in a project folder, the host
 * that runs it while one does, and the view that host's records fold into.
 *
 * - A host starts when a command needs pi, resuming the session file when there is one, and never to show history
 *   (`snapshot` reads the file then). Two calls at once start one host.
 * - Every record of the host folds into the view (`reduce`) and goes out numbered (`seq`, which only grows, across
 *   hosts too). A host that is starting holds its records back: its view goes out whole (`replaced`) once it runs.
 * - pi may run another session, or move the leaf of its branch, without a command of the app's: mu's `/clear`, an
 *   import, a checkpoint rewind. After every run and every slash command the conversation asks pi where its session
 *   is; when it is not where the view says, the view is rebuilt from the session (`replaced`), and a new session's id
 *   becomes the conversation's (the owner announces it).
 */

/** Commands a conversation with no host answers itself: nothing runs that they could stop or clear. */
const WITHOUT_HOST: Partial<Record<PiCommandType, () => unknown>> = {
  abort: () => undefined,
  abort_retry: () => undefined,
  abort_bash: () => undefined,
  clear_queue: () => ({ steering: [], followUp: [] }),
};

/** Commands after which pi may run another session: the view is rebuilt from it, unless pi says it did nothing. */
const SESSION_COMMANDS: ReadonlySet<PiCommandType> = new Set<PiCommandType>([
  'new_session',
  'switch_session',
  'fork',
  'clone',
]);

/**
 * Answers the view reads nothing in: their data goes to whoever asked, as the request's answer, and they are not
 * passed on as records. A whole session's `get_entries` would otherwise cross to every window, however large.
 */
const QUIET_ANSWERS: ReadonlySet<string> = new Set<PiCommandType>([
  'get_entries',
  'get_tree',
  'get_messages',
  'get_fork_messages',
  'get_available_models',
  'get_available_thinking_levels',
  'get_commands',
  'get_last_assistant_text',
  'export_html',
]);

/**
 * How long after a run settles before its person is told (`attention`): another run that starts within it (a goal's
 * next step, a queued message) means the run did not end anything they wait for.
 */
export const ATTENTION_DELAY_MS = 1200;

/** proper-lockfile's words for a store another mu process holds: pi did not start the prompt (KyrnAgent.ts). */
const STORE_LOCKED = /Lock file is already being held|ELOCKED/;
/** A prompt refused because the model store was locked goes again after these waits (KyrnAgent.ts). */
export const LOCKED_RETRY_MS = [1500, 3000] as const;

/** Permission modes are words (`full`, `jev`, `ask`), as mu names them (process/agent/kyrn/permissions.ts). */
const MODE_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** The roles whose `message_end` pi saves as a `message` entry (AgentSession's `_savesMessage`, custom ones aside). */
const COUNTED_ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant', 'toolResult']);

/** A session name as pi keeps it (SessionManager.appendSessionInfo): one line, trimmed. */
export const cleanName = (name: string): string => name.replace(/[\r\n]+/g, ' ').trim();

/** A new entry id as pi makes them (generateId in session-manager.ts): 8 hex characters no entry of the file has. */
function newEntryId(taken: ReadonlySet<unknown>): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = randomUUID().slice(0, 8);
    if (!taken.has(id)) return id;
  }
  return randomUUID();
}

/** Whether the file's last byte ends a line, so an entry appended after it starts one. */
async function endsLine(file: string, size: number): Promise<boolean> {
  if (size === 0) return true;
  const handle = await open(file, 'r');
  try {
    const byte = Buffer.alloc(1);
    await handle.read(byte, 0, 1, size - 1);
    return byte[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

/** The mode a `permissions.mode` frame says the conversation is in, when it is one of the modes it lists. */
function modeOf(payload: JsonObject): string | undefined {
  const mode = asText(payload.mode);
  const listed = asList(payload.modes).some((each) => asText(asObject(each).id) === mode);
  return MODE_ID.test(mode) && listed ? mode : undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => unref(setTimeout(resolve, ms)));

const closed = (): NativeHostError => new NativeHostError('closed', 'The mu host was closed');

const unref = (timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> => {
  (timer as { unref?: () => void }).unref?.();
  return timer;
};

const isMissing = (error: unknown): boolean => (error as { code?: unknown } | undefined)?.code === 'ENOENT';

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

const sameStatus = (a: NativeHostStatus, b: NativeHostStatus): boolean =>
  a.phase === b.phase && (a.phase !== 'failed' || (b.phase === 'failed' && a.error === b.error));

/** What a conversation needs from the registry that holds it (NativeConversations). */
export type ConversationOwner = {
  readonly events: ConversationEvents;
  readonly startHost: StartHost;
  /** Views of session files, for a conversation without a host (SessionReader). */
  view(file: string): Promise<SessionViewRead>;
  /** A session file read whole (readSessionFile). */
  read(file: string): Promise<SessionRead>;
  /** What mu gets in its environment for this conversation, besides the app's (hostEnv.ts). */
  env(conversation: Conversation): Record<string, string>;
  /** The model new sessions start on, for a host that started without one. */
  defaultModel(): ModelChoice | undefined;
  /**
   * The conversation's id changed from `previous`: a draft got its session's, or pi runs another session now. `left`
   * is the session file it moved away from, when there was one: that session is a conversation of its own again.
   */
  renamed(conversation: Conversation, previous: string, left: string | undefined): void;
  /** Something happened in the conversation: its idle time starts over. */
  touched(conversation: Conversation): void;
  /** A host is about to start for `conversation`: the owner ends others to stay under its cap. */
  makeRoom(conversation: Conversation): Promise<void>;
  now(): number;
  log(line: string): void;
};

export type ConversationInit = {
  id: string;
  cwd: string;
  /** Made here, with no session yet: the id is a draft's until pi names the session. */
  draft?: boolean;
  file?: string;
  name?: string;
  firstText?: string;
  createdAt: number;
  updatedAt: number;
  permissions?: string;
  /** The app's name for the conversation in mu's environment (MU_DESKTOP_SESSION). Default: a new one. */
  desktopSession?: string;
  /** The session's `message` entries, when known. */
  messageCount?: number;
  /** The session file of the session this one was forked or cloned from. */
  forkedFrom?: string;
};

export class Conversation {
  id: string;
  readonly cwd: string;
  /** The app's name for the conversation, which never changes (MU_DESKTOP_SESSION): mu hands it back to the browser. */
  readonly desktopSession: string;
  /** Made here, and pi has not named its session yet. */
  draft: boolean;
  file: string | undefined;
  name: string | undefined;
  firstText: string | undefined;
  createdAt: number;
  updatedAt: number;
  /** The permission mode mu last said the conversation is in, for its next host (MU_PERMISSIONS). */
  permissions: string | undefined;
  /** The session's `message` entries; undefined when the list could not count them (a large file read in part). */
  messageCount: number | undefined;
  forkedFrom: string | undefined;
  /** When the conversation was last used: the idle policy and the host cap go by it. */
  lastUsed: number;
  private readonly owner: ConversationOwner;
  private view: NativeView = emptyView();
  private seq = 0;
  private current: NativeHostStatus = { phase: 'idle' };
  private host: ConversationHost | undefined;
  private starting: Promise<ConversationHost> | undefined;
  /** The host's view went out: its records go out one by one from now on. */
  private ready = false;
  /** Records of a host that is starting, folded into its first view. */
  private held: PiRecord[] = [];
  private stops: (() => void)[] = [];
  /** Counts `end`s: a start that an end overtook gives its host up. */
  private generation = 0;
  /** The leaf of pi's branch the view shows (null: the empty branch); undefined when it is not known. */
  private leaf: string | null | undefined;
  private running = false;
  private inFlight = 0;
  /** Prompts in flight that go again when pi refuses them for a locked store. */
  private lockedRetries = 0;
  private finding: Promise<void> | undefined;
  private checking: Promise<void> | undefined;
  private checkAgain = false;
  /** The dialogs pi stops waiting on after their `timeout`, by id. */
  private readonly dialogTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** A run settled and its person is told once nothing follows (`tellSettled`). */
  private settleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(owner: ConversationOwner, init: ConversationInit) {
    this.owner = owner;
    this.id = init.id;
    this.cwd = init.cwd;
    this.desktopSession = init.desktopSession ?? `n-${randomUUID()}`;
    this.draft = init.draft === true;
    this.file = init.file;
    this.name = init.name;
    this.firstText = init.firstText;
    this.createdAt = init.createdAt;
    this.updatedAt = init.updatedAt;
    this.permissions = init.permissions;
    this.messageCount = init.messageCount;
    this.forkedFrom = init.forkedFrom;
    this.lastUsed = owner.now();
  }

  /** A host runs for the conversation, or is starting. */
  get live(): boolean {
    return this.host !== undefined || this.starting !== undefined;
  }

  get status(): NativeHostStatus {
    return this.current;
  }

  describe(): NativeConversation {
    return {
      id: this.id,
      cwd: this.cwd,
      ...(this.file ? { sessionFile: this.file } : {}),
      title: this.name !== undefined ? maskSecrets(this.name) : (this.firstText ?? ''),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      live: this.live,
      ...(this.running ? { running: true } : {}),
      ...(this.messageCount !== undefined ? { messageCount: this.messageCount } : {}),
      ...(this.forkedFrom ? { forkedFrom: this.forkedFrom } : {}),
    };
  }

  /** Something runs, waits or is on its way: a run, a dialog, a compaction, a command, a start. Never ended idle. */
  busy(): boolean {
    return (
      this.starting !== undefined ||
      this.checking !== undefined ||
      this.finding !== undefined ||
      this.inFlight > 0 ||
      this.running ||
      this.view.dialogs.length > 0 ||
      this.view.live.compacting
    );
  }

  /** What the list read of the session file, for a conversation with no host (the command line may have used it). */
  refresh(stored: StoredSession): void {
    if (this.live || stored.id !== this.id) return;
    this.file = stored.file;
    this.name = stored.name;
    this.firstText = stored.firstText;
    this.createdAt = stored.createdAt;
    this.updatedAt = stored.updatedAt;
    this.messageCount = stored.messageCount;
    this.forkedFrom = stored.parentSession;
  }

  /**
   * The view as it stands: the host's, or the session file's when no host runs (`seq` 0). A host that is starting
   * is waited for, so a snapshot never predates the view its start sends.
   */
  async snapshot(): Promise<NativeSnapshot> {
    if (this.starting) await this.starting.catch((): void => {});
    if (this.host && this.ready) return this.hostSnapshot();
    const { view, settings } = await this.fileRead();
    // A host may have started while the file was read: its view is the one records follow.
    if (this.host && this.ready) return this.hostSnapshot();
    // What the next host resumes with: the file's own, else the mode mu will start in here (MU_PERMISSIONS).
    const permissions = settings.permissions ?? this.permissions;
    const session = { ...settings, ...(permissions ? { permissions } : {}) };
    return {
      conversation: this.describe(),
      status: this.current,
      seq: 0,
      view,
      ...(Object.keys(session).length > 0 ? { session } : {}),
    };
  }

  /** Sends a command to pi, starting the host first when none runs. */
  async request(command: PiCommand): Promise<unknown> {
    this.inFlight += 1;
    this.owner.touched(this);
    try {
      const answer = WITHOUT_HOST[command.type];
      if (answer && !this.live) return answer();
      const host = await this.ensureHost();
      if (command.type === 'prompt') return await this.prompt(host, command);
      const data = await host.request(command);
      if (SESSION_COMMANDS.has(command.type) && asObject(data).cancelled !== true) await this.rebuild(host);
      return data;
    } finally {
      this.inFlight -= 1;
      this.owner.touched(this);
    }
  }

  /** Answers a dialog pi waits on. */
  respond(dialogId: string, answer: DialogAnswer): void {
    if (!this.host || !this.ready) throw new NativeHostError('closed', 'No mu runs for this conversation');
    this.host.respondToDialog(dialogId, answer);
    this.owner.touched(this);
  }

  /**
   * Names the session (the list's title). With a host, pi's `set_session_name`, whose `session_info_changed` gives the
   * title. Without one, a `session_info` entry appended to the session file exactly as pi appends it, on the branch
   * pi opens the file at (its last entry). A conversation with no file yet (pi writes it with the first reply) starts
   * its host for it: pi keeps the name until it writes the file.
   */
  async rename(name: string): Promise<void> {
    const clean = cleanName(name);
    const file = this.file;
    if (this.live || !file || !(await exists(file))) {
      await this.request({ type: 'set_session_name', name: clean });
      return;
    }
    this.inFlight += 1;
    try {
      const read = await this.owner.read(file);
      // A host that started meanwhile read the file before this entry: pi names the session instead.
      if (this.live) {
        await this.request({ type: 'set_session_name', name: clean });
        return;
      }
      const entry = {
        type: 'session_info',
        id: newEntryId(new Set(read.entries.map((each) => each.id))),
        parentId: read.lastEntryId ?? null,
        timestamp: new Date(this.owner.now()).toISOString(),
        name: clean,
      };
      const lead = (await endsLine(file, read.size)) ? '' : '\n';
      await appendFile(file, `${lead}${JSON.stringify(entry)}\n`);
      this.name = clean || undefined;
      this.changed();
    } finally {
      this.inFlight -= 1;
      this.owner.touched(this);
    }
  }

  /** Ends the host, if one runs or is starting. The conversation stays, with its session file. */
  async end(): Promise<void> {
    this.generation += 1;
    const host = this.host;
    const starting = this.starting;
    if (host) {
      this.detach(host);
      this.setStatus({ phase: 'idle' });
      // A start this end overtook says it when it lets go (ensureHost).
      if (!starting) this.changed();
      await host.dispose();
      return;
    }
    // A start that has no host yet gives it up as soon as it has one (launch).
    if (starting) await starting.catch((): void => {});
    if (!this.live && this.current.phase !== 'idle') this.setStatus({ phase: 'idle' });
  }

  private hostSnapshot(): NativeSnapshot {
    return { conversation: this.describe(), status: this.current, seq: this.seq, view: this.view };
  }

  private async fileView(): Promise<NativeView> {
    return (await this.fileRead()).view;
  }

  private async fileRead(): Promise<{ view: NativeView; settings: SessionSettings }> {
    if (!this.file) return { view: emptyView(), settings: {} };
    try {
      const read = await this.owner.view(this.file);
      return { view: read.view, settings: read.settings };
    } catch (error) {
      // pi writes a session's file with its first reply: until then there is nothing to show.
      if (isMissing(error)) return { view: emptyView(), settings: {} };
      throw error;
    }
  }

  /** The host, once it runs: the one that runs, or the one that is starting, or a new one. */
  private ensureHost(): Promise<ConversationHost> {
    if (this.host && this.ready) return Promise.resolve(this.host);
    if (!this.starting) {
      const starting = this.launch();
      this.starting = starting;
      // Before the callers hear of it: a conversation whose start failed is not live.
      starting.then(
        () => {
          if (this.starting === starting) this.starting = undefined;
        },
        () => {
          if (this.starting !== starting) return;
          this.starting = undefined;
          this.changed();
        }
      );
    }
    return this.starting;
  }

  private async launch(): Promise<ConversationHost> {
    const generation = this.generation;
    // A session of a deleted worktree or a temporary folder can be read, but not resumed: pi's process would stop before
    // it started, saying nothing of why. Said before another conversation's host is ended to make room for it.
    if (!(await isFolder(this.cwd)))
      throw new NativeHostError('no-folder', `The project folder no longer exists: ${this.cwd}`);
    await this.owner.makeRoom(this);
    if (generation !== this.generation) throw closed();
    this.setStatus({ phase: 'starting' });
    this.changed();
    const resume = this.file && (await exists(this.file)) ? this.file : undefined;
    let host: ConversationHost;
    try {
      host = await this.owner.startHost({
        cwd: this.cwd,
        ...(resume ? { session: resume } : {}),
        env: this.owner.env(this),
      });
    } catch (error) {
      // Nothing started (no harness, a launcher that refused): the call says why, the conversation has no host.
      this.setStatus({ phase: 'idle' });
      throw error;
    }
    if (generation !== this.generation) {
      this.setStatus({ phase: 'idle' });
      await host.dispose();
      throw closed();
    }
    this.host = host;
    this.ready = false;
    this.held = [];
    this.stops = [
      host.subscribe((record) => this.receive(host, record)),
      host.onState((state) => this.hostState(host, state)),
    ];
    try {
      const previous = this.id;
      const state = await host.request({ type: 'get_state' });
      if (this.host !== host) throw closed();
      this.adopt(state);
      // pi resumed the file: the view starts from it (the one `snapshot` read, when the file did not change since).
      const base = resume && this.id === previous ? await this.owner.view(resume) : undefined;
      if (this.host !== host) throw closed();
      this.view = base?.view ?? emptyView();
      this.leaf = base ? (base.lastEntryId ?? null) : null;
      for (const record of this.held.splice(0)) this.fold(record, false);
      this.ready = true;
      this.emitReplaced();
      const model = hasModel(state.model);
      this.setStatus({ phase: model ? 'running' : 'needs-model' });
      if (!model) this.lookForModel(MODEL_WAITS_MS);
      this.changed();
      return host;
    } catch (error) {
      if (this.host === host) {
        this.detach(host);
        this.setStatus({ phase: 'idle' });
        void host.dispose();
      }
      throw error;
    }
  }

  private receive(host: ConversationHost, record: PiRecord): void {
    if (host !== this.host) return;
    if (!this.ready) {
      this.held.push(record);
      return;
    }
    this.fold(record, true);
    this.owner.touched(this);
  }

  /** One record into the view, and out to the windows when `send`. */
  private fold(record: PiRecord, send: boolean): void {
    if (this.quiet(record)) return;
    this.view = reduce(this.view, record);
    if (send) {
      this.seq += 1;
      this.owner.events.records({ id: this.id, seq: this.seq, record });
    }
    this.track(record, send);
  }

  /**
   * pi stops waiting on a dialog once its `timeout` passed: it takes the default and says nothing. The conversation
   * then ends the dialog itself, with the record an answer gives (`cancelled`), so no view keeps a dialog nobody waits
   * on, and a host with nothing else to do can end.
   */
  private watchDialog(record: PiRecord): void {
    const id = asText(record.id);
    const timeout = asNumber(record.timeout);
    if (!id || timeout === undefined || timeout <= 0) return;
    if (!(DIALOG_METHODS as readonly string[]).includes(asText(record.method))) return;
    const host = this.host;
    clearTimeout(this.dialogTimers.get(id));
    const timer = setTimeout(() => {
      this.dialogTimers.delete(id);
      if (host !== this.host || !this.ready || !this.view.dialogs.some((dialog) => dialog.id === id)) return;
      this.fold({ type: 'extension_ui_response', id, cancelled: true }, true);
      this.owner.touched(this);
    }, timeout);
    this.dialogTimers.set(id, unref(timer));
  }

  private quiet(record: PiRecord): boolean {
    if (record.type !== 'response') return false;
    if (QUIET_ANSWERS.has(asText(record.command))) return true;
    // A prompt refused for a locked store, which goes again: the view shows the run, not the refusal before it.
    return (
      record.command === 'prompt' &&
      record.success === false &&
      this.lockedRetries > 0 &&
      STORE_LOCKED.test(asText(record.error))
    );
  }

  /** What a record says about the conversation itself: its runs, its title, its time, its permission mode. */
  private track(record: PiRecord, send: boolean): void {
    switch (record.type) {
      case 'agent_start':
        this.running = true;
        clearTimeout(this.settleTimer);
        this.settleTimer = undefined;
        if (send) this.changed();
        return;
      case 'agent_settled':
        this.running = false;
        this.changed();
        this.check();
        if (send) this.tellSettled();
        return;
      case 'message_end':
        this.noteMessage(asObject(record.message));
        return;
      case 'session_info_changed': {
        const name = asText(record.name).trim() || undefined;
        if (name === this.name) return;
        this.name = name;
        this.changed();
        return;
      }
      case 'extension_ui_request': {
        this.watchDialog(record);
        // A question for the person, in the middle of a run or not: they are told at once.
        if (send && (DIALOG_METHODS as readonly string[]).includes(asText(record.method)))
          this.owner.events.attention({ id: this.id, kind: 'question', title: this.describe().title });
        const frame = readPresentation(record);
        if (frame?.kind === 'permissions.mode') this.permissions = modeOf(frame.payload) ?? this.permissions;
        return;
      }
      default:
        return;
    }
  }

  /**
   * A run settled: its person is told how it ended, once nothing has followed it for a moment (`ATTENTION_DELAY_MS`).
   * A run they stopped, or one that produced nothing (a slash command), tells nothing.
   */
  private tellSettled(): void {
    clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
    const kind = this.view.status === 'settled' ? 'done' : this.view.status === 'error' ? 'error' : undefined;
    if (!kind) return;
    const host = this.host;
    this.settleTimer = unref(
      setTimeout(() => {
        this.settleTimer = undefined;
        if (host !== this.host || this.running) return;
        this.owner.events.attention({ id: this.id, kind, title: this.describe().title });
      }, ATTENTION_DELAY_MS)
    );
  }

  private noteMessage(message: JsonObject): void {
    if (this.messageCount !== undefined && COUNTED_ROLES.has(asText(message.role))) this.messageCount += 1;
    if (message.role !== 'user' && message.role !== 'assistant') return;
    this.updatedAt = Math.max(this.updatedAt, asNumber(message.timestamp) ?? this.owner.now());
    if (message.role !== 'user' || this.firstText !== undefined) return;
    const text = clip(messageText(message.content));
    if (!text) return;
    this.firstText = text;
    if (this.name === undefined) this.changed();
  }

  private hostState(host: ConversationHost, state: NativeHostState): void {
    if (host !== this.host) return;
    if (state.phase === 'failed') {
      this.lost(host, state.error);
      return;
    }
    if (!this.ready) return;
    if (state.phase === 'running' || state.phase === 'needs-model') this.setStatus({ phase: state.phase });
    if (state.phase === 'needs-model') this.lookForModel(MODEL_WAITS_MS);
  }

  /** The host stopped unasked. The session file has what pi saved: its view goes out, settled. */
  private lost(host: ConversationHost, error: NativeHostError): void {
    const shown = this.ready;
    this.detach(host);
    this.setStatus({ phase: 'failed', error: { kind: error.kind, message: error.message, stderr: error.stderr } });
    this.changed();
    if (shown) void this.showFile();
  }

  private async showFile(): Promise<void> {
    try {
      const view = await this.fileView();
      if (this.live) return;
      this.view = view;
      this.emitReplaced();
    } catch (error) {
      this.owner.log(`a native conversation could not read its session file: ${String(error)}`);
    }
  }

  private detach(host: ConversationHost): void {
    for (const stop of this.stops.splice(0)) stop();
    for (const timer of this.dialogTimers.values()) clearTimeout(timer);
    this.dialogTimers.clear();
    clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
    if (this.host === host) this.host = undefined;
    this.ready = false;
    this.held = [];
    this.running = false;
    this.leaf = undefined;
  }

  /**
   * A message goes to pi. With no model yet, the conversation looks for one briefly first. A prompt pi refused
   * because another mu process held the model store goes again (pi had not started it, so nothing runs twice).
   */
  private async prompt(host: ConversationHost, command: Extract<PiCommand, { type: 'prompt' }>): Promise<unknown> {
    if (this.current.phase === 'needs-model') {
      this.lookForModel(PROMPT_MODEL_WAITS_MS);
      await this.finding;
    }
    for (let attempt = 0; ; attempt++) {
      const wait: number | undefined = LOCKED_RETRY_MS[attempt];
      const again = wait !== undefined;
      if (again) this.lockedRetries += 1;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one attempt after another
        const data = await host.request(command);
        // A slash command may have run another session, or moved the branch, without a run.
        if (command.message.trimStart().startsWith('/')) this.check();
        return data;
      } catch (error) {
        const locked = error instanceof NativeHostError && error.kind === 'command' && STORE_LOCKED.test(error.message);
        if (!again || !locked || this.host !== host) throw error;
      } finally {
        if (again) this.lockedRetries -= 1;
      }
      // oxlint-disable-next-line no-await-in-loop -- the wait before the next attempt
      await sleep(wait);
    }
  }

  private lookForModel(waits: readonly number[]): void {
    const host = this.host;
    if (!host || this.finding) return;
    const finding = findModel(host, { wanted: this.owner.defaultModel(), waits, still: () => this.host === host })
      .then(
        (): void => {},
        (error: unknown) => this.owner.log(`a native conversation found no model: ${String(error)}`)
      )
      .finally(() => {
        if (this.finding === finding) this.finding = undefined;
        this.owner.touched(this);
      });
    this.finding = finding;
  }

  /**
   * Asks pi where its session is, after a run or a slash command: one check at a time, and one more when asked
   * meanwhile.
   */
  private check(): void {
    if (!this.host || !this.ready) return;
    if (this.checking) {
      this.checkAgain = true;
      return;
    }
    const checking = (async () => {
      do {
        this.checkAgain = false;
        // oxlint-disable-next-line no-await-in-loop -- one check after another
        await this.verify();
      } while (this.checkAgain);
    })()
      .catch((error: unknown) => {
        if (!(error instanceof NativeHostError && error.kind === 'closed'))
          this.owner.log(`a native conversation could not check its session: ${String(error)}`);
      })
      .finally(() => {
        this.checking = undefined;
        this.owner.touched(this);
      });
    this.checking = checking;
  }

  private async verify(): Promise<void> {
    const host = this.host;
    // A run that goes on is checked when it ends.
    if (!host || !this.ready || this.running) return;
    const state = await host.request({ type: 'get_state' });
    if (host !== this.host) return;
    const since = this.leaf;
    if (state.sessionId !== this.id || since === undefined) {
      await this.rebuild(host, state);
      return;
    }
    let found: { entries: JsonObject[]; leafId: string | null };
    try {
      found = await host.request({ type: 'get_entries', ...(since ? { since } : {}) });
    } catch (error) {
      // pi has no such entry: the session changed under the conversation.
      if (!(error instanceof NativeHostError && error.kind === 'command')) throw error;
      if (host === this.host) await this.rebuild(host);
      return;
    }
    if (host !== this.host || this.leaf !== since) return;
    if (followsBranch(found.entries, since, found.leafId)) this.leaf = found.leafId;
    else await this.rebuild(host, state);
  }

  /**
   * The view anew from pi's session: what its file has, and what pi has not written yet. The dialogs pi waits on, the
   * live part of a run and what only the live host says (`host`: the Jev panel's activity, mu's notices, pi's queue)
   * stay as they were: a session file has none of them.
   */
  private async rebuild(host: ConversationHost, known?: PiSessionState): Promise<void> {
    try {
      const state = known ?? (await host.request({ type: 'get_state' }));
      if (host !== this.host) return;
      const { entries, leafId, header } = await this.entriesOf(host, state);
      if (host !== this.host) return;
      this.adopt(state, entries, header);
      this.view = {
        ...fromEntries(entries, leafId),
        dialogs: this.view.dialogs,
        live: this.view.live,
        host: this.view.host,
      };
      this.leaf = leafId;
      this.emitReplaced();
    } catch (error) {
      // The view stays as it was; the next check tries again from scratch.
      this.leaf = undefined;
      if (!(error instanceof NativeHostError && error.kind === 'closed'))
        this.owner.log(`a native conversation could not rebuild its view: ${String(error)}`);
    }
  }

  /** Every entry of pi's session: the file's, and after its last one what pi has not written yet. */
  private async entriesOf(
    host: ConversationHost,
    state: PiSessionState
  ): Promise<{ entries: JsonObject[]; leafId: string | null; header?: SessionHeader }> {
    const read = state.sessionFile
      ? await this.owner.read(state.sessionFile).catch((): undefined => undefined)
      : undefined;
    const since = read?.lastEntryId;
    if (read && since) {
      try {
        const rest = await host.request({ type: 'get_entries', since });
        return { entries: [...read.entries, ...rest.entries], leafId: rest.leafId, header: read.header };
      } catch (error) {
        // pi does not have the file's last entry (the file changed under it): what pi has counts.
        if (!(error instanceof NativeHostError && error.kind === 'command')) throw error;
      }
    }
    const all = await host.request({ type: 'get_entries' });
    return { entries: all.entries, leafId: all.leafId, ...(read?.header ? { header: read.header } : {}) };
  }

  /**
   * pi runs `state`'s session: the conversation takes its file, and its id when that is another one (a draft's first
   * session, or the session pi went on in). `entries` and `header` describe another session for the list.
   */
  private adopt(state: PiSessionState, entries: readonly JsonObject[] = [], header?: SessionHeader): void {
    const previous = this.id;
    const id = state.sessionId || previous;
    const left = id !== previous && !this.draft ? this.file : undefined;
    this.file = state.sessionFile || undefined;
    if (id === previous) return;
    const summary: SessionSummary = { header: header ?? { id, cwd: this.cwd, timestamp: Number.NaN } };
    for (const entry of entries) addEntry(summary, entry, { firstMessage: true });
    this.id = id;
    this.name = state.sessionName?.trim() || summary.name;
    this.firstText = clip(summary.firstMessage ?? '') || undefined;
    this.messageCount = summary.messageCount ?? 0;
    this.forkedFrom = summary.header.parentSession;
    const now = this.owner.now();
    if (!this.draft) this.createdAt = Number.isFinite(summary.header.timestamp) ? summary.header.timestamp : now;
    this.updatedAt = now;
    this.draft = false;
    this.owner.renamed(this, previous, left);
  }

  private emitReplaced(): void {
    this.owner.events.replaced({ id: this.id, seq: this.seq, view: this.view, conversation: this.describe() });
  }

  private changed(): void {
    this.owner.events.changed({ conversation: this.describe() });
  }

  private setStatus(status: NativeHostStatus): void {
    if (sameStatus(this.current, status)) return;
    this.current = status;
    this.owner.events.status({ id: this.id, status });
  }
}
