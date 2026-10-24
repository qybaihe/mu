import { spawn as nodeSpawn } from 'node:child_process';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import type { Readable } from 'node:stream';
import { KyrnError } from '../../../common/kyrn/errors';
import {
  type DecisionModel,
  MODEL_COMMANDS,
  type ModelCommand,
  type ModelErrorKind,
  type ModelRequest,
  type ModelStep,
  type ModelsState,
  type ModelTask,
  MUDE_COMMANDS,
  type MudeAction,
  type MudeCommand,
  type MudeErrorKind,
  type MudeState,
  type MudeStatus,
  type MudeStep,
  type MudeTask,
} from '../../../common/kyrn/mude';
import { systemProxyEnv } from './config/systemProxy';
import { launcherOf, type Harness } from './harness';
import { muAgentDir } from './naming';
import { array, asRecord, endTree, launchCommand, text } from './piRpc';

/** What a command needs of a child process. */
export type MudeProcess = {
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  /** Ends it and what it started (the download, the Python installer). */
  kill(): void;
};

export type MudeDeps = {
  spawn: (command: string, args: string[], env: NodeJS.ProcessEnv) => MudeProcess;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  /** mu's agent folder, the one the settings read and mu's sessions use. */
  agentDir: string;
  /** The system's proxy as variables: the download goes through it like mu does. */
  proxyEnv: () => Record<string, string>;
  /** The Node a Node launcher runs on, and whether it is Electron (see launchCommand). */
  node: string;
  electron: boolean;
  /** Shows a folder in the file manager. */
  open: (folder: string) => Promise<void>;
  /** How long `status` may take before it is ended. */
  statusTimeoutMs: number;
};

/** How many lines of the Python installation are kept: enough to see it moving, and why it stopped. */
const LOG_LINES = 8;
const LINE_CHARS = 300;
const STDERR_LINES = 8;
// oxlint-disable-next-line no-control-regex -- terminal colour codes are what this removes
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const STEPS: ReadonlySet<string> = new Set<MudeStep>([
  'download',
  'python',
  'start',
  'enable',
  'disable',
  'stop',
  'uninstall',
]);
const KINDS: ReadonlySet<string> = new Set<MudeErrorKind>([
  'access',
  'network',
  'integrity',
  'aborted',
  'usage',
  'unsupported',
]);

const clean = (line: string): string => {
  const plain = line.replace(ANSI, '').trim();
  return plain.length > LINE_CHARS ? `${plain.slice(0, LINE_CHARS)}…` : plain;
};

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** A status line as the app keeps it; undefined when it is not one. */
export function parseStatus(value: unknown): MudeStatus | undefined {
  const row = asRecord(value);
  if (typeof row.supported !== 'boolean' || typeof row.installed !== 'boolean') return undefined;
  const pid = count(row.pid);
  const memory = count(row.memoryBytes);
  const downloaded = count(row.downloadedBytes);
  return {
    supported: row.supported,
    problems: array(row.problems).map(text).filter(Boolean),
    installed: row.installed,
    ...(downloaded > 0 ? { downloadedBytes: downloaded } : {}),
    pythonReady: row.pythonReady === true,
    running: row.running === true,
    ready: row.ready === true,
    port: count(row.port),
    ...(pid > 0 ? { pid } : {}),
    ...(memory > 0 ? { memoryBytes: memory } : {}),
    enabled: row.enabled === true,
    localOnly: row.localOnly === true,
    fallback: array(row.fallback).map(text).filter(Boolean),
    model: text(row.model),
    folder: text(row.folder),
    log: text(row.log),
  };
}

/** Splits what a stream prints into whole lines, keeping the unfinished last one for the next chunk. */
function lines(stream: Readable | null, each: (line: string) => void): () => void {
  let partial = '';
  stream?.on('data', (chunk: Buffer | string) => {
    const parts = `${partial}${String(chunk)}`.split(/\r?\n/);
    partial = parts.pop() ?? '';
    for (const part of parts) if (part.trim()) each(part);
  });
  // What is left when the stream ends.
  return () => {
    if (partial.trim()) each(partial);
    partial = '';
  };
}

