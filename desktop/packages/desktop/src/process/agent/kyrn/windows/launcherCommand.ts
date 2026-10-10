import { execFile } from 'node:child_process';
import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { KyrnError } from '../../../../common/kyrn/errors.ts';
import type { OwnCommand } from '../product.ts';

/**
 * What mu's registration carries as its command on this machine, and which other commands are the same launcher.
 *
 * AionCore starts a registration's `command` up to its first whitespace: quotes are kept as they are, the rest is
 * dropped (arguments have a field of their own). The launcher of an app installed where the installer puts it by
 * default, `C:\Program Files\mu\resources\mu\acp.cmd`, started as `C:\Program` and failed at every start (issue #4). So
 * on Windows a launcher whose path has whitespace is registered by a spelling without it:
 *
 * - its real path, when that has none (the spaced path is a link to it);
 * - its 8.3 short path (`C:\PROGRA~1\mu\resources\mu\acp.cmd`), which Windows keeps for every folder made while short
 *   names are on (they are on the system drive by default);
 * - else a forwarder: a batch file in a folder without whitespace that hands over to the launcher (forwarderContent).
 *   A volume can have short names switched off, and then a folder made there has none.
 *
 * Elsewhere, and on Windows for a path without whitespace, the launcher is registered as it is, as it always was: the
 * registration is found by its command, so a launcher that was registered before keeps matching.
 *
 * Every decision is a function of what it is given, so Windows is tested on any system (tests/unit/kyrn/windows).
 */

export type LauncherDeps = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** The 8.3 short spelling Windows gives an existing path; undefined when it gives none in time. */
  shortPath: (file: string) => Promise<string | undefined>;
  /** The path as the file system knows it: links followed, every short name long. Undefined when there is none. */
  realPath: (file: string) => string | undefined;
  /** True only when a path is absent, not when a permission or I/O error prevents reading it. */
  missing: (file: string) => boolean;
  /** Writes a file, and the folder it is in; false when it cannot be written there. */
  write: (file: string, content: string) => boolean;
};

/** Where a forwarder is written, in each folder forwarderFolders names, and its name there. */
export const FORWARDER_FOLDER = 'mu-desktop';
export const FORWARDER_NAME = 'acp.cmd';

/** The variable cmd.exe reads the path from: in the command line itself, a `%` or `&` of the path would be syntax. */
const SHORT_PATH_VARIABLE = 'MU_SHORT_PATH_OF';
/** How long cmd.exe may take to name a short path. It takes a few milliseconds; this is for a stuck one. */
const SHORT_PATH_TIMEOUT = 5000;

const WHITESPACE = /\s/;
/** What a batch file can say literally: cmd reads it in the console's code page, the same everywhere only for ASCII. */
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
/** A path on a drive: only such a path is looked up on disk (a network path can keep the lookup waiting). */
const DRIVE_PATH = /^[a-z]:[\\/]/i;

/** A path as Windows compares it: in any case, with either slash. */
const fold = (file: string): string => file.replaceAll('/', '\\').toLowerCase();

/**
 * Where a forwarder may go, most private first. The user's own local app data, which only this user can write: nobody
 * else can change what AionCore runs as this user. Its path holds the account's name, which can have a space; then
 * ProgramData, which has none on a standard Windows and where every user may add files; then the public profile, for a
 * machine where another account already wrote the ProgramData one (a file there is its owner's to change).
 */
export function forwarderFolders(env: NodeJS.ProcessEnv): string[] {
  return [env.LOCALAPPDATA, env.ProgramData, env.PUBLIC]
    .filter((root): root is string => Boolean(root))
    .map((root) => path.win32.join(root, FORWARDER_FOLDER));
}

/**
 * The forwarder for `target`, the launcher it hands over to. ASCII only (see PRINTABLE_ASCII), with Windows line ends.
 * It starts the launcher without `call`: `call` would read the line a second time, doubling carets and expanding
 * percent signs again. Started that way the launcher takes over this batch, so its `exit /b` is the exit code AionCore
 * sees. A percent sign of the path is doubled, as a batch file says one; delayed expansion is off, so `!` is literal.
 */
export function forwarderContent(target: string): string {
  return [
    '@echo off',
    'rem mu: hands over to the launcher below, whose path has spaces, which a command AionCore runs cannot have.',
    'rem Written by the mu app at each start, from resources\\mu\\acp.cmd of the app. Edits here are replaced.',
    'setlocal DisableDelayedExpansion',
    `"${target.replaceAll('%', '%%')}" %*`,
    '',
  ].join('\r\n');
}

/** What to register for a launcher on Windows: a spelling as it is, a forwarder to write, or why neither works. */
export type LauncherPlan = { use: string } | { forward: { content: string; files: string[] } } | { fail: string };

/**
 * The plan for `launcher`, given its real path, the short spelling Windows gave (only one naming the same file), and
 * the folders a forwarder may go in. A forwarder names the launcher by its first ASCII spelling: the real path, the
 * short one (a folder outside ASCII can have a short name in ASCII), or the path itself.
 */
export function planCommand(input: {
  launcher: string;
  real: string;
  short: string | undefined;
  folders: string[];
}): LauncherPlan {
  const { launcher, real, short, folders } = input;
  if (!WHITESPACE.test(launcher)) return { use: launcher };
  const spelled = [real, short].find((spelling) => spelling !== undefined && !WHITESPACE.test(spelling));
  if (spelled) return { use: spelled };
  const target = [real, short, launcher].find((spelling) => spelling !== undefined && PRINTABLE_ASCII.test(spelling));
  if (!target)
    return { fail: `${launcher} has spaces and no short name, and a path outside ASCII cannot be forwarded to` };
  const files = folders
    .filter((folder) => !WHITESPACE.test(folder))
    .map((folder) => path.win32.join(folder, FORWARDER_NAME));
  if (files.length === 0)
    return { fail: `${launcher} has spaces and no short name, and no folder without spaces is known` };
  return { forward: { content: forwarderContent(target), files } };
}

