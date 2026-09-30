/**
 * The native host in the app: pi running in an Electron utility process of its own, one per session, speaking pi's
 * RPC protocol with the main process (docs/native-host.md). On by default; MU_NATIVE_HOST=0 turns it off, and a mu too
 * old to run inside the app keeps the app on AionCore and the ACP adapter (`nativeHostReady`).
 */
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { app, utilityProcess } from 'electron';
import { systemProxyEnv } from '../../agent/kyrn/config/systemProxy.ts';
import { findHarness } from '../../agent/kyrn/harness.ts';
import { checkHost, prepareHost, type LauncherFs } from './launch.ts';
import { NativeHost, NativeHostError, type HostChild, type HostLaunch } from './NativeHost.ts';

export { NativeHost, NativeHostError } from './NativeHost.ts';
export type { HostLaunch, NativeHostErrorKind, NativeHostState } from './NativeHost.ts';

/**
 * What MU_NATIVE_HOST says. `off` (0, false, off, no) is the kill switch: conversations run on AionCore as before.
 * `on` (1, true, on, yes) forces the native host, whatever mu is found: a mu too old for it then fails where it is
 * used, which is what a developer wants to see. Anything else (unset) is `auto`: native when this machine's mu can run
 * inside the app, else the classic path without a word.
 */
export type NativeHostSetting = 'off' | 'on' | 'auto';

export function nativeHostSetting(env: NodeJS.ProcessEnv = process.env): NativeHostSetting {
  const word = (env.MU_NATIVE_HOST ?? '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(word)) return 'off';
  if (['1', 'true', 'on', 'yes'].includes(word)) return 'on';
  return 'auto';
}

/** Whether MU_NATIVE_HOST leaves the native host on. `auto` still needs a mu that can run inside the app. */
export const isNativeHostEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => nativeHostSetting(env) !== 'off';

/** Where the harness is, as the rest of the app looks for it (kyrnBridge.ts). */
const harnessOf = (env: NodeJS.ProcessEnv) => {
  // A packaged app runs from no checkout, so nothing is looked for beside the folder it happens to start in.
  const desktopRoot = app.isPackaged && !env.KYRN_DESKTOP_ROOT ? undefined : env.KYRN_DESKTOP_ROOT || process.cwd();
  return findHarness(desktopRoot, { env });
};

/**
 * `out/main/nativeHost.js`, next to the main entry even when this module sits in `out/main/chunks/`. Found from
 * `__dirname`, the folder of the bundle file this runs from: `require.main.filename` is not the app's main script in
 * every Electron (in 44 it is the string "electron", whose `dirname` is "." and made this path relative, which the
 * utility process then looked for in the project's folder).
 */
export function nativeHostEntry(): string {
  return join(basename(__dirname) === 'chunks' ? dirname(__dirname) : __dirname, 'nativeHost.js');
}

/**
 * Starts a host as an Electron utility process: no window, no Dock icon, Electron's own Node. The system's proxy is
 * handed on as the CLI bridge does (config/systemProxy.ts); the environment the launcher planned wins over it. The
 * launch's Node options travel in the host's `init` message instead of `execArgv`, which a utility process lists but
 * does not act on (entry.ts).
 */
export function forkUtility(entry: string): (launch: HostLaunch) => HostChild {
  return (launch) =>
    utilityProcess.fork(entry, [], {
      env: { ...systemProxyEnv(), ...launch.env },
      cwd: launch.cwd,
      stdio: 'pipe',
      serviceName: 'mu',
    });
}

export type NativeHostReadyOptions = {
  /** The environment the launcher plans from. Default: this process's. */
  env?: NodeJS.ProcessEnv;
  /** What the launcher reads through. Default: the file system. */
  fs?: LauncherFs;
  /** Where the reason goes when the native host stays off. Default: the console. */
  note?: (line: string) => void;
};

/**
 * Whether the app runs conversations on the native host: not when MU_NATIVE_HOST=0, always when it is 1, and when it
 * is left alone only if the mu found on this machine can run inside the app (`checkHost`: its launcher has the
 * native host's functions and accepts a plan). An app whose mu is older keeps every conversation on AionCore, with
 * a line in the log saying why, instead of failing each one.
 */
export async function nativeHostReady(options: NativeHostReadyOptions = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  const setting = nativeHostSetting(env);
  if (setting !== 'auto') return setting === 'on';
  const note = options.note ?? ((line: string) => console.warn(`[mu] ${line}`));
  try {
    const harness = harnessOf(env);
    if (!harness) {
      note('the native host stays off: no mu harness was found');
      return false;
    }
    const problem = await checkHost({
      harness,
      cwd: process.cwd(),
      env,
      home: homedir(),
      platform: process.platform,
      stripsTypes: Boolean(process.features.typescript),
      fs: options.fs,
    });
    if (problem) note(`the native host stays off: ${problem.message}`);
    return problem === undefined;
  } catch (error) {
    // The answer is asked for at start-up: nothing unforeseen may leave it a rejected promise.
    note(`the native host stays off: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export type StartNativeHostOptions = {
  /** The project the session works in. */
  cwd: string;
  /** A session to resume: its file, or its id. A new session when left out. */
  session?: string;
  /** The host entry to start. Default: the built one beside the main entry (nativeHostEntry). */
  entry?: string;
  /** The environment the launcher plans from. Default: this process's. */
  env?: NodeJS.ProcessEnv;
  /** What the launcher reads through. Default: the file system. */
  fs?: LauncherFs;
};

/**
 * Finds the harness as the rest of the app does (kyrnBridge.ts), plans and prepares the host with its launcher, and
 * starts it. Throws a NativeHostError: `off` with MU_NATIVE_HOST=0, `no-harness`, `old-harness` or `plan`.
 * The host is starting when this returns; its `state` and subscription say the rest.
 */
export async function startNativeHost(options: StartNativeHostOptions): Promise<NativeHost> {
  const env = options.env ?? process.env;
  if (!isNativeHostEnabled(env))
    throw new NativeHostError('off', 'The native host is off: MU_NATIVE_HOST=0 turned it off');
  const harness = harnessOf(env);
  if (!harness) throw new NativeHostError('no-harness', 'No mu harness was found');
  const launch = await prepareHost({
    harness,
    cwd: options.cwd,
    argv: ['--mode', 'rpc', ...(options.session ? ['--session', options.session] : [])],
    env,
    home: homedir(),
    platform: process.platform,
    stripsTypes: Boolean(process.features.typescript),
    fs: options.fs,
    note: (line) => console.warn(`[mu] ${line}`),
  });
  const host = new NativeHost({
    launch,
    fork: forkUtility(options.entry ?? nativeHostEntry()),
    log: (line) => console.log(`[mu host] ${line}`),
  });
  host.start();
  return host;
}
