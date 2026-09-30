/**
 * How a native host is started, decided by mu's own launcher (`kyrn/bin/mu.mjs` in the harness, types in
 * `mu.d.mts`): `planHost` says which module to import pi from, with which Node flags, arguments and environment, and
 * `prepareLaunchAsync` (or, in a launcher from before it, `prepareLaunch`) does what the command line does before pi
 * starts (the app view of a checkout, the agent folder, the configuration's notes, the local judge). The app's pi and
 * the command line's are then one: the same files, settings, sign-ins and keys.
 *
 * The launcher is imported when a host starts: its path depends on where the harness is, which is known only then.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Harness } from '../../agent/kyrn/harness.ts';
import { NativeHostError, type HostLaunch } from './NativeHost.ts';

type Env = Readonly<Record<string, string | undefined>>;

/** What the launcher reads through: the file system, or a stand-in that keeps a test away from real keys. */
export type LauncherFs = {
  exists(file: string): boolean;
  isDir(file: string): boolean;
  readFile(file: string): string;
};

/** `HostPlan` of the launcher (mu.d.mts). */
export type HostPlan = {
  error?: undefined;
  module: string;
  execArgv: string[];
  args: string[];
  env: Record<string, string>;
  layout: 'repo' | 'package';
  muDir: string;
  appDir: string;
  agentDir: string;
  startJudge: boolean;
  notes: string[];
};

/** `PrepareLaunchInput` of the launcher (mu.d.mts). */
type PrepareLaunchInput = {
  plan: HostPlan;
  platform: NodeJS.Platform;
  root: string;
  bin: string;
  err(message: string): void;
};

/**
 * The part of the launcher module a host needs. A launcher from before the native host has neither `planHost` nor
 * `prepareLaunch`; one from before 2026-09-29 has no `prepareLaunchAsync`, whose local judge start does not hold the
 * calling process (`prepareLaunch` starts it with `spawnSync`, which would freeze the app's windows meanwhile).
 */
export type Launcher = {
  planHost(input: {
    platform: NodeJS.Platform;
    env: Env;
    argv: readonly string[];
    root: string;
    home: string;
    stripsTypes: boolean;
    fs: LauncherFs;
  }): HostPlan | { error: string };
  prepareLaunch(input: PrepareLaunchInput): void;
  prepareLaunchAsync?(input: PrepareLaunchInput): Promise<void>;
};

export type PrepareOptions = {
  harness: Pick<Harness, 'root'>;
  /** The project: the host's working directory. */
  cwd: string;
  /** pi's arguments after the judgment layer. Default `--mode rpc`. */
  argv?: string[];
  /** The environment pi would get on the command line; the launcher adds the `.env` keys and mu's folders. */
  env: Env;
  home: string;
  platform: NodeJS.Platform;
  /** Whether the host's Node strips TypeScript types itself (`process.features.typescript`): a checkout needs it. */
  stripsTypes: boolean;
  fs?: LauncherFs;
  importLauncher?: (file: string) => Promise<unknown>;
  /** Where the launcher's notes go (a `.env` line it skipped, a local judge that cannot run here). */
  note?: (line: string) => void;
};

/** A host ready to start, and what the launcher decided on the way. */
export type PreparedHost = HostLaunch & {
  layout: 'repo' | 'package';
  agentDir: string;
  notes: string[];
};

const realFs: LauncherFs = {
  exists: existsSync,
  isDir: (file) => {
    try {
      return statSync(file).isDirectory();
    } catch {
      return false;
    }
  },
  readFile: (file) => readFileSync(file, 'utf8'),
};

const importFile = (file: string): Promise<unknown> => import(/* @vite-ignore */ pathToFileURL(file).href);

const isLauncher = (value: unknown): value is Launcher => {
  const module = value as Partial<Launcher> | null;
  return typeof module?.planHost === 'function' && typeof module.prepareLaunch === 'function';
};

/** The launcher's refusal. A check of `error` alone does not narrow the union without strict null checks. */
const refused = (plan: HostPlan | { error: string }): plan is { error: string } => typeof plan.error === 'string';

/** The launcher and its plan for a host, or the NativeHostError that says why there is none. Reads only. */
async function planned(options: PrepareOptions): Promise<{ launcher: Launcher; plan: HostPlan; bin: string }> {
  const { harness, platform } = options;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const bin = p.join(harness.root, 'kyrn', 'bin');
  const file = p.join(bin, 'mu.mjs');
  const fs = options.fs ?? realFs;
  if (!fs.exists(file)) throw new NativeHostError('no-harness', `No mu launcher at ${file}`);
  let launcher: unknown;
  try {
    launcher = await (options.importLauncher ?? importFile)(file);
  } catch (error) {
    throw new NativeHostError(
      'no-harness',
      `mu's launcher did not load (${file}): ${error instanceof Error ? error.message : error}`
    );
  }
  if (!isLauncher(launcher))
    throw new NativeHostError('old-harness', `This mu cannot run inside the app yet (${file} has no planHost)`);
  const plan = launcher.planHost({
    platform,
    env: options.env,
    argv: options.argv ?? ['--mode', 'rpc'],
    root: harness.root,
    home: options.home,
    stripsTypes: options.stripsTypes,
    fs,
  });
  if (refused(plan)) throw new NativeHostError('plan', plan.error);
  return { launcher, plan, bin };
}

/**
 * Whether a host could start with this harness: its launcher loads, has the native host's two functions and accepts a
 * plan. Nothing is prepared (no folder is made, no judge starts). Undefined when one could; else what a start would
 * fail with, which is how the app tells a mu too old to run inside it from one that is fine.
 */
export async function checkHost(options: PrepareOptions): Promise<NativeHostError | undefined> {
  try {
    await planned(options);
    return undefined;
  } catch (error) {
    if (error instanceof NativeHostError) return error;
    throw error;
  }
}

/** Plans and prepares a host with the harness's launcher. Throws a NativeHostError when it cannot be started. */
export async function prepareHost(options: PrepareOptions): Promise<PreparedHost> {
  const { harness, platform } = options;
  const { launcher, plan, bin } = await planned(options);
  const notes: string[] = [];
  const input: PrepareLaunchInput = {
    plan,
    platform,
    root: harness.root,
    bin,
    err: (line) => {
      notes.push(line);
      options.note?.(line);
    },
  };
  try {
    if (typeof launcher.prepareLaunchAsync === 'function') await launcher.prepareLaunchAsync(input);
    else launcher.prepareLaunch(input);
  } catch (error) {
    // The app view or the agent folder could not be made (a full disk, a folder without write permission).
    throw new NativeHostError(
      'plan',
      `mu could not prepare the launch: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return {
    module: plan.module,
    args: plan.args,
    execArgv: plan.execArgv,
    env: plan.env,
    cwd: options.cwd,
    layout: plan.layout,
    agentDir: plan.agentDir,
    notes,
  };
}
