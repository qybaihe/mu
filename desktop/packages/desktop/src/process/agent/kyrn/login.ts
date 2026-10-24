import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import {
  isSubscriptionProvider,
  LOGIN_ERROR_CODES,
  type LoginModel,
  type LoginPrompt,
  type LoginStartOptions,
  type LoginState,
  type LoginStatus,
  type SubscriptionProvider,
} from '../../../common/kyrn/login';
import { systemProxyEnv } from './config/systemProxy';
import { endTree, launchCommand } from './piRpc';

/**
 * What the manager needs of the runner process: lines out, lines in, and a way to end it. Its end is read from
 * `close`, not `exit`: `exit` can come before the last lines on stdout have been read.
 */
export type RunnerProcess = {
  stdout: Readable;
  stdin: Writable;
  kill(): void;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
};
export type SpawnRunner = (args: string[]) => RunnerProcess;

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Only a web page is opened in the browser: the address of the provider's sign-in page. */
export function openable(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function toPrompt(value: unknown): LoginPrompt {
  const prompt = record(value);
  const type = ['manual_code', 'text', 'secret', 'select'].includes(str(prompt.type))
    ? (str(prompt.type) as LoginPrompt['type'])
    : 'text';
  const options = Array.isArray(prompt.options)
    ? prompt.options.map(record).map((option) => ({
        id: str(option.id),
        label: str(option.label),
        description: str(option.description) || undefined,
      }))
    : undefined;
  return { type, message: str(prompt.message), placeholder: str(prompt.placeholder) || undefined, options };
}

/** What pi's flows throw when the person stops them. */
const CANCELLED = 'Login cancelled';
/**
 * The longest a sign-in may wait for the person. A flow that is never finished (the browser page closed, the
 * provider's own cancel) would otherwise keep its callback port until the app quits.
 */
const LOGIN_LIMIT_MS = 15 * 60_000;
/** How long a sign-in runner told to stop gets before it is ended. A well one closes its port in a tenth of a second. */
const KILL_AFTER_MS = 1500;
/**
 * The longest a new sign-in waits for the runner before it to end. That runner may still listen on the callback port
 * (ChatGPT's is always 1455), where the new one would find it taken. Past this, the new one starts anyway: it takes
 * the port over from a sign-in of mu's by itself.
 */
const STOP_LIMIT_MS = 3000;

/** A sign-in's runner, and its end: `close`, or `error` when it never started. */
type Run = { process: RunnerProcess; closed: Promise<void> };

/** What the app can act on in a runner's error line: its code, and for `port_in_use` the port and who keeps it. */
function errorDetails(message: Json): Pick<LoginState, 'code' | 'port' | 'holder'> {
  const code = LOGIN_ERROR_CODES.find((known) => known === message.code);
  if (code !== 'port_in_use') return code ? { code } : {};
  const found = record(message.holder);
  const holder = {
    ...(typeof found.pid === 'number' && Number.isInteger(found.pid) && found.pid > 0 ? { pid: found.pid } : {}),
    ...(str(found.command) ? { command: str(found.command) } : {}),
    ...(found.pi === true ? { pi: true } : {}),
  };
  return {
    code,
    ...(typeof message.port === 'number' ? { port: message.port } : {}),
    ...(Object.keys(holder).length ? { holder } : {}),
  };
}

const toModels = (value: unknown): LoginModel[] =>
  (Array.isArray(value) ? value : [])
    .map(record)
    .filter((model) => str(model.id))
    .map((model) => ({ id: str(model.id), name: str(model.name) || str(model.id) }));

/**
 * One sign-in at a time. The flow runs in a child process, `mu auth` (pi's code, pi's credential store); this keeps the
 * state a screen polls, opens the provider's page in the browser, and passes the person's answer to a prompt back in.
 */
export class LoginManager {
  private current: LoginState = { id: 0, phase: 'idle' };
  private child: Run | undefined;
  /**
   * Sign-in runners told to stop that have not ended yet, each with its end (at most STOP_LIMIT_MS away). The next
   * sign-in or sign-out starts once they have ended.
   */
  private readonly stopping = new Map<RunnerProcess, Promise<void>>();
  /** The runs of `status` and `logout` still going, which end with the app (see dispose). */
  private readonly runs = new Set<RunnerProcess>();
  /**
   * The look at who is signed in that runs now. Every screen that opens asks; the ones that ask while it runs get its
   * answer. Two runners at once fought over mu's model store: the first could exit holding its lock, and the second,
   * and the conversation started next, waited half a minute for it.
   */
  private looking: Promise<LoginStatus> | undefined;
  /** The `status` or `logout` runner going now, if any: the next one starts when it has ended. */
  private running: Promise<unknown> | undefined;
  /** The app quits: no runner starts any more. */
  private disposed = false;
  /** Settles when the app quits: nothing waits for a runner to end then, they are all ended at once. */
  private readonly quitting: Promise<void>;
  private quit: () => void = () => {};
  private limit: ReturnType<typeof setTimeout> | undefined;
  private readonly spawnRunner: SpawnRunner;
  private readonly openUrl: (url: string) => void;

  constructor(spawnRunner: SpawnRunner, openUrl: (url: string) => void) {
    this.spawnRunner = spawnRunner;
    this.openUrl = openUrl;
    this.quitting = new Promise((resolve) => {
      this.quit = resolve;
    });
  }

  state(): LoginState {
    return this.current;
  }

  /**
   * Starts a sign-in, ending the one before it. The new runner starts once the old one has ended: the old one may still
   * listen on the callback port, and the new one would find the port taken.
   */
  start(provider: SubscriptionProvider, options: LoginStartOptions = {}): LoginState {
    if (!isSubscriptionProvider(provider)) throw new Error('Unknown provider');
    const ended = this.stopChild();
    const id = this.current.id + 1;
    const paste = options.paste === true;
    this.current = { id, provider, phase: 'running', ...(paste ? { paste } : {}) };
    this.limit = setTimeout(() => {
      if (this.current.id !== id || this.current.phase !== 'running' || this.current.stored) return;
      this.current = {
        ...this.current,
        phase: 'failed',
        prompt: undefined,
        error: 'The sign-in waited too long and was stopped',
      };
      void this.stopChild();
    }, LOGIN_LIMIT_MS);
    this.limit.unref?.();
    if (this.stopping.size === 0) this.run(id, provider, paste);
    else void ended.then(() => this.run(id, provider, paste));
    return this.current;
  }

  /** Runs sign-in `id`, unless it was cancelled or replaced while the runner before it was ending, or the app quits. */
  private run(id: number, provider: SubscriptionProvider, paste: boolean): void {
    if (this.disposed || this.current.id !== id || this.current.phase !== 'running') return;
    const update = (patch: Partial<LoginState>) => {
      if (this.current.id === id) this.current = { ...this.current, ...patch };
    };
    let child: RunnerProcess;
    try {
      child = this.spawnRunner(['login', provider, ...(paste ? ['--paste'] : [])]);
    } catch (error) {
      update({ phase: 'failed', prompt: undefined, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const closed = new Promise<void>((resolve) => {
      child.on('close', () => resolve());
      child.on('error', () => resolve());
    });
    const run: Run = { process: child, closed };
    this.child = run;
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message: Json;
      try {
        message = record(JSON.parse(line));
      } catch {
        return;
      }
      if (message.type === 'event') {
        const event = record(message.event);
        if (event.type === 'auth_url' && openable(event.url)) {
          update({ url: event.url, message: str(event.instructions) || undefined });
          this.openUrl(event.url);
        } else if (event.type === 'device_code') {
          const page = openable(event.verificationUri) ? event.verificationUri : undefined;
          update({ device: { userCode: str(event.userCode), verificationUri: page ?? '' }, url: page });
          if (page) this.openUrl(page);
        } else if (event.type === 'info' || event.type === 'progress') {
          update({ message: str(event.message) || undefined });
        }
      } else if (message.type === 'prompt') update({ prompt: toPrompt(message.prompt) });
      else if (message.type === 'prompt_done') update({ prompt: undefined });
      else if (message.type === 'signed_in') update({ stored: true, prompt: undefined });
      else if (message.type === 'done') update({ phase: 'done', prompt: undefined, models: toModels(message.models) });
      else if (message.type === 'error' && this.current.phase === 'running')
        update(
          // The person said no inside the flow (the risk question of a Google sign-in): not a failure.
          str(message.message) === CANCELLED
            ? { phase: 'cancelled', prompt: undefined }
            : {
                phase: 'failed',
                prompt: undefined,
                error: str(message.message) || 'The sign-in failed',
                ...errorDetails(message),
              }
        );
    });
    child.on('close', (code) => {
      if (this.child === run) {
        this.child = undefined;
        clearTimeout(this.limit);
        this.limit = undefined;
      }
      if (this.current.id === id && this.current.phase === 'running')
        update({
          phase: code === 0 ? 'done' : 'failed',
          prompt: undefined,
          error: code === 0 ? undefined : 'The sign-in stopped',
        });
    });
    child.on('error', (error) => update({ phase: 'failed', prompt: undefined, error: error.message }));
  }

  /** The person's answer to the prompt of sign-in `id`. An answer to an older sign-in is dropped. */
  answer(id: number, value: string): LoginState {
    if (this.current.id !== id || !this.child || !this.current.prompt) return this.current;
    this.child.process.stdin.write(`${JSON.stringify({ type: 'answer', value })}\n`);
    this.current = { ...this.current, prompt: undefined };
    return this.current;
  }

  cancel(): LoginState {
    if (this.current.phase === 'running') this.current = { ...this.current, phase: 'cancelled', prompt: undefined };
    void this.stopChild();
    return this.current;
  }

  /**
   * Ends every run still going: the app quits, and nothing it started may outlive it. A `status` run through a
   * checkout's tsx can take half a minute on a busy machine; left alone, it kept running after the quit. At a quit
   * there is no time for a sign-in to wind down: it is ended at once too.
   */
  dispose(): void {
    this.disposed = true;
    this.quit();
    clearTimeout(this.limit);
    this.limit = undefined;
    const child = this.child;
    this.child = undefined;
    for (const run of [...(child ? [child.process] : []), ...this.stopping.keys(), ...this.runs]) {
      try {
        run.kill();
      } catch {
        // Already gone.
      }
    }
    this.runs.clear();
  }

  /**
   * Who is signed in already. Nothing is known when the runner cannot start: then nobody is. One look at a time: a
   * look asked for while one runs gets that one's answer.
   */
  status(timeoutMs = 20000): Promise<LoginStatus> {
    if (this.looking) return this.looking;
    const nobody: LoginStatus = { signedIn: [] };
    const look = this.oneAtATime(() => this.statusAfter(['status'], timeoutMs)).catch(() => nobody);
    this.looking = look;
    void look.finally(() => {
      if (this.looking === look) this.looking = undefined;
    });
    return look;
  }

  /**
   * Signs out of a subscription (its OAuth credential only) and says who is still signed in. A sign-in still under way
   * ends first, and the sign-out starts once its runner has: that runner keeps the callback port, and writes the
   * credential store the sign-out changes.
   */
  logout(provider: SubscriptionProvider, timeoutMs = 20000): Promise<LoginStatus> {
    if (!isSubscriptionProvider(provider)) return Promise.reject(new Error('Unknown provider'));
    if (this.current.phase === 'running') this.current = { ...this.current, phase: 'cancelled', prompt: undefined };
    const ended = this.stopChild();
    const signOut = () => this.statusAfter(['logout', provider], timeoutMs);
    return this.oneAtATime(this.stopping.size === 0 ? signOut : () => ended.then(signOut));
  }

  /** Starts `work` now when no runner is going, else once the one going has ended. */
  private oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    const before = this.running;
    const next = before ? before.then(work, work) : work();
    const settled = next.catch((): void => {});
    this.running = settled;
    void settled.finally(() => {
      if (this.running === settled) this.running = undefined;
    });
    return next;
  }

  /** Runs the runner once and reads the status line it ends with; its error, if it says one, is the failure. */
  private statusAfter(args: string[], timeoutMs: number): Promise<LoginStatus> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('The app is quitting'));
        return;
      }
      let child: RunnerProcess;
      try {
        child = this.spawnRunner(args);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.runs.add(child);
      let settled = false;
      let failure = '';
      const finish = (status?: LoginStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (status) resolve(status);
        else reject(new Error(failure || 'The sign-in helper did not answer'));
      };
      const timer = setTimeout(() => {
        finish();
        child.kill();
      }, timeoutMs);
      createInterface({ input: child.stdout }).on('line', (line) => {
        let message: Json;
        try {
          message = record(JSON.parse(line));
        } catch {
          return;
        }
        if (message.type === 'error') failure = str(message.message);
        if (message.type !== 'status') return;
        const signedIn = (Array.isArray(message.signedIn) ? message.signedIn : [])
          .map(record)
          .filter((entry) => isSubscriptionProvider(entry.provider))
          .map((entry) => ({ provider: entry.provider as SubscriptionProvider, models: toModels(entry.models) }));
        finish(
          Array.isArray(message.offered)
            ? { signedIn, offered: message.offered.filter(isSubscriptionProvider) }
            : { signedIn }
        );
      });
      child.on('close', () => {
        this.runs.delete(child);
        finish();
      });
      child.on('error', (error) => {
        this.runs.delete(child);
        failure ||= error.message;
        finish();
      });
    });
  }

  /**
   * Tells the sign-in runner to stop, and ends it if it has not after KILL_AFTER_MS. Gives the end of every runner
   * stopping now, this one's included.
   */
  private stopChild(): Promise<void> {
    clearTimeout(this.limit);
    this.limit = undefined;
    const run = this.child;
    this.child = undefined;
    if (run) {
      try {
        run.process.stdin.write(`${JSON.stringify({ type: 'cancel' })}\n`);
      } catch {
        // Already gone.
      }
      const kill = setTimeout(() => run.process.kill(), KILL_AFTER_MS);
      kill.unref?.();
      let cap: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<void>((resolve) => {
        cap = setTimeout(resolve, STOP_LIMIT_MS);
        cap.unref?.();
      });
      this.stopping.set(
        run.process,
        Promise.race([run.closed, limit, this.quitting]).then(() => {
          clearTimeout(kill);
          clearTimeout(cap);
          this.stopping.delete(run.process);
        })
      );
    }
    return Promise.all(this.stopping.values()).then((): void => undefined);
  }
}

