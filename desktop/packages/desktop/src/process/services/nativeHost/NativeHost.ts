/**
 * The main process's side of one native host (entry.ts): it starts the host process, sends pi's RPC commands with ids
 * and pairs each response with its command, hands every record pi writes to its subscribers in arrival order, answers
 * pi's dialogs, and ends the process. See docs/native-host.md.
 *
 * It asks pi `get_state` once as it starts, to know whether pi has a model: its state then says `running` or
 * `needs-model`. That response reaches the subscribers like any other.
 *
 * It knows nothing of Electron: `fork` starts the process (an Electron utility process in the app, index.ts; a Node
 * child in tests and scripts), so the whole class runs under plain Node.
 */
import {
  asObject,
  hasModel,
  type DialogAnswer,
  type PiCommand,
  type PiCommandType,
  type PiRecord,
  type PiResponseDataOf,
} from '../../../common/utils/nativeHost/records.ts';
import { readFromHost, type ToHost } from './protocol.ts';

/**
 * off: MU_NATIVE_HOST=0. no-harness: no mu found, or no launcher in it. old-harness: a mu whose launcher
 * cannot plan a host. plan: the launcher refused (its message says why). no-models: pi stopped at its start because no
 * model is set up (a pi that stops for it; today's stays up, see `needs-model`). failed: the host stopped before pi
 * wrote anything. crashed: it stopped after. closed: it was disposed. timeout: a command had no answer in time.
 * command: pi answered a command with an error. no-folder: the project folder the session works in is gone, so no
 * host was started (a conversation of a deleted worktree or a temporary folder).
 */
export type NativeHostErrorKind =
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
  | 'no-folder';

export class NativeHostError extends Error {
  readonly kind: NativeHostErrorKind;
  /** The host's exit code, once it stopped. */
  readonly code: number | null | undefined;
  /** The end of the host's output (stderr, and stdout, which pi sends there too): where a crash says why. */
  readonly stderr: string;
  constructor(kind: NativeHostErrorKind, message: string, details: { code?: number | null; stderr?: string } = {}) {
    super(message);
    this.name = 'NativeHostError';
    this.kind = kind;
    this.code = details.code;
    this.stderr = details.stderr ?? '';
  }
}

/** How to start one host, as the launcher planned it (launch.ts). */
export type HostLaunch = {
  /** pi's module: its bundle in the npm package, its sources in a checkout. */
  module: string;
  /** pi's arguments: the judgment layer, then `--mode rpc` and the rest. */
  args: string[];
  /**
   * The Node options the launcher planned: a checkout's source resolver, none for the package. The host applies them
   * itself (entry.ts): Electron's utility process does not act on the ones it is started with.
   */
  execArgv: string[];
  env: Record<string, string>;
  /** The project the session works in: the host's working directory, which pi takes as the session's. */
  cwd: string;
};

/** The host process as the manager needs it: an Electron utility process, a Node child, or a stand-in in tests. */
export type HostChild = {
  readonly pid?: number;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  postMessage(message: ToHost): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  kill(): boolean;
};

/**
 * idle: not started. starting: the process runs, pi has not said yet what it runs with. running: pi has a model.
 * needs-model: pi runs without one, as it does when none is set up (the guide's job, not a failure); commands still
 * go through, and a `get_state`, `set_model` or `cycle_model` that names a model makes it `running`. failed: the host
 * stopped unasked, `error` says how (kind `no-models` for a pi that stopped for want of a model). stopped: disposed.
 */
export type NativeHostState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'running' }
  | { phase: 'needs-model' }
  | { phase: 'failed'; error: NativeHostError }
  | { phase: 'stopped' };

/**
 * How long a command may wait for its answer, in milliseconds: `command` once pi wrote its first record, `start` in
 * all for one sent before (a first start on a busy machine takes far longer than an answer). The same as the CLI
 * bridge's (piRpc.ts).
 */
export type HostDeadlines = { command: number; start: number };

/**
 * When each step of a start happened, in milliseconds since some fixed point (`performance.now()`): the fork, pi
 * imported (with `importMs`, the host's own count from its start), pi's first record, the first `get_state` answer.
 */
export type HostTimings = {
  forked?: number;
  imported?: number;
  importMs?: number;
  firstRecord?: number;
  firstState?: number;
  exited?: number;
};

