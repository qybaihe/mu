import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KyrnError } from '../../../../packages/desktop/src/common/kyrn/errors.ts';
import {
  forwarderContent,
  forwarderFolders,
  ownLauncher,
  parseShortPath,
  planCommand,
  sameLauncher,
  shortPathQuery,
  windowsShortPath,
  type LauncherDeps,
} from '../../../../packages/desktop/src/process/agent/kyrn/windows/launcherCommand.ts';

// Issue #4: the installer's default folder, C:\Program Files\mu. AionCore started the launcher as `C:\Program`.
const INSTALLED = 'C:\\Program Files\\mu\\resources\\mu\\acp.cmd';
const SHORT = 'C:\\PROGRA~1\\mu\\resources\\mu\\acp.cmd';
const ENV: NodeJS.ProcessEnv = {
  LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local',
  ProgramData: 'C:\\ProgramData',
  PUBLIC: 'C:\\Users\\Public',
};
const LOCAL_FORWARDER = 'C:\\Users\\someone\\AppData\\Local\\mu-desktop\\acp.cmd';

/**
 * A machine made of what is given: `files` maps every spelling of a path (in any case, as Windows reads it) to its
 * real one, `short` is what the short-path lookup answers, and only files inside `writable` folders can be written.
 */
function machine(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  files?: Record<string, string>;
  short?: string;
  writable?: string[];
}) {
  const files = new Map(Object.entries(options.files ?? {}).map(([spelling, real]) => [spelling.toLowerCase(), real]));
  const asked: string[] = [];
  const written = new Map<string, string>();
  const deps: Partial<LauncherDeps> = {
    platform: options.platform ?? 'win32',
    env: options.env ?? ENV,
    shortPath: async (file) => {
      asked.push(file);
      return options.short;
    },
    realPath: (file) => files.get(file.toLowerCase()),
    write: (file, content) => {
      if (!(options.writable ?? []).some((folder) => file.toLowerCase().startsWith(`${folder.toLowerCase()}\\`)))
        return false;
      written.set(file, content);
      return true;
    },
  };
  return { deps, asked, written };
}

/** The code a failed `ownLauncher` threw, or what it threw when that was no KyrnError. */
async function failure(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error instanceof KyrnError ? error.code : error;
  }
  return undefined;
}