/**
 * Whether a command a registration holds runs the launcher whose real path is `real`: one of its known `spellings` in
 * any case (the path, the real one, the short one, the forwarders), or a path on a drive that is that same file.
 */
export function sameLauncher(input: {
  spellings: string[];
  real: string;
  realPath: (file: string) => string | undefined;
}): (registered: string) => boolean {
  const known = new Set(input.spellings.map(fold));
  return (registered) => {
    if (known.has(fold(registered))) return true;
    if (!DRIVE_PATH.test(registered)) return false;
    const resolved = input.realPath(registered);
    return resolved !== undefined && fold(resolved) === fold(input.real);
  };
}

/**
 * How cmd.exe is asked for a path's short spelling: `for` with `%~sI`, the path read from a variable, which is expanded
 * once, into quotes that keep every character of it literal. /d skips the AutoRun commands, /v:off keeps a `!` literal,
 * /u answers in UTF-16 (the console code page would garble a name outside it), /s /c runs the quoted line as it is.
 */
export function shortPathQuery(
  file: string,
  env: NodeJS.ProcessEnv
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  return {
    command: env.ComSpec || 'cmd.exe',
    args: ['/d', '/v:off', '/u', '/s', '/c', `"for %I in ("%${SHORT_PATH_VARIABLE}%") do @echo %~sI"`],
    env: { ...env, [SHORT_PATH_VARIABLE]: file },
  };
}

/** The path in cmd.exe's answer: UTF-16 as asked, or bytes when /u was not heeded. Undefined when it names none. */
export function parseShortPath(output: Buffer): string | undefined {
  const text = output.includes(0) ? output.toString('utf16le') : output.toString('utf8');
  const line = text.split(/\r?\n/)[0]?.trim();
  return line && path.win32.isAbsolute(line) ? line : undefined;
}

/** A path's short spelling, from cmd.exe (see shortPathQuery). Undefined when cmd.exe fails or takes too long. */
export function windowsShortPath(file: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const query = shortPathQuery(file, env);
  return new Promise((resolve) => {
    execFile(
      query.command,
      query.args,
      {
        env: query.env,
        encoding: 'buffer',
        timeout: SHORT_PATH_TIMEOUT,
        windowsHide: true,
        windowsVerbatimArguments: true,
      },
      (error, stdout) => resolve(error ? undefined : parseShortPath(stdout))
    );
  });
}

const defaults = (): LauncherDeps => ({
  platform: process.platform,
  env: process.env,
  shortPath: (file) => windowsShortPath(file),
  realPath: (file) => {
    try {
      // The native call: on Windows it names every folder by its long name.
      return realpathSync.native(file);
    } catch {
      return undefined;
    }
  },
  missing: (file) => {
    try {
      statSync(file);
      return false;
    } catch (error) {
      return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
    }
  },
  write: (file, content) => {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      return true;
    } catch {
      return false;
    }
  },
});

/**
 * The command to register for `launcher` (the full path of acp.cmd, or of the bash `acp` elsewhere), and how to tell
 * a registered command that is this launcher by another spelling. A forwarder the plan asks for is written into the
 * first folder that takes it, at every start: the app may have moved since the last. Throws `installPath` when no
 * spelling can be registered: the person can then only install mu into a folder whose path has no spaces.
 */
export async function ownLauncher(launcher: string, patch: Partial<LauncherDeps> = {}): Promise<OwnCommand> {
  const deps = { ...defaults(), ...patch };
  // Only packaged apps restore another packaged install. A development checkout must not adopt its registration.
  const packaged = (file: string): boolean =>
    deps.platform === 'win32'
      ? DRIVE_PATH.test(file) && /\\resources\\mu\\acp\.cmd$/i.test(fold(file))
      : file.startsWith('/') && !file.startsWith('//') && /\/[Rr]esources\/mu\/acp$/.test(file);
  const canRestore = (registered: string): boolean =>
    packaged(launcher) && packaged(registered) && deps.missing(registered);
  if (deps.platform !== 'win32')
    return { command: launcher, sameFile: (registered) => registered === launcher, canRestore };
  const real = deps.realPath(launcher) ?? launcher;
  const folders = forwarderFolders(deps.env);
  const asked = WHITESPACE.test(launcher) ? await deps.shortPath(launcher) : undefined;
  // A short spelling is used only when it names this very file: a wrong answer would register another program.
  const found = asked === undefined ? undefined : deps.realPath(asked);
  const short = found !== undefined && fold(found) === fold(real) ? asked : undefined;
  const sameFile = sameLauncher({
    spellings: [
      launcher,
      real,
      ...(short ? [short] : []),
      ...folders.map((folder) => path.win32.join(folder, FORWARDER_NAME)),
    ],
    real,
    realPath: deps.realPath,
  });
  const plan = planCommand({ launcher, real, short, folders });
  if ('use' in plan) return { command: plan.use, sameFile, canRestore };
  if ('forward' in plan) {
    const written = plan.forward.files.find((file) => deps.write(file, plan.forward.content));
    if (written) return { command: written, sameFile, canRestore };
  }
  const why =
    'fail' in plan ? plan.fail : `${launcher} has spaces and no short name, and no forwarder could be written`;
  throw new KyrnError('installPath', `mu cannot be started from where it is installed: ${why}`);
}