/**
 * The runner as a child process: `mu auth status | login <provider> | logout <provider>`, the harness's own sign-in,
 * started through its launcher as a session is (harness.ts, launcherOf), so it is the same for a checkout, mu-agent
 * from npm and the copy inside the packaged app. It signs in to mu's agent dir, the one the settings read. Without a
 * shell, so nothing in a path is ever parsed as a command, on Windows as elsewhere.
 */
export function spawnAuth(launcher: string, agentDir: string): SpawnRunner {
  return (args) => {
    const start = launchCommand(launcher, ['auth', ...args]);
    const child = spawn(start.command, start.args, {
      env: { ...process.env, ...systemProxyEnv(), ...start.env, MU_AGENT_DIR: agentDir },
      stdio: ['pipe', 'pipe', 'pipe'],
      // A process group of its own on POSIX, so that ending it ends what it started too (a checkout runs pi through
      // tsx, which starts a second Node). Windows ends the tree with taskkill (see endTree).
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    return {
      stdout: child.stdout,
      stdin: child.stdin,
      on: child.on.bind(child),
      kill: () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          endTree(child.pid, 'SIGTERM', process.platform, {
            group: (leader, signal) => process.kill(-leader, signal),
            taskkill: (taskArgs) => {
              spawn('taskkill', taskArgs, { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
            },
            own: (signal) => child.kill(signal),
          });
        } catch {
          // Gone already.
        }
      },
    };
  };
}