describe('the command mu registers for its launcher', () => {
  it('registers the launcher of macOS and Linux as it is, spaces and all, and asks nothing', async () => {
    const launcher = '/Users/some one/Applications/mu.app/Contents/Resources/mu/acp';
    const { deps, asked, written } = machine({ platform: 'darwin' });
    const own = await ownLauncher(launcher, deps);
    expect(own.command).toBe(launcher);
    expect(asked).toEqual([]);
    expect(written.size).toBe(0);
  });

  it('registers a Windows launcher whose path has no spaces as it is, without asking for a short path', async () => {
    const launcher = 'C:\\mu\\resources\\mu\\acp.cmd';
    const { deps, asked } = machine({ files: { [launcher]: launcher } });
    expect((await ownLauncher(launcher, deps)).command).toBe(launcher);
    expect(asked).toEqual([]);
  });

  it('registers the 8.3 short path of a launcher installed in C:\\Program Files', async () => {
    const { deps, asked, written } = machine({
      files: { [INSTALLED]: INSTALLED, [SHORT]: INSTALLED },
      short: SHORT,
      writable: [ENV.LOCALAPPDATA as string],
    });
    expect((await ownLauncher(INSTALLED, deps)).command).toBe(SHORT);
    expect(asked).toEqual([INSTALLED]);
    expect(written.size).toBe(0);
  });

  it('registers the real path when the spaced one is a link to a folder without spaces', async () => {
    const real = 'D:\\apps\\mu\\resources\\mu\\acp.cmd';
    const { deps } = machine({ files: { [INSTALLED]: real } });
    expect((await ownLauncher(INSTALLED, deps)).command).toBe(real);
  });

  it('writes a forwarder when the folder has no short name, and registers the forwarder', async () => {
    // With short names off, Windows answers the long path itself.
    const { deps, written } = machine({
      files: { [INSTALLED]: INSTALLED },
      short: INSTALLED,
      writable: [ENV.LOCALAPPDATA as string],
    });
    const own = await ownLauncher(INSTALLED, deps);
    expect(own.command).toBe(LOCAL_FORWARDER);
    expect([...written.keys()]).toEqual([LOCAL_FORWARDER]);
    const content = written.get(LOCAL_FORWARDER) ?? '';
    expect(content).toMatch(/^[\x20-\x7e\r\n]+$/);
    expect(content.split('\r\n')).toContain(`"${INSTALLED}" %*`);
  });

  it('does not trust a short answer that names another file: it forwards instead', async () => {
    const other = 'C:\\PROGRA~2\\mu\\resources\\mu\\acp.cmd';
    const { deps } = machine({
      files: { [INSTALLED]: INSTALLED, [other]: 'C:\\Program Files (x86)\\mu\\resources\\mu\\acp.cmd' },
      short: other,
      writable: [ENV.LOCALAPPDATA as string],
    });
    expect((await ownLauncher(INSTALLED, deps)).command).toBe(LOCAL_FORWARDER);
  });

  it('forwards when the short-path lookup gives no answer', async () => {
    const { deps } = machine({ files: { [INSTALLED]: INSTALLED }, writable: [ENV.LOCALAPPDATA as string] });
    expect((await ownLauncher(INSTALLED, deps)).command).toBe(LOCAL_FORWARDER);
  });

  it('puts the forwarder in the first folder without spaces that takes it', async () => {
    const env = { ...ENV, LOCALAPPDATA: 'C:\\Users\\some one\\AppData\\Local' };
    const programData = machine({ env, files: { [INSTALLED]: INSTALLED }, writable: ['C:\\ProgramData', 'C:\\Users'] });
    expect((await ownLauncher(INSTALLED, programData.deps)).command).toBe('C:\\ProgramData\\mu-desktop\\acp.cmd');
    // Another account's forwarder in ProgramData is not this one's to change.
    const published = machine({ env, files: { [INSTALLED]: INSTALLED }, writable: ['C:\\Users\\Public'] });
    expect((await ownLauncher(INSTALLED, published.deps)).command).toBe('C:\\Users\\Public\\mu-desktop\\acp.cmd');
  });

  it('forwards to an ASCII short spelling of a folder outside ASCII', async () => {
    const launcher = 'C:\\Program Files\\Müller\\mu\\resources\\mu\\acp.cmd';
    // Only the second folder has a short name: the spelling still has a space, but it is ASCII.
    const short = 'C:\\Program Files\\MLLER~1\\mu\\resources\\mu\\acp.cmd';
    const { deps, written } = machine({
      files: { [launcher]: launcher, [short]: launcher },
      short,
      writable: [ENV.LOCALAPPDATA as string],
    });
    expect((await ownLauncher(launcher, deps)).command).toBe(LOCAL_FORWARDER);
    expect(written.get(LOCAL_FORWARDER)).toContain(`"${short}" %*`);
  });

  it('fails with installPath when a folder outside ASCII has no short name, and writes nothing', async () => {
    const launcher = 'C:\\Program Files\\Müller\\mu\\resources\\mu\\acp.cmd';
    const { deps, written } = machine({
      files: { [launcher]: launcher },
      short: launcher,
      writable: [ENV.LOCALAPPDATA as string],
    });
    expect(await failure(ownLauncher(launcher, deps))).toBe('installPath');
    expect(written.size).toBe(0);
  });

  it('fails with installPath when no folder takes the forwarder', async () => {
    const { deps } = machine({ files: { [INSTALLED]: INSTALLED }, short: INSTALLED });
    expect(await failure(ownLauncher(INSTALLED, deps))).toBe('installPath');
    const nowhere = machine({ env: {}, files: { [INSTALLED]: INSTALLED }, short: INSTALLED, writable: ['C:\\'] });
    expect(await failure(ownLauncher(INSTALLED, nowhere.deps))).toBe('installPath');
  });
});

describe('which registered commands run this launcher', () => {
  const files = { [INSTALLED]: INSTALLED, [SHORT]: INSTALLED };

  it('knows the long and the short path in any case, and every forwarder it may have written', async () => {
    const { deps } = machine({ files, short: SHORT });
    const { sameFile } = await ownLauncher(INSTALLED, deps);
    for (const spelling of [
      INSTALLED,
      INSTALLED.toLowerCase(),
      SHORT,
      SHORT.toLowerCase(),
      'c:/program files/mu/resources/mu/acp.cmd',
      LOCAL_FORWARDER,
      'C:\\ProgramData\\mu-desktop\\acp.cmd',
      'C:\\Users\\Public\\mu-desktop\\ACP.CMD',
    ])
      expect(sameFile(spelling), spelling).toBe(true);
  });

  it('knows a spelling it never computed when the file system says it is the same file', async () => {
    const other = 'C:\\PROGRA~3\\mu\\resources\\mu\\acp.cmd';
    const { deps } = machine({ files: { ...files, [other]: INSTALLED }, short: SHORT });
    expect((await ownLauncher(INSTALLED, deps)).sameFile(other)).toBe(true);
  });

  it('never takes another file, a command that is no path, or a path it would look up on the network', async () => {
    const looked: string[] = [];
    const same = sameLauncher({
      spellings: [INSTALLED, SHORT],
      real: INSTALLED,
      realPath: (file) => {
        looked.push(file);
        return file;
      },
    });
    expect(same('C:\\mu\\resources\\mu\\acp.cmd')).toBe(false);
    expect(same('npx mu-acp')).toBe(false);
    expect(same('\\\\server\\share\\mu\\acp.cmd')).toBe(false);
    expect(looked).toEqual(['C:\\mu\\resources\\mu\\acp.cmd']);
  });

  it('is only the command itself on macOS and Linux', async () => {
    const launcher = '/opt/mu/resources/mu/acp';
    const { sameFile } = await ownLauncher(launcher, machine({ platform: 'linux' }).deps);
    expect(sameFile(launcher)).toBe(true);
    expect(sameFile('/OPT/mu/resources/mu/acp')).toBe(false);
  });
});

