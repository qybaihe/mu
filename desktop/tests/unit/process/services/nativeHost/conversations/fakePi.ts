import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PRESENTATION_STATUS_KEY } from '../../../../../../packages/desktop/src/common/utils/nativeHost/presentation.ts';
import type {
  DialogAnswer,
  JsonObject,
  PiCommand,
  PiRecord,
} from '../../../../../../packages/desktop/src/common/utils/nativeHost/records.ts';
import type {
  ConversationHost,
  StartHost,
} from '../../../../../../packages/desktop/src/process/services/nativeHost/conversations/types.ts';
import {
  NativeHostError,
  type NativeHostState,
} from '../../../../../../packages/desktop/src/process/services/nativeHost/NativeHost.ts';

/**
 * A stand-in for pi behind a native host, for the native conversation tests: sessions as pi keeps them (a tree of
 * entries, a leaf, a file written from the first reply on), the RPC commands the conversations send, turns that stream
 * records the way pi's RPC mode does, and what mu's slash commands do to the session (`/clear`, a rewind, a
 * permission switch, a command that asks).
 */

export type FakeModel = { provider: string; id: string };
type Session = { id: string; file: string; header: JsonObject; entries: JsonObject[]; leafId: string | null };

const MODES = [{ id: 'full' }, { id: 'jev' }, { id: 'ask' }];
const tick = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

/** A presentation frame of the judgment layer, as pi's RPC mode carries it. */
export const frame = (kind: string, payload: JsonObject): PiRecord => ({
  type: 'extension_ui_request',
  id: `status-${kind}`,
  method: 'setStatus',
  statusKey: PRESENTATION_STATUS_KEY,
  statusText: JSON.stringify({ version: 1, kind, payload }),
});