/** The command and its arguments for `mu judge <words> --json` through mu's launcher, and its environment. */
function judgeCommand(
  harness: Pick<Harness, 'root' | 'layout'>,
  deps: MudeDeps,
  words: string[]
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const { platform, env, home, agentDir, node, electron, proxyEnv } = deps;
  const start = launchCommand(launcherOf(harness, platform), ['judge', ...words, '--json'], node, electron);
  // Paths of the platform mude runs on, not of the one that runs this (the tests run everywhere).
  const paths = platform === 'win32' ? win32 : posix;
  // A Mac app's PATH is short: where uv and Homebrew's tools usually are, for the Python environment.
  const extra = platform === 'darwin' ? [paths.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'] : [];
  const path = [...extra, env.PATH ?? ''].filter(Boolean).join(paths.delimiter);
  return {
    command: start.command,
    args: start.args,
    env: { ...env, ...proxyEnv(), ...start.env, MU_AGENT_DIR: agentDir, PATH: path },
  };
}

const defaults = (): MudeDeps => ({
  spawn: (command, args, env) => {
    const child = nodeSpawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // A process group of its own, so that cancelling ends the download and the Python installer it started too.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      on: child.on.bind(child),
      kill: () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          endTree(child.pid, 'SIGTERM', process.platform, {
            group: (leader, signal) => process.kill(-leader, signal),
            taskkill: (taskArgs) => {
              nodeSpawn('taskkill', taskArgs, { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
            },
            own: (signal) => child.kill(signal),
          });
        } catch {
          // Gone already.
        }
      },
    };
  },
  platform: process.platform,
  env: process.env,
  home: homedir(),
  agentDir: muAgentDir(),
  proxyEnv: systemProxyEnv,
  node: process.env.MU_NODE || process.execPath,
  electron: Boolean(process.versions.electron),
  open: async () => undefined,
  statusTimeoutMs: 30_000,
});

/**
 * mude as the app manages it: runs `mu judge mude <cmd> --json` through mu's launcher (as the app runs `mu auth` and
 * `mu import`), one command at a time, and keeps what its JSON lines report. Nothing here downloads or starts
 * anything itself. Offered on macOS only; the command says whether this Mac can run it.
 */
export class Mude {
  private harness: Pick<Harness, 'root' | 'layout'>;
  private deps: MudeDeps;
  private status?: MudeStatus;
  private problem?: string;
  private task?: MudeTask;
  private child?: MudeProcess;
  private reading?: Promise<void>;
  private next = 0;

  constructor(harness: Pick<Harness, 'root' | 'layout'>, deps: Partial<MudeDeps> = {}) {
    this.harness = harness;
    this.deps = { ...defaults(), ...deps };
  }

  private get available(): boolean {
    return this.deps.platform === 'darwin';
  }

