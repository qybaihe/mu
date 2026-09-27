import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { systemProxyEnv } from './config/systemProxy.ts';
import { log } from './errorLog.ts';
import { muEnv, muHome } from './naming.ts';
import { wslLaunch, wslLocation } from './windows/wsl.ts';

export type JsonRecord = Record<string, unknown>;
export const asRecord = (value: unknown): JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
export const text = (value: unknown): string => (typeof value === 'string' ? value : '');
export const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export interface RpcPort {
  send(command: JsonRecord): Promise<JsonRecord>;
  respond(response: JsonRecord): void;
  close(): void;
}

/**
 * How the launcher is started. A Node launcher (`kyrn/bin/mu.mjs`, what Windows, the npm package and the copy inside
 * the packaged app use) runs with this process's own Node, or `MU_NODE`: no shell and no `.cmd`, which Node refuses to
 * spawn without one. In the app this process is Electron, whose binary runs a script as Node only with
 * ELECTRON_RUN_AS_NODE: that is how the packaged app runs mu without a Node on the machine. Anything else is an
 * executable (the bash forwarder of a checkout).
 */
export function launchCommand(
  launcher: string,
  args: string[],
  node: string = process.env.MU_NODE || process.execPath,
  electron: boolean = Boolean(process.versions.electron)
): { command: string; args: string[]; env: Record<string, string> } {
  if (!/\.[cm]?js$/i.test(launcher)) return { command: launcher, args, env: {} };
  return { command: node, args: [launcher, ...args], env: electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
}

/**
 * Ends the harness and everything it started (tools, MCP servers, language servers). POSIX: the process group it
 * leads. Windows has no groups: `taskkill /T` walks the tree, and `/F` because a console-less child cannot be asked.
 */
export function endTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform,
  run: {
    group: (pid: number, signal: NodeJS.Signals) => void;
    taskkill: (args: string[]) => void;
    own: (signal: NodeJS.Signals) => void;
  }
): void {
  if (!pid) return run.own(signal);
  if (platform === 'win32') return run.taskkill(['/pid', String(pid), '/T', '/F']);
  run.group(pid, signal);
}

/** How much of the end of mu's error output is kept, for the log when it stops unasked: where a crash says why. */
const STDERR_TAIL = 8 * 1024;

/** How mu marks a line of its error output that is meant for the log (see PiRpc.forward). */
const MU_LINE = '[mu] ';

/**
 * How long a control command (anything but a prompt) may wait for its answer, in milliseconds. `command` counts from
 * the moment mu is up (its first line of output); a command sent before that waits for mu to come up as well, up to
 * `start` in all. A first start can take far longer than an answer: a virus scanner reading every file of a fresh
 * install, a busy disk, a machine under load. Counted from the write, 30 seconds failed a conversation's first message
 * while mu was still starting, and the next attempt then worked.
 */
export interface RpcDeadlines {
  command: number;
  start: number;
}
const DEADLINES: RpcDeadlines = { command: 30_000, start: 180_000 };

/**
 * What the adapter logs when mu stopped without being asked to: the exit, then the end of mu's error output. The adapter's
 * error output is AionCore's to log (each line under "CLI process stderr" in the app's log folder); mu's own never
 * reaches the client.
 */
export function stoppedReport(
  code: number | null,
  signal: string | null,
  stderr: string,
  /** It had stopped reading its input, and the adapter ended it. */
  unreadable = false
): string {
  const exit = `exit code ${code ?? 'none'}${signal ? `, signal ${signal}` : ''}`;
  const tail = stderr
    .split(/\r?\n/)
    // mu's own log lines are in the log already (see PiRpc.forward).
    .filter((line) => line.trim() && !line.startsWith(MU_LINE))
    .slice(-40)
    .map((line) => `[mu harness] ${line}`);
  const what = unreadable ? 'stopped reading its input and was ended' : 'stopped by itself';
  return [`[mu] the harness ${what} (${exit})${tail.length ? '; the end of its error output:' : ''}`, ...tail]
    .join('\n')
    .concat('\n');
}