// https://github.com/qybaihe/mu/issues/14: only absent packaged launchers are eligible for restoration.
describe('restoring an uninstalled launcher', () => {
  it('recognizes missing Windows launchers, including old short paths, without probing arbitrary commands', async () => {
    const checked: string[] = [];
    const existing = 'D:\\other\\resources\\mu\\acp.cmd';
    const { deps } = machine({ files: { [INSTALLED]: INSTALLED }, short: SHORT });
    const own = await ownLauncher('C:\\mu\\resources\\mu\\acp.cmd', {
      ...deps,
      missing: (file) => {
        checked.push(file);
        return file !== existing;
      },
    });
    for (const file of [INSTALLED, SHORT, 'c:/old/RESOURCES/mu/ACP.CMD']) expect(own.canRestore?.(file)).toBe(true);
    expect(own.canRestore?.(existing)).toBe(false);
    const before = checked.length;
    for (const file of [
      'npx mu-acp',
      'resources\\mu\\acp.cmd',
      'C:\\custom\\acp.cmd',
      '\\\\server\\share\\resources\\mu\\acp.cmd',
      'C:\\mu\\resources\\mu\\acp.cmd --flag',
    ])
      expect(own.canRestore?.(file), file).toBe(false);
    expect(checked).toHaveLength(before);
  });

  it('never lets a development checkout restore a packaged registration', async () => {
    const own = await ownLauncher('/checkout/desktop/scripts/kyrn/acp', {
      platform: 'linux',
      missing: () => {
        throw new Error('must not probe');
      },
    });
    expect(own.canRestore?.('/opt/mu/resources/mu/acp')).toBe(false);
  });

  it('checks actual file removal on the host platform before allowing restoration', async () => {
    const platform = process.platform;
    const root = mkdtempSync(join(tmpdir(), 'mu-reinstall-'));
    try {
      const filename = platform === 'win32' ? 'acp.cmd' : 'acp';
      const old = join(root, 'old', platform === 'darwin' ? 'Resources' : 'resources', 'mu', filename);
      mkdirSync(join(old, '..'), { recursive: true });
      writeFileSync(old, '');
      const current = join(root, 'new', 'resources', 'mu', filename);
      mkdirSync(join(current, '..'), { recursive: true });
      writeFileSync(current, '');
      const own = await ownLauncher(current, { env: { ...process.env, LOCALAPPDATA: join(root, 'local') } });
      expect(own.canRestore?.(old)).toBe(false);
      rmSync(old);
      expect(own.canRestore?.(old)).toBe(true);
      expect(own.canRestore?.('//server/resources/mu/acp')).toBe(false);
      expect(own.canRestore?.('/opt/custom/acp')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the forwarder', () => {
  it('goes to the user’s own local app data first, then ProgramData, then the public profile', () => {
    expect(forwarderFolders(ENV)).toEqual([
      'C:\\Users\\someone\\AppData\\Local\\mu-desktop',
      'C:\\ProgramData\\mu-desktop',
      'C:\\Users\\Public\\mu-desktop',
    ]);
    expect(forwarderFolders({ ProgramData: 'C:\\ProgramData' })).toEqual(['C:\\ProgramData\\mu-desktop']);
  });

  it('is an ASCII batch file that hands over to the launcher with its arguments, without `call`', () => {
    const lines = forwarderContent(INSTALLED).split('\r\n');
    expect(lines[0]).toBe('@echo off');
    expect(lines).toContain('setlocal DisableDelayedExpansion');
    expect(lines.at(-2)).toBe(`"${INSTALLED}" %*`);
    expect(lines.some((line) => /^\s*call\b/i.test(line))).toBe(false);
    expect(forwarderContent(INSTALLED)).not.toMatch(/[^\r]\n/);
  });

  it('doubles a percent sign of the path, as a batch file says one', () => {
    expect(forwarderContent('C:\\100% apps\\mu\\resources\\mu\\acp.cmd')).toContain(
      '"C:\\100%% apps\\mu\\resources\\mu\\acp.cmd" %*'
    );
  });

  it('is planned only for a path that has spaces and no spelling without them', () => {
    expect(
      planCommand({ launcher: 'C:\\mu\\acp.cmd', real: 'C:\\mu\\acp.cmd', short: undefined, folders: [] })
    ).toEqual({ use: 'C:\\mu\\acp.cmd' });
    expect(planCommand({ launcher: INSTALLED, real: INSTALLED, short: SHORT, folders: [] })).toEqual({ use: SHORT });
    expect(
      planCommand({
        launcher: INSTALLED,
        real: INSTALLED,
        short: undefined,
        folders: ['C:\\a b', 'C:\\ProgramData\\x'],
      })
    ).toEqual({ forward: { content: forwarderContent(INSTALLED), files: ['C:\\ProgramData\\x\\acp.cmd'] } });
  });
});

describe('asking cmd.exe for a short path', () => {
  it('hands the path over in a variable, never as part of the command line', () => {
    const query = shortPathQuery('C:\\a & b\\100%\\acp.cmd', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' });
    expect(query.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(query.args.join(' ')).not.toContain('a & b');
    expect(query.args.at(-1)).toBe('"for %I in ("%MU_SHORT_PATH_OF%") do @echo %~sI"');
    expect(query.env.MU_SHORT_PATH_OF).toBe('C:\\a & b\\100%\\acp.cmd');
  });

  it('reads the answer in UTF-16, or in bytes, and nothing that is not a path', () => {
    expect(parseShortPath(Buffer.from(`${SHORT}\r\n`, 'utf16le'))).toBe(SHORT);
    expect(parseShortPath(Buffer.from('C:\\MLLER~1\\Ä\r\n', 'utf16le'))).toBe('C:\\MLLER~1\\Ä');
    expect(parseShortPath(Buffer.from(`${SHORT}\r\n`, 'utf8'))).toBe(SHORT);
    expect(parseShortPath(Buffer.from('ECHO is off.\r\n', 'utf16le'))).toBeUndefined();
    expect(parseShortPath(Buffer.alloc(0))).toBeUndefined();
  });
});

// The same, run by Windows itself: the Windows unit tests of the public repository's CI (windows-tests.yml).
describe.runIf(process.platform === 'win32')('on Windows', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  /** A launcher in a folder whose path has a space: it records its arguments beside it and exits with 7. */
  function spacedLauncher(): { root: string; launcher: string } {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mu-launcher-')));
    roots.push(root);
    const folder = join(root, 'Program Files', 'mu');
    mkdirSync(folder, { recursive: true });
    const launcher = join(folder, 'acp.cmd');
    writeFileSync(launcher, ['@echo off', 'echo %*> "%~dp0args.txt"', 'exit /b 7', ''].join('\r\n'));
    return { root, launcher };
  }
  /** Runs a command the way AionCore runs a .cmd: `cmd /d /c <command> <args>`. */
  const run = (command: string, args: string[]) =>
    spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', command, ...args], {
      encoding: 'utf8',
      windowsHide: true,
    });

  it('gets a short path that names the same file, or the long one when the volume keeps none', async () => {
    const { launcher } = spacedLauncher();
    const short = await windowsShortPath(launcher);
    expect(short).toBeDefined();
    expect(realpathSync.native(short as string).toLowerCase()).toBe(launcher.toLowerCase());
  });

  it('runs a forwarder that hands over the arguments and the exit code', () => {
    const { root, launcher } = spacedLauncher();
    const forwarder = join(root, 'forwarder', 'acp.cmd');
    mkdirSync(join(root, 'forwarder'));
    writeFileSync(forwarder, forwarderContent(launcher));
    const result = run(forwarder, ['one', 'two']);
    expect(result.status).toBe(7);
    expect(readFileSync(join(launcher, '..', 'args.txt'), 'utf8').trim()).toBe('one two');
  });

  it('registers a command without whitespace that runs the launcher', async () => {
    const { root, launcher } = spacedLauncher();
    const own = await ownLauncher(launcher, { env: { ...process.env, LOCALAPPDATA: join(root, 'local') } });
    expect(own.command).not.toMatch(/\s/);
    expect(own.sameFile(launcher)).toBe(true);
    expect(run(own.command, ['three']).status).toBe(7);
    expect(readFileSync(join(launcher, '..', 'args.txt'), 'utf8').trim()).toBe('three');
  });
});