  /** The command and its arguments for `mu judge mude <args> --json`, and its environment. */
  command(args: string[]): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
    return judgeCommand(this.harness, this.deps, ['mude', ...args]);
  }

  /** What the app knows of mude. With no command running, the status is asked for afresh first. */
  async state(): Promise<MudeState> {
    if (!this.available) return { available: false };
    if (this.task?.phase !== 'running') await this.refresh();
    return this.snapshot();
  }

  private snapshot(): MudeState {
    return {
      available: this.available,
      ...(this.status ? { status: { ...this.status } } : {}),
      ...(this.problem ? { problem: this.problem } : {}),
      ...(this.task ? { task: { ...this.task, log: [...this.task.log] } } : {}),
    };
  }

  /** Asks for the status; a request while one is asked for waits for that one. */
  private refresh(): Promise<void> {
    this.reading ??= this.readStatus().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }

  private readStatus(): Promise<void> {
    return new Promise((resolve) => {
      const start = this.command(['status']);
      let child: MudeProcess;
      try {
        child = this.deps.spawn(start.command, start.args, start.env);
      } catch (error) {
        this.problem = error instanceof Error ? error.message : String(error);
        resolve();
        return;
      }
      let found: MudeStatus | undefined;
      let error = '';
      const said: string[] = [];
      const take = (line: string) => {
        const event = parse(line);
        if (event?.type === 'status') found = parseStatus(event) ?? found;
        else if (event?.type === 'error') error = text(event.message) || error;
      };
      const flushOut = lines(child.stdout, take);
      const flushErr = lines(child.stderr, (line) => said.push(clean(line)));
      let ended = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const end = (code: number | null, why?: string) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        flushOut();
        flushErr();
        if (found) {
          this.status = found;
          this.problem = undefined;
        } else {
          this.problem =
            why ||
            error ||
            said.slice(-STDERR_LINES).join('\n') ||
            `mu judge mude status ended with code ${code ?? 'none'}`;
        }
        resolve();
      };
      timer = setTimeout(() => {
        child.kill();
        end(null, 'mu judge mude status did not answer in time');
      }, this.deps.statusTimeoutMs);
      child.on('error', (failure) => end(null, failure.message));
      child.on('close', (code) => end(code));
    });
  }

  /**
   * Runs a command unless one is running, which a request then only reads. `localOnly` chooses between
   * `--local-only` and `--with-fallback` for install and enable. `cancel` ends a running install; `open` shows
   * mude's folder.
   */
  async run(action: MudeAction, localOnly?: boolean): Promise<MudeState> {
    if (!this.available) throw new KyrnError('invalid', 'mude runs on macOS only');
    if (action === 'cancel') {
      if (this.task?.phase === 'running' && this.task.command === 'install') {
        this.task.phase = 'cancelled';
        this.child?.kill();
      }
      return this.snapshot();
    }
    if (action === 'open') {
      const folder = this.status?.folder;
      if (!folder) throw new KyrnError('invalid', 'mude has no folder yet');
      await this.deps.open(folder);
      return this.snapshot();
    }
    if (!MUDE_COMMANDS.includes(action)) throw new KyrnError('invalid', `Unknown mude action: ${String(action)}`);
    // A cancelled install still ending counts as running: a new command waits until it has.
    if (this.task?.phase === 'running' || this.child) return this.snapshot();
    this.start(action, flagsOf(action, localOnly));
    return this.snapshot();
  }

  private start(command: MudeCommand, flags: string[]): void {
    const task: MudeTask = { id: ++this.next, command, phase: 'running', log: [] };
    this.task = task;
    const start = this.command([command, ...flags]);
    let child: MudeProcess;
    try {
      child = this.deps.spawn(start.command, start.args, start.env);
    } catch (error) {
      task.phase = 'failed';
      task.error = { message: error instanceof Error ? error.message : String(error) };
      return;
    }
    this.child = child;
    const before = this.status;
    const said: string[] = [];
    let finished = false;
    const flushOut = lines(child.stdout, (line) => this.take(task, line));
    const flushErr = lines(child.stderr, (line) => {
      said.push(clean(line));
      said.splice(0, Math.max(0, said.length - STDERR_LINES));
    });
    const finish = (code: number | null, failure?: string) => {
      if (finished) return;
      finished = true;
      flushOut();
      flushErr();
      if (this.child === child) this.child = undefined;
      if (task.phase === 'cancelled') {
        // Where a cancelled install left things: what is downloaded stays, and the command resumes from it.
        void this.refresh();
        return;
      }
      if (code === 0 && !failure) {
        task.phase = 'done';
        task.download = undefined;
        // The command ends with its status; one that did not is asked.
        if (this.status === before) void this.refresh();
        return;
      }
      task.phase = 'failed';
      if (!task.error) {
        const message = failure || said.join('\n') || `mu judge mude ${command} ended with code ${code ?? 'none'}`;
        task.error = { message, ...(code === 2 ? { kind: 'usage' as const } : {}) };
      }
      void this.refresh();
    };
    child.on('error', (error) => finish(null, error.message));
    child.on('close', (code) => finish(code));
  }

  /** One line of the command's output. */
  private take(task: MudeTask, line: string): void {
    const event = parse(line);
    if (!event) {
      // Not JSON: something the command let through (a warning of Node's). Kept with the log, never lost.
      task.log = [...task.log, clean(line)].slice(-LOG_LINES);
      return;
    }
    if (event.type === 'step' && STEPS.has(text(event.step))) {
      task.step = text(event.step) as MudeStep;
      task.message = clean(text(event.message));
      if (task.step !== 'download') task.download = undefined;
    } else if (event.type === 'progress') {
      task.download = {
        file: text(event.file),
        done: count(event.done),
        total: count(event.total),
        checking: event.checking === true,
      };
    } else if (event.type === 'log') {
      const said = clean(text(event.line));
      if (said) task.log = [...task.log, said].slice(-LOG_LINES);
    } else if (event.type === 'status') {
      const status = parseStatus(event);
      if (status) {
        this.status = status;
        this.problem = undefined;
      }
    } else if (event.type === 'error') {
      const kind = text(event.kind);
      task.error = {
        message: clean(text(event.message)) || `mu judge mude ${task.command} failed`,
        ...(KINDS.has(kind) ? { kind: kind as MudeErrorKind } : {}),
      };
    }
  }

  /** Ends a command still running when the app quits: an install resumes next time. */
  dispose(): void {
    this.child?.kill();
    this.child = undefined;
  }
}

