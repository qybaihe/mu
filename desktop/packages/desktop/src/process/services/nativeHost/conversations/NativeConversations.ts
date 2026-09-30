import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { NativeConversation, NativeSnapshot } from '../../../../common/kyrn/nativeBridge.ts';
import type { DialogAnswer, PiCommand } from '../../../../common/utils/nativeHost/records.ts';
import { NativeHostError } from '../NativeHost.ts';
import { boundFile } from '../sessions/acpBindings.ts';
import { insideSessionFolders, type SessionFolders } from '../sessions/folders.ts';
import { readSessionFile, SessionReader } from '../sessions/readSession.ts';
import { SessionStore, type StoredSession } from '../sessions/SessionStore.ts';
import { Conversation, type ConversationOwner } from './Conversation.ts';
import { NativeRequestError } from './errors.ts';
import { readDefaultModel } from './modelSearch.ts';
import type { ConversationEvents, NativeConversationsApi, StartHost } from './types.ts';

/**
 * The native conversations of the app (docs/native-host.md, M2): the conversations pi's session files hold, the
 * drafts made here, and the hosts that run some of them. The bridge answers the renderer from here
 * (process/bridge/nativeBridge.ts).
 *
 * - An id is a session's id. A draft (`create`) has one of its own until its host names its session; calls with the
 *   draft's id still reach it after that.
 * - A host ends after IDLE_MS without a record or a call (never during a run, a dialog or a compaction), and at most
 *   MAX_LIVE_HOSTS run: a start ends the least recently used idle ones first. An ended host starts again on the next
 *   command that needs pi, resuming the session file.
 */

/** How long a host may sit without a record or a call before it ends. */
export const IDLE_MS = 10 * 60_000;
/** How many hosts run at once, unless more are busy. Each is a pi of its own, about 200 MB (docs/native-host.md). */
export const MAX_LIVE_HOSTS = 4;

export type NativeConversationsOptions = {
  events: ConversationEvents;
  startHost: StartHost;
  /** Where the sessions are (sessions/folders.ts), asked at each use: a changed setting counts at once. */
  folders: () => SessionFolders;
  /** What mu gets in its environment for a conversation, besides the app's (hostEnv.ts in the app). */
  env: (conversation: { desktopSession: string; permissions?: string }) => Record<string, string>;
  /** Puts a removed conversation's session file away (the bin, in the app). */
  trash: (file: string) => Promise<void>;
  /**
   * The session files AionCore's mu conversations use (sessions/acpBindings.ts): the list leaves them out, so no
   * conversation is listed twice. None when left out.
   */
  bound?: () => Promise<ReadonlySet<string>>;
  idleMs?: number;
  maxLive?: number;
  now?: () => number;
  log?: (line: string) => void;
};

const unknown = (id: string): NativeRequestError =>
  new NativeRequestError('unknown-conversation', `No conversation has the id ${id}`);

const NONE: ReadonlySet<string> = new Set();

const listed = (session: StoredSession): NativeConversation => ({
  id: session.id,
  cwd: session.cwd,
  sessionFile: session.file,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  live: false,
  ...(session.messageCount !== undefined ? { messageCount: session.messageCount } : {}),
  ...(session.parentSession ? { forkedFrom: session.parentSession } : {}),
});