/** Owns the pi process; stdout is protocol-only and stderr never reaches the client. */
export class PiRpc implements RpcPort {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    { resolve(value: JsonRecord): void; reject(error: Error): void; timer?: NodeJS.Timeout }
  >();
  private closed = false;
  /** mu has written its first line: it reads commands (see started()). */
  private up = false;
  private deadlines: RpcDeadlines;
  /** close() was called: mu stopping is expected, not news for the log. */
  private ending = false;
  private exited = false;
  private killing = false;
  /** A write to mu failed: it stopped reading, and was ended for it. */
  private unreadable = false;
  private stderr = '';
  /** The unfinished last line of mu's error output, for forward(). */
  private partial = '';
  /** Runs inside WSL, through wsl.exe (see windows/wsl.ts). */
  private wsl: boolean;
  private onEvent: (event: JsonRecord) => void;
  constructor(
    launcher: string,
    cwd: string,
    session: string | undefined,
    onEvent: (event: JsonRecord) => void,
    /** Added to the inherited environment of the harness process. */
    env?: Readonly<Record<string, string>>,
    deadlines: RpcDeadlines = DEADLINES
  ) {
    this.onEvent = onEvent;
    this.deadlines = deadlines;
    // A project inside WSL gets its harness inside WSL (Windows only).
    const location = process.platform === 'win32' ? wslLocation(cwd) : undefined;
    this.wsl = location !== undefined;
    const launch = launchCommand(launcher, ['--mode', 'rpc', ...(session ? ['--session', session] : [])]);
    const start = location
      ? wslLaunch({
          location,
          session,
          env: env ?? {},
          agentDir: muEnv('AGENT_DIR') || join(muHome(), 'agent'),
          inherited: process.env.WSLENV,
          home: homedir(),
        })
      : { command: launch.command, args: launch.args, cwd, env: { ...systemProxyEnv(), ...launch.env, ...env } };
    this.child = spawn(start.command, start.args, {
      cwd: start.cwd,
      env: { ...process.env, ...start.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      // No console window flashing up on Windows for a process that only speaks JSON lines.
      windowsHide: true,
    });
    // Decoded as UTF-8 (anything else becomes U+FFFD): AionCore stops reading the adapter's error output at the first
    // line that is not UTF-8, and this tail can end up there.
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-STDERR_TAIL);
      this.forward(chunk);
    });
    // A write to mu after it stopped reading (it crashed, or is on its way out) fails on this stream with EPIPE. Unheard,
    // that error would end the adapter, and with it every conversation it serves.
    this.child.stdin.on('error', () => this.broken());
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      if (!this.up) this.started();
      let event: JsonRecord;
      try {
        event = asRecord(JSON.parse(line));
      } catch {
        return;
      }
      const request = this.pending.get(text(event.id));
      if (event.type === 'response' && request) {
        this.pending.delete(text(event.id));
        clearTimeout(request.timer);
        if (event.success) request.resolve(asRecord(event.data));
        else request.reject(new Error(text(event.error) || 'mu RPC command failed'));
      }
      this.emit(event);
    });
    this.child.on('error', () => this.finish(new Error('mu failed to start')));
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      this.finish(new Error('mu process exited'));
      if (!this.ending) this.report(code, signal);
    });
  }
  /**
   * Passes mu's own log lines (marked `[mu] `, such as a promise nothing handled) on to the app's log as they come. The
   * rest of mu's error output is logged only when mu stops unasked (see report).
   */
  private forward(chunk: string): void {
    const lines = `${this.partial}${chunk}`.split(/\r?\n/);
    // A line too long for a log line is not kept whole.
    this.partial = (lines.pop() ?? '').slice(0, STDERR_TAIL);
    for (const line of lines) if (line.startsWith(MU_LINE)) log(`[mu harness] ${line.slice(MU_LINE.length)}\n`);
  }
  /** Logs why mu stopped, once the last of its error output is in (a crash writes it just before the exit). */
  private report(code: number | null, signal: NodeJS.Signals | null): void {
    let written = false;
    const write = () => {
      if (written) return;
      written = true;
      log(stoppedReport(code, signal, this.stderr, this.unreadable));
    };
    if (this.child.stderr.closed) return write();
    // A process mu started can hold the stream open after mu is gone: the report does not wait for it.
    const timer = setTimeout(write, 500);
    timer.unref();
    this.child.stderr.once('close', () => {
      clearTimeout(timer);
      write();
    });
  }
  private finish(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.emit({ type: 'kyrn_rpc_closed' });
  }
  /** Hands an event on. A listener that fails is logged: it must not end the adapter from inside a stream callback. */
  private emit(event: JsonRecord): void {
    try {
      this.onEvent(event);
    } catch (error) {
      log(`[mu] handling a ${text(event.type) || 'mu'} event failed: ${String(error)}\n`);
    }
  }
  send(command: JsonRecord): Promise<JsonRecord> {
    if (this.closed) return Promise.reject(new Error('mu process is closed'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      // A difficult prompt can run for hours. Only control commands have a deadline (see RpcDeadlines).
      const timer =
        command.type === 'prompt'
          ? undefined
          : this.expire(id, this.up ? this.deadlines.command : this.deadlines.start);
      this.pending.set(id, { resolve, reject, timer });
      this.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }
  /** Fails a control command that has had no answer after `ms`. */
  private expire(id: string, ms: number): NodeJS.Timeout {
    return setTimeout(() => {
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);
      request.reject(new Error('mu control command timed out'));
    }, ms);
  }
  /** mu is up: the control commands that waited for it have the usual deadline from now. */
  private started(): void {
    this.up = true;
    for (const [id, request] of this.pending) {
      if (!request.timer) continue;
      clearTimeout(request.timer);
      request.timer = this.expire(id, this.deadlines.command);
    }
  }
  /** An answer to one of mu's questions. Never throws: a mu that cannot take it any more has stopped, and says so. */
  respond(response: JsonRecord): void {
    if (!this.closed) this.write(`${JSON.stringify({ ...response, type: 'extension_ui_response' })}\n`);
  }
  /** Writes a line to mu. A write that fails means mu stopped reading: it counts as stopped, and nothing throws. */
  private write(line: string): void {
    try {
      this.child.stdin.write(line, (error) => {
        if (error) this.broken();
      });
    } catch {
      this.broken();
    }
  }
  /** mu cannot be written to any more (it crashed, or is on its way out): its requests fail and it is ended. */
  private broken(): void {
    if (!this.ending) this.unreadable = true;
    this.finish(new Error('mu process exited'));
    this.end();
  }
  close(): void {
    if (this.ending) return;
    this.ending = true;
    this.end();
    this.finish(new Error('mu session closed'));
  }
  /** Ends mu and everything it started, unless it has already exited. */
  private end(): void {
    if (this.exited || this.killing) return;
    this.killing = true;
    const pid = this.child.pid;
    const kill = (signal: NodeJS.Signals) => {
      try {
        endTree(pid, signal, process.platform, {
          group: (leader, sent) => process.kill(-leader, sent),
          taskkill: (args) => {
            spawn('taskkill', args, { stdio: 'ignore', windowsHide: true }).on('error', () => this.child.kill());
          },
          own: (sent) => this.child.kill(sent),
        });
      } catch {}
    };
    const end = () => {
      kill('SIGTERM');
      const timer = setTimeout(() => kill('SIGKILL'), 3000);
      timer.unref();
      this.child.once('exit', () => clearTimeout(timer));
    };
    if (this.wsl) {
      // Ending wsl.exe does not reach everything it started inside Linux. mu ends itself when its input ends; the
      // tree is ended only if it has not by then.
      this.child.stdin.end();
      const timer = setTimeout(end, 2000);
      timer.unref();
      this.child.once('exit', () => clearTimeout(timer));
    } else end();
  }
}