export type NativeHostOptions = {
  launch: HostLaunch;
  fork: (launch: HostLaunch) => HostChild;
  deadlines?: HostDeadlines;
  /** pi's own log lines (`[mu] …` on its error output), as they come. */
  log?: (line: string) => void;
  now?: () => number;
};

const DEADLINES: HostDeadlines = { command: 30_000, start: 180_000 };

/**
 * Commands that take as long as they take: a turn (its response waits for the prompt's preflight and for any command
 * an extension runs, dialogs included), a compaction, the person's own shell command, and session changes that
 * extensions may ask about.
 */
const UNTIMED: ReadonlySet<PiCommandType> = new Set<PiCommandType>([
  'prompt',
  'steer',
  'follow_up',
  'compact',
  'bash',
  'new_session',
  'switch_session',
  'fork',
  'clone',
  'export_html',
]);

/** How much of the end of the host's output is kept. */
const OUTPUT_TAIL = 8 * 1024;
/** How pi marks a line of its error output meant for the log. */
const LOG_LINE = '[mu] ';
/** pi's words when nothing is set up (formatNoModelsAvailableMessage in the harness). */
const NO_MODELS = /No models available/;
/** How long the output of a process that exited may still take to arrive. */
const OUTPUT_GRACE_MS = 500;

// oxlint-disable-next-line no-control-regex -- terminal colour codes are what this removes
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

type Pending = {
  type: PiCommandType;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
  /** On the default deadline, which moves once pi runs. */
  defaultDeadline: boolean;
};

const isRecord = (value: unknown): value is PiRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as PiRecord).type === 'string';

const unref = (timer: ReturnType<typeof setTimeout>) => {
  (timer as { unref?: () => void }).unref?.();
  return timer;
};

export class NativeHost {
  readonly timings: HostTimings = {};
  private readonly launch: HostLaunch;
  private readonly fork: (launch: HostLaunch) => HostChild;
  private readonly deadlines: HostDeadlines;
  private readonly log: ((line: string) => void) | undefined;
  private readonly now: () => number;
  private child: HostChild | undefined;
  private current: NativeHostState = { phase: 'idle' };
  /** pi wrote a record: it runs, whatever it runs with. */
  private alive = false;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(record: PiRecord) => void>();
  private readonly stateListeners = new Set<(state: NativeHostState) => void>();
  private next = 0;
  private output = '';
  private partial = '';
  private streamsOpen = 0;
  private streamsEnded: (() => void)[] = [];
  private failure: string | undefined;
  private disposing: Promise<void> | undefined;
  private exitWaiters: (() => void)[] = [];

  constructor(options: NativeHostOptions) {
    this.launch = options.launch;
    this.fork = options.fork;
    this.deadlines = options.deadlines ?? DEADLINES;
    this.log = options.log;
    this.now = options.now ?? (() => performance.now());
  }

