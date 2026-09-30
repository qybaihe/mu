/**
 * The native host: one process per mu session that runs pi in-process, speaking pi's own RPC protocol with the app's
 * main process (docs/native-host.md). The app starts it as an Electron utility process (`out/main/nativeHost.js`);
 * tests and scripts start the same file with Node's `child_process.fork`.
 *
 * The first message names pi's module and arguments (`init`, see protocol.ts). The host applies the Node options the
 * launcher planned (applyNodeOptions), imports that module, runs pi's CLI setup and then `main(args, { rpcTransport })`,
 * whose transport is the message channel to the parent. pi decides the rest, as it does on the command line:
 * `--mode rpc`, the judgment layer's `-e`, a `--session` to resume.
 *
 * The parent's `end` (or, under Node, its disconnect) ends pi's input: pi shuts down and the process exits with 0.
 * A host that cannot import pi or start it says `failed` and exits with 1; pi's own errors go to stderr, as ever.
 */
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readToHost, type FromHost, type ToHost } from './protocol.ts';

/** pi's RpcTransport (packages/coding-agent/src/modes/rpc/rpc-transport.ts in the harness). */
type RpcTransport = {
  start(): void;
  write(json: string): void;
  drained(): Promise<void>;
  flush(): Promise<void>;
  listen(onRecord: (json: string) => void, onEnd: () => void): () => void;
  close(): void;
};

/** What the host needs of pi's module: the setup its command line runs first, and its main. */
type PiModule = {
  setupCli(): void;
  main(args: string[], options?: { rpcTransport?: RpcTransport }): Promise<void>;
};

/** Electron's `process.parentPort` in a utility process. */
type ParentPort = {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
};

/** The parent as the host sees it: messages out, a way to know they left, messages in, and the parent going away. */
type Channel = {
  post(message: FromHost): void;
  /** Resolves once every message posted so far has left the process. */
  sent(): Promise<void>;
  onMessage(listener: (message: unknown) => void): void;
  onGone(listener: () => void): void;
};

function electronChannel(port: ParentPort): Channel {
  return {
    post: (message) => port.postMessage(message),
    // A MessagePort takes a message whole and at once; there is nothing to wait for.
    sent: () => Promise.resolve(),
    onMessage: (listener) => void port.on('message', (event) => listener(event.data)),
    // Electron ends a utility process whose parent is gone: there is no event to wait for.
    onGone: () => undefined,
  };
}

function nodeChannel(): Channel {
  let pending = 0;
  let waiting: (() => void)[] = [];
  const settle = () => {
    if (pending > 0) return;
    for (const resolve of waiting.splice(0)) resolve();
  };
  return {
    post(message) {
      if (!process.connected) return;
      pending += 1;
      process.send?.(message, undefined, undefined, () => {
        pending -= 1;
        settle();
      });
    },
    sent: () => (pending === 0 ? Promise.resolve() : new Promise((resolve) => waiting.push(resolve))),
    onMessage: (listener) => void process.on('message', listener),
    onGone: (listener) => void process.once('disconnect', listener),
  };
}

function channel(): Channel {
  const port = (process as unknown as { parentPort?: ParentPort }).parentPort;
  if (port) return electronChannel(port);
  if (process.send) return nodeChannel();
  process.stderr.write('The mu host needs a parent: an Electron utility process or child_process.fork\n');
  process.exit(1);
}

const started = performance.now();
const parent = channel();
/** Records that came before pi listened, in order. */
const early: string[] = [];
let deliver: ((json: string) => void) | undefined;
let endInput: (() => void) | undefined;
let initialized = false;
let ended = false;

function fail(stage: 'init' | 'import' | 'main', error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`mu host: ${stage} failed: ${error instanceof Error && error.stack ? error.stack : message}\n`);
  parent.post({ type: 'failed', stage, message });
  void parent.sent().finally(() => process.exit(1));
}

/** pi's input ends: pi shuts down and exits. Before pi listens there is nothing to shut down. */
function end(): void {
  if (ended) return;
  ended = true;
  if (endInput) endInput();
  else void parent.sent().finally(() => process.exit(0));
}