/**
 * The flags of a command: only local or with the judges behind it. Left out, install goes on the way the install it
 * continues was asked (the command keeps that choice), and enable keeps the current one.
 */
function flagsOf(command: MudeCommand, localOnly: boolean | undefined): string[] {
  if ((command === 'install' || command === 'enable') && localOnly !== undefined) {
    return [localOnly ? '--local-only' : '--with-fallback'];
  }
  return [];
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    const event = asRecord(value);
    return typeof event.type === 'string' ? event : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------

const MODEL_STEPS: ReadonlySet<string> = new Set<ModelStep>([
  'resolve',
  'model',
  'download',
  'python',
  'start',
  'enable',
  'disable',
  'remove',
]);

const MODEL_KINDS: ReadonlySet<string> = new Set([...KINDS, 'notFound', 'notRunnable']);

/** One model of `mu judge model list --json`, as the app keeps it; undefined when it is not one. */
export function parseModel(value: unknown): DecisionModel | undefined {
  const row = asRecord(value);
  const name = text(row.name);
  if (!name || typeof row.installed !== 'boolean') return undefined;
  return {
    name,
    label: text(row.label) || name,
    repo: text(row.repo),
    revision: text(row.revision),
    bytes: count(row.bytes),
    builtIn: row.builtIn === true,
    installed: row.installed,
    downloadedBytes: count(row.downloadedBytes),
    running: row.running === true,
    ready: row.ready === true,
    enabled: row.enabled === true,
    localOnly: row.localOnly === true,
  };
}

/**
 * Decision models from Hugging Face beside mude, as the app manages them: runs `mu judge model <cmd> --json` the way
 * Mude runs mude's commands, one at a time, and keeps the list it reports. Offered on macOS only.
 */
export class DecisionModels {
  private harness: Pick<Harness, 'root' | 'layout'>;
  private deps: MudeDeps;
  private models?: DecisionModel[];
  private problem?: string;
  private task?: ModelTask;
  private child?: MudeProcess;
  private reading?: Promise<void>;
  private next = 0;

  constructor(harness: Pick<Harness, 'root' | 'layout'>, deps: Partial<MudeDeps> = {}) {
    this.harness = harness;
    this.deps = { ...defaults(), ...deps };
  }

  private get available(): boolean {
    return this.deps.platform === 'darwin';
  }

  /** The command and its arguments for `mu judge model <args> --json`, and its environment. */
  command(args: string[]): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
    return judgeCommand(this.harness, this.deps, ['model', ...args]);
  }

  /** The models and what runs. With no command running, the list is asked for afresh first. */
  async state(): Promise<ModelsState> {
    if (!this.available) return { available: false };
    if (this.task?.phase !== 'running') await this.refresh();
    return this.snapshot();
  }

  private snapshot(): ModelsState {
    return {
      available: this.available,
      ...(this.models ? { models: this.models.map((model) => ({ ...model })) } : {}),
      ...(this.problem ? { problem: this.problem } : {}),
      ...(this.task ? { task: { ...this.task, log: [...this.task.log] } } : {}),
    };
  }

  private refresh(): Promise<void> {
    this.reading ??= this.readList().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }

  private readList(): Promise<void> {
    return new Promise((resolve) => {
      const start = this.command(['list']);
      let child: MudeProcess;
      try {
        child = this.deps.spawn(start.command, start.args, start.env);
      } catch (error) {
        this.problem = error instanceof Error ? error.message : String(error);
        resolve();
        return;
      }
      let found: DecisionModel[] | undefined;
      let error = '';
      const said: string[] = [];
      const flushOut = lines(child.stdout, (line) => {
        const event = parse(line);
        if (event?.type === 'models') {
          found = array(event.models)
            .map(parseModel)
            .filter((model): model is DecisionModel => model !== undefined);
        } else if (event?.type === 'error') error = text(event.message) || error;
      });
      const flushErr = lines(child.stderr, (line) => said.push(clean(line)));
      let ended = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const end = (code: number | null, why?: string) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        flushOut();
        flushErr();
        if (found) {
          this.models = found;
          this.problem = undefined;
        } else {
          this.problem =
            why ||
            error ||
            said.slice(-STDERR_LINES).join('\n') ||
            `mu judge model list ended with code ${code ?? 'none'}`;
        }
        resolve();
      };
      timer = setTimeout(() => {
        child.kill();
        end(null, 'mu judge model list did not answer in time');
      }, this.deps.statusTimeoutMs);
      child.on('error', (failure) => end(null, failure.message));
      child.on('close', (code) => end(code));
    });
  }

  /**
   * Runs a command unless one is running, which a request then only reads: add takes a link or owner/name, use,
   * disable and remove a model's name. `localOnly` chooses between `--local-only` and `--with-fallback` for add and use. `cancel`
   * ends a running add.
   */
  async run(request: ModelRequest): Promise<ModelsState> {
    if (!this.available) throw new KyrnError('invalid', 'Decision models run on macOS only');
    const { action } = request;
    if (action === 'cancel') {
      if (this.task?.phase === 'running' && this.task.command === 'add') {
        this.task.phase = 'cancelled';
        this.child?.kill();
      }
      return this.snapshot();
    }
    if (!MODEL_COMMANDS.includes(action)) throw new KyrnError('invalid', `Unknown model action: ${String(action)}`);
    const target = request.target?.trim() ?? '';
    // A link or a name, never an option the command would read as one.
    if (!target || target.startsWith('-')) throw new KyrnError('invalid', 'Name the model: a link or owner/name');
    if (this.task?.phase === 'running' || this.child) return this.snapshot();
    const flags =
      (action === 'add' || action === 'use') && request.localOnly !== undefined
        ? [request.localOnly ? '--local-only' : '--with-fallback']
        : [];
    this.start(action, target, flags);
    return this.snapshot();
  }

  private start(command: ModelCommand, target: string, flags: string[]): void {
    const task: ModelTask = { id: ++this.next, command, target, phase: 'running', log: [] };
    if (command !== 'add') task.name = target;
    this.task = task;
    const start = this.command([command, target, ...flags]);
    let child: MudeProcess;
    try {
      child = this.deps.spawn(start.command, start.args, start.env);
    } catch (error) {
      task.phase = 'failed';
      task.error = { message: error instanceof Error ? error.message : String(error) };
      return;
    }
    this.child = child;
    const said: string[] = [];
    let finished = false;
    const flushOut = lines(child.stdout, (line) => this.take(task, line));
    const flushErr = lines(child.stderr, (line) => {
      said.push(clean(line));
      said.splice(0, Math.max(0, said.length - STDERR_LINES));
    });
    const finish = (code: number | null, failure?: string) => {
      if (finished) return;
      finished = true;
      flushOut();
      flushErr();
      if (this.child === child) this.child = undefined;
      if (task.phase !== 'cancelled') {
        if (code === 0 && !failure) {
          task.phase = 'done';
          task.download = undefined;
        } else {
          task.phase = 'failed';
          if (!task.error) {
            const message = failure || said.join('\n') || `mu judge model ${command} ended with code ${code ?? 'none'}`;
            task.error = { message, ...(code === 2 ? { kind: 'usage' as const } : {}) };
          }
        }
      }
      // What changed (a model added, the judge switched, one removed), or where a stop left a download.
      void this.refresh();
    };
    child.on('error', (error) => finish(null, error.message));
    child.on('close', (code) => finish(code));
  }

  /** One line of the command's output. */
  private take(task: ModelTask, line: string): void {
    const event = parse(line);
    if (!event) {
      task.log = [...task.log, clean(line)].slice(-LOG_LINES);
      return;
    }
    if (event.type === 'model') {
      task.name = text(event.name) || task.name;
    } else if (event.type === 'step' && MODEL_STEPS.has(text(event.step))) {
      task.step = text(event.step) as ModelStep;
      task.message = clean(text(event.message));
      if (task.step !== 'download') task.download = undefined;
    } else if (event.type === 'progress') {
      task.download = {
        file: text(event.file),
        done: count(event.done),
        total: count(event.total),
        checking: event.checking === true,
      };
    } else if (event.type === 'log') {
      const said = clean(text(event.line));
      if (said) task.log = [...task.log, said].slice(-LOG_LINES);
    } else if (event.type === 'error') {
      const kind = text(event.kind);
      task.error = {
        message: clean(text(event.message)) || `mu judge model ${task.command} failed`,
        ...(MODEL_KINDS.has(kind) ? { kind: kind as ModelErrorKind } : {}),
      };
    }
  }

  dispose(): void {
    this.child?.kill();
    this.child = undefined;
  }
}