  get state(): NativeHostState {
    return this.current;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Starts the host process and hands it pi's module and arguments. Once only. */
  start(): void {
    if (this.current.phase !== 'idle') throw new NativeHostError('closed', 'This host was started already');
    this.setState({ phase: 'starting' });
    this.timings.forked = this.now();
    let child: HostChild;
    try {
      child = this.fork(this.launch);
    } catch (error) {
      this.finish(
        new NativeHostError('failed', `The mu host did not start: ${error instanceof Error ? error.message : error}`)
      );
      return;
    }
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      this.streamsOpen += 1;
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => this.keep(chunk, stream === child.stderr));
      stream.once('end', () => this.streamEnded());
    }
    child.on('message', (message) => this.receive(message));
    child.on('exit', (code) => void this.exited(code));
    this.post({ type: 'init', module: this.launch.module, args: this.launch.args, execArgv: this.launch.execArgv });
    // What pi runs with. The answer sets the state (learnModel); a host that never answers fails or times out anyway.
    this.request({ type: 'get_state' }).catch((): void => {});
  }

  /** Every record pi writes, in the order it came: responses, session events, extension UI requests. */
  subscribe(listener: (record: PiRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onState(listener: (state: NativeHostState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /**
   * Sends a command and resolves with its response's data, or rejects with pi's error. A turn's `prompt` resolves when
   * pi accepted it; the turn itself is over at `agent_settled`, in the subscription.
   */
  request<C extends PiCommand>(command: C, options: { timeoutMs?: number } = {}): Promise<PiResponseDataOf<C['type']>> {
    const unavailable = this.unavailable();
    if (unavailable) return Promise.reject(unavailable);
    const id = `h${++this.next}`;
    return new Promise((resolve, reject) => {
      const deadline =
        options.timeoutMs ??
        (UNTIMED.has(command.type) ? undefined : this.alive ? this.deadlines.command : this.deadlines.start);
      this.pending.set(id, {
        type: command.type,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: deadline === undefined ? undefined : this.expire(id, deadline),
        defaultDeadline: options.timeoutMs === undefined && deadline !== undefined,
      });
      this.post({ type: 'in', json: JSON.stringify({ ...command, id }) });
    });
  }

  /**
   * Answers one of pi's dialogs (an `extension_ui_request` of method select, confirm, input or editor). The answer is
   * also handed to the subscribers, in order, so a view closes the dialog it showed.
   */
  respondToDialog(id: string, answer: DialogAnswer): void {
    if (!id) throw new NativeHostError('command', 'A dialog answer needs the id of the dialog');
    const unavailable = this.unavailable();
    if (unavailable) throw unavailable;
    const record: PiRecord = { type: 'extension_ui_response', id, ...answer };
    this.post({ type: 'in', json: JSON.stringify(record) });
    this.emit(record);
  }

  /**
   * Ends pi's input, as closing its stdin does on the command line: pi shuts its session down and exits. A host that
   * has not exited after `graceMs` is killed. Resolves at the process's exit (an Electron utility process is still
   * finishing its exit then, and gone some 10 ms later); safe to call more than once.
   */
  dispose(graceMs = 3000): Promise<void> {
    this.disposing ??= this.stop(graceMs);
    return this.disposing;
  }

  private async stop(graceMs: number): Promise<void> {
    const child = this.child;
    const phase = this.current.phase;
    if (!child || phase === 'failed' || phase === 'stopped') {
      if (phase === 'idle') this.setState({ phase: 'stopped' });
      return;
    }
    const exited = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
    this.post({ type: 'end' });
    const inTime = await Promise.race([exited.then(() => true), this.delay(graceMs).then(() => false)]);
    if (inTime) return;
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    await Promise.race([exited, this.delay(1000)]);
    // A process that never says it exited is not waited for any longer (finish ignores a host that did).
    this.finish(undefined);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => unref(setTimeout(resolve, ms)));
  }

  /** Why a command cannot be sent now, if it cannot. */
  private unavailable(): NativeHostError | undefined {
    const state = this.current;
    if (state.phase === 'failed') return state.error;
    if (state.phase === 'stopped' || this.disposing) return new NativeHostError('closed', 'The mu host was closed');
    if (!this.child) return new NativeHostError('closed', 'The mu host has not been started');
    return undefined;
  }

  private post(message: ToHost): void {
    try {
      this.child?.postMessage(message);
    } catch {
      // The process is on its way out; its exit rejects what waits.
    }
  }

  private receive(message: unknown): void {
    const envelope = readFromHost(message);
    if (!envelope) return;
    if (envelope.type === 'ready') {
      this.timings.imported = this.now();
      this.timings.importMs = envelope.importMs;
      return;
    }
    if (envelope.type === 'failed') {
      this.failure = `The mu host could not ${envelope.stage === 'import' ? 'load pi' : 'start pi'}: ${envelope.message}`;
      return;
    }
    let record: unknown;
    try {
      record = JSON.parse(envelope.json);
    } catch {
      return;
    }
    if (!isRecord(record)) return;
    if (!this.alive) {
      this.alive = true;
      this.timings.firstRecord = this.now();
      this.rearm();
    }
    if (record.type === 'response') {
      this.answer(record);
      this.learnModel(record);
    }
    this.emit(record);
  }

  /** pi named the model it runs with, in a `get_state`, `set_model` or `cycle_model` response. */
  private learnModel(record: PiRecord): void {
    if (record.success !== true) return;
    const data = asObject(record.data);
    let model: unknown;
    if (record.command === 'get_state') {
      this.timings.firstState ??= this.now();
      model = data.model;
    } else if (record.command === 'set_model') model = data;
    // null: there was no other model to cycle to, and the model did not change.
    else if (record.command === 'cycle_model' && record.data) model = data.model;
    else return;
    const phase = this.current.phase;
    if (phase !== 'starting' && phase !== 'running' && phase !== 'needs-model') return;
    const next = hasModel(model) ? 'running' : 'needs-model';
    if (next !== phase) this.setState({ phase: next });
  }

  /** Settles the command a response answers. */
  private answer(record: PiRecord): void {
    const id = typeof record.id === 'string' ? record.id : '';
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    clearTimeout(request.timer);
    if (record.success === true) request.resolve(record.data);
    else
      request.reject(
        new NativeHostError('command', typeof record.error === 'string' && record.error ? record.error : 'mu refused')
      );
  }

  private emit(record: PiRecord): void {
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch (error) {
        this.log?.(`a native host listener failed on a ${record.type} record: ${String(error)}`);
      }
    }
  }

  private setState(state: NativeHostState): void {
    this.current = state;
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch (error) {
        this.log?.(`a native host state listener failed: ${String(error)}`);
      }
    }
  }

  private expire(id: string, ms: number): ReturnType<typeof setTimeout> {
    return unref(
      setTimeout(() => {
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        request.reject(new NativeHostError('timeout', `mu did not answer ${request.type} in ${ms} ms`));
      }, ms)
    );
  }

  /** pi runs: commands that waited for it to start get the usual deadline from now. */
  private rearm(): void {
    for (const [id, request] of this.pending) {
      if (!request.defaultDeadline) continue;
      clearTimeout(request.timer);
      request.timer = this.expire(id, this.deadlines.command);
    }
  }

  /** Keeps the end of the host's output, and passes pi's log lines on. */
  private keep(chunk: string, stderr: boolean): void {
    this.output = `${this.output}${chunk}`.slice(-OUTPUT_TAIL);
    if (!stderr || !this.log) return;
    const lines = `${this.partial}${chunk}`.split(/\r?\n/);
    this.partial = (lines.pop() ?? '').slice(0, OUTPUT_TAIL);
    for (const line of lines) if (line.startsWith(LOG_LINE)) this.log(line.slice(LOG_LINE.length));
  }

  private streamEnded(): void {
    this.streamsOpen -= 1;
    if (this.streamsOpen > 0) return;
    for (const resolve of this.streamsEnded.splice(0)) resolve();
  }

  /** The output a process writes just before it exits can arrive after the exit: wait for it, briefly. */
  private outputDone(): Promise<void> {
    if (this.streamsOpen <= 0) return Promise.resolve();
    return Promise.race([new Promise<void>((resolve) => this.streamsEnded.push(resolve)), this.delay(OUTPUT_GRACE_MS)]);
  }

  private async exited(code: number | null): Promise<void> {
    this.timings.exited = this.now();
    // Only a host that stopped by itself has something to say after its exit. An Electron utility process's output
    // streams had not ended 500 ms after it exited (measured), so waiting for them made every dispose that long.
    if (!this.disposing) await this.outputDone();
    const stderr = this.output.replace(ANSI, '').trim();
    if (this.disposing) this.finish(undefined);
    else if (!this.alive && NO_MODELS.test(stderr)) {
      const line = stderr.split('\n').find((each) => NO_MODELS.test(each)) ?? 'No models available.';
      this.finish(new NativeHostError('no-models', line.trim(), { code, stderr }));
    } else {
      const message =
        this.failure ??
        (this.alive
          ? `The mu host stopped by itself (exit code ${code ?? 'none'})`
          : `The mu host stopped before pi started (exit code ${code ?? 'none'})`);
      this.finish(new NativeHostError(this.alive ? 'crashed' : 'failed', message, { code, stderr }));
    }
    for (const resolve of this.exitWaiters.splice(0)) resolve();
  }

  /** The end: `error` for a host that stopped unasked, none for one that was disposed. Rejects what still waits. */
  private finish(error: NativeHostError | undefined): void {
    const state = this.current.phase;
    if (state === 'stopped' || state === 'failed') return;
    const reason = error ?? new NativeHostError('closed', 'The mu host was closed');
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(reason);
    }
    this.pending.clear();
    this.setState(error ? { phase: 'failed', error } : { phase: 'stopped' });
  }
}