const transport: RpcTransport = {
  start: () => undefined,
  write: (json) => parent.post({ type: 'out', json }),
  drained: () => parent.sent(),
  flush: () => parent.sent(),
  listen(onRecord, onEnd) {
    deliver = onRecord;
    endInput = onEnd;
    for (const json of early.splice(0)) onRecord(json);
    if (ended) onEnd();
    return () => {
      deliver = undefined;
      endInput = undefined;
    };
  },
  close: () => undefined,
};

/** What `import()` takes for a module named on a command line: a path becomes a file URL, a URL or a name stays. */
const importable = (name: string): string => (isAbsolute(name) ? pathToFileURL(name).href : name);

const isName = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** The type and code of a warning, as `process.emitWarning` takes it: `(warning, type, code)` or `(warning, options)`. */
function warningNames(warning: unknown, rest: unknown[]): string[] {
  if (warning instanceof Error) return [warning.name, (warning as { code?: unknown }).code].filter(isName);
  const [first, second] = rest;
  if (typeof first === 'string') return [first, second].filter(isName);
  const options = (first ?? {}) as { type?: unknown; code?: unknown };
  return [options.type ?? 'Warning', options.code].filter(isName);
}

/** From here on, the warnings of these types or codes are not printed. */
function silenceWarnings(names: ReadonlySet<string>): void {
  const emit = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    if (!warningNames(warning, rest).some((name) => names.has(name))) emit(warning, ...rest);
  }) as typeof process.emitWarning;
}

/**
 * The Node options the launcher planned for this process (a checkout's `--disable-warning=ExperimentalWarning`, and
 * its compile cache and source resolver as `--import`), applied from inside it. An Electron utility process lists the
 * options it was started with in `process.execArgv` but does not act on them (Electron 44: `--import`,
 * `--disable-warning` and `--no-warnings` all have no effect), so the parent passes them here instead, under Node's
 * fork as well, and both run the same way. The warnings `--disable-warning` names are not printed from then on, and
 * each `--import` module is imported, in order, before pi. No other option can take effect once a process runs.
 */
async function applyNodeOptions(execArgv: readonly string[]): Promise<void> {
  const options: { flag: string; value: string }[] = [];
  for (let index = 0; index < execArgv.length; index++) {
    const arg = execArgv[index];
    const equals = arg.indexOf('=');
    if (arg.startsWith('--') && equals > 0) options.push({ flag: arg.slice(0, equals), value: arg.slice(equals + 1) });
    else if (arg === '--import' || arg === '--disable-warning')
      options.push({ flag: arg, value: execArgv[++index] ?? '' });
    else options.push({ flag: arg, value: '' });
  }
  const silenced = options.filter((option) => option.flag === '--disable-warning').map((option) => option.value);
  if (silenced.length > 0) silenceWarnings(new Set(silenced));
  for (const option of options) {
    // oxlint-disable-next-line no-await-in-loop -- one after the other, as Node runs --import: the order is the plan's
    if (option.flag === '--import') await import(/* @vite-ignore */ importable(option.value));
    else if (option.flag !== '--disable-warning')
      process.stderr.write(`mu host: ${option.flag} cannot take effect in a running process and is left out\n`);
  }
}

async function start(init: Extract<ToHost, { type: 'init' }>): Promise<void> {
  let pi: PiModule;
  try {
    await applyNodeOptions(init.execArgv);
    pi = (await import(/* @vite-ignore */ pathToFileURL(init.module).href)) as PiModule;
    if (typeof pi.setupCli !== 'function' || typeof pi.main !== 'function')
      throw new Error(`${init.module} exports no setupCli and main: a mu from before the native host`);
  } catch (error) {
    return fail('import', error);
  }
  try {
    pi.setupCli();
    parent.post({ type: 'ready', importMs: Math.round(performance.now() - started) });
    await pi.main(init.args, { rpcTransport: transport });
  } catch (error) {
    return fail('main', error);
  }
  // RPC mode never returns; any other mode (a `--version`, say) is over here.
  await parent.sent();
  process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
}

parent.onMessage((raw) => {
  const message = readToHost(raw);
  if (!message) return;
  if (message.type === 'in') {
    if (deliver) deliver(message.json);
    else early.push(message.json);
  } else if (message.type === 'end') end();
  else if (initialized) process.stderr.write('mu host: a second init is ignored\n');
  else {
    initialized = true;
    void start(message);
  }
});
parent.onGone(end);