export class FakePi {
  readonly hosts: FakeHost[] = [];
  readonly sessionsDir: string;
  /** The model a new host runs with; none makes it start without one. */
  model: FakeModel | undefined = { provider: 'e2e', id: 'fake' };
  available: FakeModel[] = [{ provider: 'e2e', id: 'fake' }];
  /** A start that fails with this. */
  failStart: NativeHostError | undefined;
  /** Starts wait for this before their host runs. */
  gate: Promise<void> | undefined;
  private counter = 0;

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
  }

  readonly startHost: StartHost = async (input) => {
    await tick();
    await this.gate;
    if (this.failStart) throw this.failStart;
    const host = new FakeHost(this, input);
    this.hosts.push(host);
    host.boot();
    return host;
  };

  nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}${this.counter}`;
  }

  /** The hosts that run. */
  get running(): FakeHost[] {
    return this.hosts.filter((host) => !host.disposed);
  }

  get last(): FakeHost {
    const host = this.hosts.at(-1);
    if (!host) throw new Error('no host started');
    return host;
  }
}

export class FakeHost implements ConversationHost {
  state: NativeHostState = { phase: 'starting' };
  readonly input: Parameters<StartHost>[0];
  readonly sent: PiCommand[] = [];
  disposed = false;
  session: Session = { id: '', file: '', header: {}, entries: [], leafId: null };
  model: FakeModel | undefined;
  /** The next prompts are refused with these words, one each. */
  readonly refusals: string[] = [];
  /** The run in progress. */
  turn: Promise<void> = Promise.resolve();
  private readonly pi: FakePi;
  private readonly listeners = new Set<(record: PiRecord) => void>();
  private readonly stateListeners = new Set<(state: NativeHostState) => void>();
  private readonly dialogs = new Map<string, (answer: DialogAnswer) => void>();
  private streaming = false;

  constructor(pi: FakePi, input: Parameters<StartHost>[0]) {
    this.pi = pi;
    this.input = input;
    this.model = pi.model;
  }

  boot(): void {
    this.session = this.input.session ? this.load(this.input.session) : this.fresh();
    // mu says its permission mode as it starts, before it answers anything.
    this.emit(frame('permissions.mode', { mode: this.input.env.MU_PERMISSIONS || 'full', modes: MODES }));
    queueMicrotask(() => {
      if (!this.disposed) this.setState({ phase: this.model ? 'running' : 'needs-model' });
    });
  }

  subscribe(listener: (record: PiRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onState(listener: (state: NativeHostState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  async request<C extends PiCommand>(command: C): Promise<never> {
    this.sent.push(command);
    if (this.disposed) throw new NativeHostError('closed', 'The mu host was closed');
    await tick();
    if (this.disposed) throw new NativeHostError('closed', 'The mu host was closed');
    let data: unknown;
    try {
      data = await this.answer(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: 'response', command: command.type, success: false, error: message });
      throw new NativeHostError('command', message);
    }
    this.emit({ type: 'response', command: command.type, success: true, ...(data === undefined ? {} : { data }) });
    return data as never;
  }

  respondToDialog(id: string, answer: DialogAnswer): void {
    if (this.disposed) throw new NativeHostError('closed', 'The mu host was closed');
    this.emit({ type: 'extension_ui_response', id, ...answer });
    this.dialogs.get(id)?.(answer);
    this.dialogs.delete(id);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.setState({ phase: 'stopped' });
  }

  /** The process stops unasked. */
  crash(): void {
    this.disposed = true;
    this.setState({
      phase: 'failed',
      error: new NativeHostError('crashed', 'The mu host stopped by itself (exit code 1)', { code: 1, stderr: 'boom' }),
    });
  }

  emit(record: PiRecord): void {
    for (const listener of this.listeners) listener(record);
  }

  private setState(state: NativeHostState): void {
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }

  private fresh(): Session {
    const id = this.pi.nextId('s');
    const file = join(this.pi.sessionsDir, `--${this.input.cwd.replace(/\//g, '-')}--`, `2026_${id}.jsonl`);
    return {
      id,
      file,
      header: { type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: this.input.cwd },
      entries: [],
      leafId: null,
    };
  }

  private load(file: string): Session {
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonObject);
    const [header, ...entries] = lines;
    return { id: String(header.id), file, header, entries, leafId: (entries.at(-1)?.id as string) ?? null };
  }

  /** pi appends to its tree at the leaf, and writes the file once the session has a reply. */
  private append(entry: JsonObject): JsonObject {
    const full = {
      ...entry,
      id: this.pi.nextId('e'),
      parentId: this.session.leafId,
      timestamp: new Date().toISOString(),
    };
    this.session.entries.push(full);
    this.session.leafId = full.id;
    const replied = this.session.entries.some(
      (each) => each.type === 'message' && (each.message as JsonObject).role === 'assistant'
    );
    if (replied) {
      mkdirSync(dirname(this.session.file), { recursive: true });
      const lines = [this.session.header, ...this.session.entries].map((line) => `${JSON.stringify(line)}\n`);
      writeFileSync(this.session.file, lines.join(''));
    }
    return full;
  }

  private stateData(): JsonObject {
    return {
      ...(this.model ? { model: { ...this.model, name: this.model.id } } : {}),
      thinkingLevel: 'off',
      isStreaming: this.streaming,
      isCompacting: false,
      steeringMode: 'all',
      followUpMode: 'all',
      sessionFile: this.session.file,
      sessionId: this.session.id,
      autoCompactionEnabled: true,
      messageCount: this.session.entries.length,
      pendingMessageCount: 0,
    };
  }

  private async answer(command: PiCommand): Promise<unknown> {
    switch (command.type) {
      case 'get_state':
        return this.stateData();
      case 'get_entries': {
        const { entries } = this.session;
        if (command.since === undefined) return { entries, leafId: this.session.leafId };
        const index = entries.findIndex((entry) => entry.id === command.since);
        if (index < 0) throw new Error(`Entry not found: ${command.since}`);
        return { entries: entries.slice(index + 1), leafId: this.session.leafId };
      }
      case 'get_available_models':
        return { models: this.pi.available.map((model) => ({ ...model, name: model.id })) };
      case 'set_model': {
        this.model = { provider: command.provider, id: command.modelId };
        this.setState({ phase: 'running' });
        return { ...this.model, name: this.model.id };
      }
      case 'new_session':
        this.session = this.fresh();
        return { cancelled: false };
      case 'switch_session':
        this.session = this.load(command.sessionPath);
        return { cancelled: false };
      case 'prompt':
        return this.prompt(command.message);
      case 'set_session_name': {
        // As pi's AgentSession.setSessionName: a session_info entry at the leaf, then the event.
        this.append({ type: 'session_info', name: command.name });
        this.emit({ type: 'session_info_changed', name: command.name });
        return undefined;
      }
      default:
        return undefined;
    }
  }

  private async prompt(message: string): Promise<unknown> {
    const refusal = this.refusals.shift();
    if (refusal) throw new Error(refusal);
    const [word, argument] = message.split(' ');
    switch (word) {
      case '/clear':
        this.session = this.fresh();
        return undefined;
      case '/rewind':
        // mu's checkpoint rewind moves the leaf back; nothing is written until the next entry.
        this.session.leafId = argument;
        return undefined;
      case '/permissions':
        this.emit(frame('permissions.mode', { mode: argument, modes: MODES }));
        this.emit({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: `Mode: ${argument}` });
        return undefined;
      case '/ask':
        // An extension command that asks first: pi answers the prompt once the command is done. With a timeout, pi
        // stops waiting after it and takes the default, without a word.
        return new Promise((resolve) => {
          this.dialogs.set('d1', () => resolve(undefined));
          const timeout = argument ? Number(argument) : undefined;
          if (timeout) setTimeout(() => this.dialogs.delete('d1') && resolve(undefined), timeout);
          this.emit({
            type: 'extension_ui_request',
            id: 'd1',
            method: 'confirm',
            title: 'Sure?',
            message: 'Go on?',
            ...(timeout ? { timeout } : {}),
          });
        });
      default:
        if (!this.model) throw new Error('No model selected');
        this.turn = this.run(message);
        return undefined;
    }
  }

  /** A turn, as pi's RPC mode streams it: the user message, the reply in deltas, the end. */
  private async run(text: string): Promise<void> {
    await tick();
    await tick();
    if (this.disposed) return;
    this.streaming = true;
    this.emit({ type: 'agent_start' });
    const now = Date.now();
    const userMessage = { role: 'user', content: [{ type: 'text', text }], timestamp: now };
    this.emit({ type: 'message_start', message: userMessage });
    const userEntry = this.append({ type: 'message', message: userMessage });
    this.emit({ type: 'message_end', message: userMessage, entryId: userEntry.id });
    const reply = `echo: ${text}`;
    const partial = {
      role: 'assistant',
      content: [],
      provider: 'e2e',
      model: 'fake',
      stopReason: 'stop',
      timestamp: now,
    };
    this.emit({ type: 'message_start', message: partial });
    this.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
    });
    this.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: reply },
    });
    this.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: reply },
    });
    const assistantMessage = { ...partial, content: [{ type: 'text', text: reply }] };
    const assistantEntry = this.append({ type: 'message', message: assistantMessage });
    this.emit({ type: 'message_end', message: assistantMessage, entryId: assistantEntry.id });
    await tick();
    this.streaming = false;
    this.emit({ type: 'agent_end', messages: [] });
    this.emit({ type: 'agent_settled' });
  }
}