export class NativeConversations implements NativeConversationsApi {
  private readonly events: ConversationEvents;
  private readonly folders: () => SessionFolders;
  private readonly trash: (file: string) => Promise<void>;
  private readonly bound: () => Promise<ReadonlySet<string>>;
  private readonly idleMs: number;
  private readonly maxLive: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly store: SessionStore;
  private readonly reader = new SessionReader();
  private readonly owner: ConversationOwner;
  /** Conversations by the id they have now. */
  private readonly byId = new Map<string, Conversation>();
  /** Draft ids of conversations that have their session's id now. */
  private readonly drafts = new Map<string, Conversation>();
  /** Conversations by the name mu hands back to the app's browser (MU_DESKTOP_SESSION). */
  private readonly desktopSessions = new Map<string, Conversation>();
  /** Made from a session file (a list, an open): let go when the file is gone and no host runs. */
  private readonly fromFiles = new WeakSet<Conversation>();
  private readonly timers = new Map<Conversation, ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(options: NativeConversationsOptions) {
    this.events = options.events;
    this.folders = options.folders;
    this.trash = options.trash;
    this.bound = options.bound ?? (async () => NONE);
    this.idleMs = options.idleMs ?? IDLE_MS;
    this.maxLive = options.maxLive ?? MAX_LIVE_HOSTS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.warn(`[mu native] ${line}`));
    this.store = new SessionStore(options.folders);
    const env = options.env;
    this.owner = {
      events: options.events,
      startHost: options.startHost,
      view: (file) => this.reader.view(file),
      read: (file) => readSessionFile(file),
      env: (conversation) =>
        env({
          desktopSession: conversation.desktopSession,
          ...(conversation.permissions ? { permissions: conversation.permissions } : {}),
        }),
      defaultModel: () => readDefaultModel(this.folders().agentDir),
      renamed: (conversation, previous, left) => this.renamed(conversation, previous, left),
      touched: (conversation) => this.touched(conversation),
      makeRoom: (conversation) => this.makeRoom(conversation),
      now: () => this.now(),
      log: (line) => this.log(line),
    };
  }

  async list(): Promise<NativeConversation[]> {
    this.refuseClosed();
    const [sessions, bound] = await Promise.all([this.store.list(), this.bound().catch(() => NONE)]);
    const elsewhere = boundFile(bound);
    const out = new Map<string, NativeConversation>();
    for (const session of sessions) {
      if (out.has(session.id)) continue;
      const known = this.byId.get(session.id);
      // AionCore's conversation shows this session already, unless a native host runs it.
      if (!known?.live && elsewhere(session.file)) continue;
      known?.refresh(session);
      out.set(session.id, known ? known.describe() : listed(session));
    }
    // Forgetting one while going through them is safe: a Map goes on with the entries after it.
    for (const conversation of this.byId.values()) {
      if (out.has(conversation.id)) continue;
      // A session file that is gone (the command line removed it) takes its conversation along, unless a host runs.
      if (this.fromFiles.has(conversation) && !conversation.live) this.forget(conversation);
      else out.set(conversation.id, conversation.describe());
    }
    return [...out.values()].toSorted((a, b) => b.updatedAt - a.updatedAt);
  }

  async create(input: { cwd: string; permissions?: string }): Promise<NativeConversation> {
    this.refuseClosed();
    if (!path.isAbsolute(input.cwd)) throw new NativeRequestError('invalid', 'A conversation needs a full folder path');
    const folder = await stat(input.cwd).catch((): undefined => undefined);
    if (!folder?.isDirectory()) throw new NativeRequestError('invalid', `There is no folder ${input.cwd}`);
    const now = this.now();
    const conversation = this.add(
      new Conversation(this.owner, {
        id: `draft-${randomUUID()}`,
        draft: true,
        cwd: input.cwd,
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        ...(input.permissions ? { permissions: input.permissions } : {}),
      })
    );
    this.events.changed({ conversation: conversation.describe() });
    return conversation.describe();
  }

  async open(id: string): Promise<NativeSnapshot> {
    return (await this.find(id)).snapshot();
  }

  async request(id: string, command: PiCommand): Promise<unknown> {
    const conversation = await this.find(id);
    if (command.type === 'switch_session') this.refuseTaken(conversation, command.sessionPath);
    return conversation.request(command);
  }

  async respond(id: string, dialogId: string, answer: DialogAnswer): Promise<void> {
    (await this.find(id)).respond(dialogId, answer);
  }

  async close(id: string): Promise<void> {
    await (await this.find(id)).end();
  }

  async rename(id: string, name: string): Promise<void> {
    await (await this.find(id)).rename(name);
  }

  async remove(id: string): Promise<void> {
    const conversation = await this.find(id);
    this.refuseOutside(conversation.file);
    await conversation.end();
    // pi may have written the file while it shut down.
    const file = conversation.file;
    if (file && existsSync(file)) {
      this.refuseOutside(file);
      try {
        await this.trash(file);
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'ENOENT') throw error;
      }
      this.reader.forget(file);
    }
    this.forget(conversation);
    this.events.changed({ removed: conversation.id });
  }

  /** Only a file in mu's session folders is ever removed. */
  private refuseOutside(file: string | undefined): void {
    if (file && existsSync(file) && !insideSessionFolders(this.folders(), file))
      throw new NativeRequestError('invalid', `mu keeps no session at ${file}`);
  }

  /** Ends every host (the app quits). Calls after it fail with `closed`. */
  async dispose(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all([...this.byId.values()].map((conversation) => conversation.end().catch((): void => {})));
  }

  /** The id a conversation has now, by the name mu hands back to the app's browser (MU_DESKTOP_SESSION). */
  conversationOf(desktopSession: string): string | undefined {
    return this.desktopSessions.get(desktopSession)?.id;
  }

  /** How many hosts run or are starting. */
  get liveCount(): number {
    let count = 0;
    for (const conversation of this.byId.values()) if (conversation.live) count += 1;
    return count;
  }

  private refuseClosed(): void {
    if (this.closed) throw new NativeHostError('closed', 'The app is quitting');
  }

  /** The conversation with this id (a draft's included), made from its session file when none is held yet. */
  private async find(id: string): Promise<Conversation> {
    this.refuseClosed();
    const held = this.byId.get(id) ?? this.drafts.get(id);
    if (held) return held;
    const session = await this.store.find(id);
    // Another call may have made it meanwhile: one conversation per session.
    const made = this.byId.get(id) ?? this.drafts.get(id);
    if (made) return made;
    if (!session) throw unknown(id);
    return this.fromFile(session);
  }

  private fromFile(session: StoredSession): Conversation {
    const conversation = this.add(
      new Conversation(this.owner, {
        id: session.id,
        cwd: session.cwd,
        file: session.file,
        ...(session.name !== undefined ? { name: session.name } : {}),
        ...(session.firstText !== undefined ? { firstText: session.firstText } : {}),
        ...(session.messageCount !== undefined ? { messageCount: session.messageCount } : {}),
        ...(session.parentSession ? { forkedFrom: session.parentSession } : {}),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      })
    );
    this.fromFiles.add(conversation);
    return conversation;
  }

  private add(conversation: Conversation): Conversation {
    this.byId.set(conversation.id, conversation);
    this.desktopSessions.set(conversation.desktopSession, conversation);
    return conversation;
  }

  private forget(conversation: Conversation): void {
    if (this.byId.get(conversation.id) === conversation) this.byId.delete(conversation.id);
    for (const [draft, held] of this.drafts) if (held === conversation) this.drafts.delete(draft);
    if (this.desktopSessions.get(conversation.desktopSession) === conversation)
      this.desktopSessions.delete(conversation.desktopSession);
    const timer = this.timers.get(conversation);
    if (timer) clearTimeout(timer);
    this.timers.delete(conversation);
  }

  /** A `switch_session` to a session another conversation runs would have two pis write one file. */
  private refuseTaken(conversation: Conversation, sessionPath: string): void {
    const target = path.resolve(conversation.cwd, sessionPath);
    for (const other of this.byId.values())
      if (other !== conversation && other.live && other.file && path.resolve(other.file) === target)
        throw new NativeRequestError('invalid', 'That session is open in another conversation');
  }

  private renamed(conversation: Conversation, previous: string, left: string | undefined): void {
    if (this.byId.get(previous) === conversation) this.byId.delete(previous);
    // Its session is not the file it was made from any more: it stays in the list while that file is written.
    this.fromFiles.delete(conversation);
    // A session's id names that session: only a draft's (or a session's that pi never wrote) keeps pointing here.
    const kept = left !== undefined && existsSync(left) ? left : undefined;
    if (!kept) this.drafts.set(previous, conversation);
    const other = this.byId.get(conversation.id);
    if (other && other !== conversation) {
      // The session was a conversation of its own: this one is it now. One pi per session file, so a host that ran
      // it ends (a mu command switched into a session another conversation runs; the app refuses its own switch).
      for (const [draft, held] of this.drafts) if (held === other) this.drafts.set(draft, conversation);
      this.forget(other);
      if (other.live) {
        this.log(`session ${conversation.id} ran in two conversations; the older one ends`);
        void other.end().finally(() => this.events.changed({ conversation: conversation.describe() }));
      }
    }
    this.drafts.delete(conversation.id);
    this.byId.set(conversation.id, conversation);
    this.events.changed({ conversation: conversation.describe(), replaces: previous });
    if (kept) void this.announce(previous, kept);
  }

  /** The session a conversation moved away from is a conversation of its own again, from its file. */
  private async announce(id: string, file: string): Promise<void> {
    const session = await this.store.describe(file);
    if (!session || session.id !== id || this.byId.has(id) || this.closed) return;
    this.events.changed({ conversation: this.fromFile(session).describe() });
  }

  /** Something happened in `conversation`: its idle time starts over (a timer runs while its host does). */
  private touched(conversation: Conversation): void {
    conversation.lastUsed = this.now();
    if (conversation.live && !this.closed && !this.timers.has(conversation)) this.arm(conversation, this.idleMs);
  }

  private arm(conversation: Conversation, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(conversation);
      if (!conversation.live || this.closed) return;
      const quiet = this.now() - conversation.lastUsed;
      if (quiet < this.idleMs) this.arm(conversation, this.idleMs - quiet);
      else if (conversation.busy()) this.arm(conversation, this.idleMs);
      else void conversation.end().catch((error: unknown) => this.log(`an idle host did not end: ${String(error)}`));
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(conversation, timer);
  }

  /** At most `maxLive` hosts: the least recently used idle ones end for a new one. Busy ones never do. */
  private async makeRoom(starting: Conversation): Promise<void> {
    const live = [...this.byId.values()].filter((each) => each !== starting && each.live);
    const over = live.length + 1 - this.maxLive;
    if (over <= 0) return;
    const idle = live
      .filter((each) => !each.busy())
      .toSorted((a, b) => a.lastUsed - b.lastUsed)
      .slice(0, over);
    await Promise.all(idle.map((each) => each.end().catch((): void => {})));
  }
}
