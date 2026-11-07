import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  descendants,
  endProcessLook,
  leftovers,
  logFolders,
  packagedApp,
  parseProcesses,
  processTree,
  shellAnswers,
  shellQuestion,
  unpackedFolderName,
  // @ts-expect-error -- a plain .mjs module with no type declarations
} from '../../e2e/mu-conversation/app.mjs';
// @ts-expect-error -- a plain .mjs module with no type declarations
import { homeFolders, profileEnv } from '../../e2e/mu-conversation/profile.mjs';

type Entry = { pid: number; ppid: number; start: number; command: string };

const folders: string[] = [];
const scratch = () => {
  const folder = mkdtempSync(join(tmpdir(), 'mu-e2e-unit-'));
  folders.push(folder);
  return folder;
};
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
// The PowerShell a look at Windows' processes keeps running.
afterAll(() => endProcessLook());

const winPaths = {
  root: 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\mu-e2e-abc',
  home: 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\mu-e2e-abc\\home',
  userData: 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\mu-e2e-abc\\userData',
  agentDir: 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\mu-e2e-abc\\agent',
};
const macPaths = {
  root: '/private/var/folders/x/T/mu-e2e-abc',
  home: '/private/var/folders/x/T/mu-e2e-abc/home',
  userData: '/private/var/folders/x/T/mu-e2e-abc/userData',
  agentDir: '/private/var/folders/x/T/mu-e2e-abc/agent',
};

describe('the conversation E2E profile environment', () => {
  const windowsEnv = {
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    TEMP: 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp',
    ProgramFiles: 'C:\\Program Files',
    USERPROFILE: 'C:\\Users\\runneradmin',
    APPDATA: 'C:\\Users\\runneradmin\\AppData\\Roaming',
    PATH: 'C:\\hostedtoolcache\\node;C:\\Windows\\system32',
    OPENAI_API_KEY: 'sk-of-the-person',
    GITHUB_TOKEN: 'ghs-of-the-runner',
  };

  it('puts the home, the app data and the local app data of Windows in the profile', () => {
    const env = profileEnv({ platform: 'win32', env: windowsEnv, paths: winPaths, language: 'zh-CN' });
    expect(env).toMatchObject({
      HOME: winPaths.home,
      USERPROFILE: winPaths.home,
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\Users\\runneradmin\\AppData\\Local\\Temp\\mu-e2e-abc\\home',
      APPDATA: `${winPaths.home}\\AppData\\Roaming`,
      LOCALAPPDATA: `${winPaths.home}\\AppData\\Local`,
      MU_E2E_USER_DATA_DIR: winPaths.userData,
      MU_AGENT_DIR: winPaths.agentDir,
    });
    expect(env.CFFIXED_USER_HOME).toBeUndefined();
  });

  it("keeps Windows' own settings, and no key or token of the person or the runner", () => {
    const env = profileEnv({ platform: 'win32', env: windowsEnv, paths: winPaths, language: 'zh-CN' });
    expect(env).toMatchObject({
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      TEMP: windowsEnv.TEMP,
      ProgramFiles: 'C:\\Program Files',
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(Object.values(env).join('\n')).not.toContain('runneradmin\\AppData\\Roaming');
  });

  it("gives Windows the system's own PATH, with the Node named first", () => {
    const packaged = profileEnv({ platform: 'win32', env: windowsEnv, paths: winPaths, language: 'zh-CN' });
    expect(packaged.PATH.split(';')).toEqual([
      'C:\\Windows\\System32',
      'C:\\Windows',
      'C:\\Windows\\System32\\Wbem',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
      'C:\\Windows\\System32\\OpenSSH',
    ]);
    const checkout = profileEnv({
      platform: 'win32',
      env: windowsEnv,
      paths: winPaths,
      language: 'zh-CN',
      node: { dir: 'C:\\hostedtoolcache\\node\\24.0.0\\x64' },
    });
    expect(checkout.PATH.split(';')[0]).toBe('C:\\hostedtoolcache\\node\\24.0.0\\x64');
  });

  it('names no checkout, harness or backend to a packaged app, and all of them for the checkout build', () => {
    const packaged = profileEnv({ platform: 'darwin', env: {}, paths: macPaths, language: 'zh-CN' });
    for (const name of ['MU_ROOT', 'KYRN_ROOT', 'KYRN_DESKTOP_ROOT', 'MU_BACKEND_BIN', 'MU_NODE']) {
      expect(packaged[name], name).toBeUndefined();
    }
    const checkout = profileEnv({
      platform: 'darwin',
      env: {},
      paths: macPaths,
      language: 'zh-CN',
      node: { dir: '/n/bin' },
      checkout: { backend: '/d/aioncore', desktopRoot: '/d', harness: `${macPaths.root}/harness` },
    });
    expect(checkout).toMatchObject({
      MU_BACKEND_BIN: '/d/aioncore',
      KYRN_DESKTOP_ROOT: '/d',
      MU_ROOT: `${macPaths.root}/harness`,
      KYRN_ROOT: `${macPaths.root}/harness`,
    });
    expect(checkout.PATH).toBe('/n/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  });

  it('points HOME and Core Foundation at the profile on macOS, and keeps the temp folder', () => {
    const env = profileEnv({
      platform: 'darwin',
      env: { TMPDIR: '/var/folders/x/T/', HOME: '/Users/someone', AWS_SECRET_ACCESS_KEY: 'secret' },
      paths: macPaths,
      language: 'en-US',
    });
    expect(env).toMatchObject({ HOME: macPaths.home, CFFIXED_USER_HOME: macPaths.home, TMPDIR: '/var/folders/x/T/' });
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.USERPROFILE).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("gives a Windows home the user's own folders, which Windows looks for there and must find", () => {
    // Without Downloads in the profile's home, Electron's app.getPath('downloads') threw "Failed to get 'downloads' path".
    expect(homeFolders('win32', winPaths.home)).toEqual([
      `${winPaths.home}\\AppData\\Roaming`,
      `${winPaths.home}\\AppData\\Local`,
      `${winPaths.home}\\Desktop`,
      `${winPaths.home}\\Documents`,
      `${winPaths.home}\\Downloads`,
      `${winPaths.home}\\Music`,
      `${winPaths.home}\\Pictures`,
      `${winPaths.home}\\Videos`,
    ]);
    expect(homeFolders('darwin', macPaths.home)).toEqual([]);
    expect(homeFolders('linux', macPaths.home)).toEqual([]);
  });

  it("keeps the X server's display and its key on Linux: the profile's home has no .Xauthority", () => {
    // xvfb-run hands the display's key over in XAUTHORITY; without it the app cannot open the display and exits.
    const env = profileEnv({
      platform: 'linux',
      env: { DISPLAY: ':99', XAUTHORITY: '/tmp/xvfb-run.abc/Xauthority', HOME: '/home/runner' },
      paths: macPaths,
      language: 'zh-CN',
    });
    expect(env).toMatchObject({ DISPLAY: ':99', XAUTHORITY: '/tmp/xvfb-run.abc/Xauthority', HOME: macPaths.home });
  });
});

describe("the conversation E2E's look at the processes", () => {
  it("reads PowerShell's process list, one process or many", () => {
    const one = JSON.stringify({ pid: 4, ppid: 0, start: 0, command: '' });
    expect(parseProcesses('win32', one)).toEqual([{ pid: 4, ppid: 0, start: 0, command: '' }]);
    const many = JSON.stringify([
      { pid: 10, ppid: 4, start: 1_700_000_000_000, command: '"C:\\mu\\mu.exe" --lang=zh-CN' },
      { pid: 11, ppid: 10, start: 1_700_000_000_500, command: null },
    ]);
    expect(parseProcesses('win32', `${many}\r\n`)).toEqual([
      { pid: 10, ppid: 4, start: 1_700_000_000_000, command: '"C:\\mu\\mu.exe" --lang=zh-CN' },
      { pid: 11, ppid: 10, start: 1_700_000_000_500, command: '' },
    ]);
    expect(parseProcesses('win32', '')).toEqual([]);
  });

  it("reads ps's process list", () => {
    expect(
      parseProcesses('darwin', '  1     0 /sbin/launchd\n 501   1 /Applications/mu.app/Contents/MacOS/mu -x\n')
    ).toEqual([
      { pid: 1, ppid: 0, start: 0, command: '/sbin/launchd' },
      { pid: 501, ppid: 1, start: 0, command: '/Applications/mu.app/Contents/MacOS/mu -x' },
    ]);
  });

  it('follows the tree under a process, but not to an older process holding a reused parent pid', () => {
    const table: Entry[] = [
      { pid: 100, ppid: 1, start: 5_000, command: 'mu.exe' },
      { pid: 200, ppid: 100, start: 6_000, command: 'aioncore.exe' },
      { pid: 300, ppid: 200, start: 7_000, command: 'mu.exe mu-acp.js' },
      // Its parent 100 exited long ago: Windows gave the pid to the app since.
      { pid: 400, ppid: 100, start: 1_000, command: 'svchost.exe' },
    ];
    expect(descendants(table, 100).map((entry: Entry) => entry.pid)).toEqual([200, 300]);
  });

  it('counts a seen process as left over only with its pid, start and command line', () => {
    const seen = [{ pid: 300, start: 7_000, command: 'mu.exe mu-acp.js' }];
    const running: Entry[] = [
      // The same pid, given to another process since.
      { pid: 300, ppid: 1, start: 9_000, command: 'mu.exe mu-acp.js' },
      { pid: 301, ppid: 1, start: 9_500, command: 'notepad.exe' },
    ];
    expect(leftovers({ running, seen, root: winPaths.root, platform: 'win32', self: 1 })).toEqual([]);
    running.push({ pid: 300, ppid: 1, start: 7_000, command: 'mu.exe mu-acp.js' });
    expect(leftovers({ running, seen, root: winPaths.root, platform: 'win32', self: 1 })).toEqual([
      { pid: 300, command: 'mu.exe mu-acp.js' },
    ]);
  });

  it("finds on Windows a process naming the profile's folder in any case and with either slash", () => {
    const running: Entry[] = [
      {
        pid: 7,
        ppid: 1,
        start: 1,
        command: 'aioncore.exe --data-dir c:/users/runneradmin/appdata/local/temp/mu-e2e-abc/userData',
      },
      // The test's own PowerShell, which looks at the processes.
      { pid: 8, ppid: 1, start: 1, command: 'powershell.exe -NoProfile -NonInteractive -Command -' },
      { pid: 9, ppid: 1, start: 1, command: `node.exe ${winPaths.root}\\harness\\kyrn\\bin\\mu.mjs` },
    ];
    expect(
      leftovers({ running, root: winPaths.root, platform: 'win32', self: 9 }).map((entry: Entry) => entry.pid)
    ).toEqual([7]);
    // Elsewhere a path is compared as it is.
    expect(leftovers({ running, root: winPaths.root.toLowerCase(), platform: 'linux', self: 0 })).toEqual([]);
  });

  it('asks the PowerShell it keeps a command that always ends with the end mark, an error that stops it included', () => {
    expect(shellQuestion('Get-Date')).toBe(
      "try { Get-Date } catch { Write-Output ('<<mu-e2e: failed>>' + $_) }; Write-Output '<<mu-e2e: end of answer>>'"
    );
  });

  it('takes the answers out of what that PowerShell printed, and keeps an answer still to come', () => {
    const printed = [
      '[{"pid":1}]\r\n<<mu-e2e: end of answer>>',
      '\r\n<<mu-e2e: failed>>Access denied\r\n<<mu-e2e: end of answer>>',
      '\r\n[{"pid"',
    ].join('');
    const { answers, rest } = shellAnswers(printed);
    expect(answers).toEqual([{ text: '[{"pid":1}]\r\n' }, { error: 'Access denied' }]);
    // The rest, with what comes next, is the next answer; a mark split between two pieces is found once joined.
    expect(shellAnswers(`${rest}:2}]\r\n<<mu-e2e: end of`).answers).toEqual([]);
    expect(shellAnswers(`${rest}:2}]\r\n<<mu-e2e: end of answer>>`).answers).toEqual([{ text: '[{"pid":2}]\r\n' }]);
  });

  it("finds this machine's processes: a child of this test, by its pid, start and command line", async () => {
    const marker = scratch();
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', marker], { windowsHide: true });
    try {
      await new Promise((done) => child.once('spawn', done));
      const tree = await processTree(process.pid);
      const found = tree.find((entry: Entry) => entry.pid === child.pid);
      expect(found, 'the child is in the tree').toBeTruthy();
      expect(found.command).toContain(marker.split(/[\\/]/).pop());
      if (process.platform === 'win32') expect(found.start).toBeGreaterThan(0);
      const running = [{ ...found, ppid: process.pid }];
      expect(leftovers({ running, seen: [found], root: marker })).toEqual([{ pid: found.pid, command: found.command }]);
    } finally {
      child.kill();
    }
  }, 30_000);
});

describe('the packaged app the conversation E2E runs', () => {
  /** An unpacked app as electron-builder leaves it for Windows or Linux: its program beside resources/. */
  const unpacked = (dir: string, program: string, others: string[] = []) => {
    mkdirSync(join(dir, 'resources', 'harness'), { recursive: true });
    for (const name of [program, ...others]) {
      writeFileSync(join(dir, name), '');
      chmodSync(join(dir, name), 0o755);
    }
    writeFileSync(join(dir, 'libffmpeg.so'), '');
  };

  it("names electron-builder's folders by system and processor", () => {
    expect(unpackedFolderName('win32', 'x64')).toBe('win-unpacked');
    expect(unpackedFolderName('win32', 'arm64')).toBe('win-arm64-unpacked');
    expect(unpackedFolderName('linux', 'x64')).toBe('linux-unpacked');
    expect(unpackedFolderName('linux', 'arm64')).toBe('linux-arm64-unpacked');
    expect(unpackedFolderName('darwin', 'x64')).toBe('mac');
    expect(unpackedFolderName('darwin', 'arm64')).toBe('mac-arm64');
  });

  it("takes the Windows app for the processor asked for from the builder's output, not its uninstaller", () => {
    const out = scratch();
    unpacked(join(out, 'win-unpacked'), 'mu.exe', ['Uninstall mu.exe']);
    unpacked(join(out, 'win-arm64-unpacked'), 'mu.exe');
    expect(packagedApp(out, 'x64', 'win32')).toEqual({
      executable: join(out, 'win-unpacked', 'mu.exe'),
      resources: join(out, 'win-unpacked', 'resources'),
    });
    expect(packagedApp(out, 'arm64', 'win32')?.executable).toBe(join(out, 'win-arm64-unpacked', 'mu.exe'));
    expect(packagedApp(join(out, 'win-unpacked'), 'x64', 'win32')?.executable).toBe(
      join(out, 'win-unpacked', 'mu.exe')
    );
  });

  // Windows keeps no execute bit, which tells the Linux program from the other files.
  it.skipIf(process.platform === 'win32')('takes the Linux program, not the sandbox helper or a library', () => {
    const out = scratch();
    unpacked(join(out, 'linux-unpacked'), 'mu-desktop', ['chrome-sandbox', 'chrome_crashpad_handler']);
    expect(packagedApp(out, 'x64', 'linux')?.executable).toBe(join(out, 'linux-unpacked', 'mu-desktop'));
    expect(packagedApp(out, 'arm64', 'linux')).toBeUndefined();
  });

  it('takes the Mac app and its resources, from the output folder, the .app or its binary', () => {
    const out = scratch();
    const bundle = join(out, 'mac-arm64', 'mu.app');
    mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true });
    mkdirSync(join(bundle, 'Contents', 'Resources'), { recursive: true });
    writeFileSync(join(bundle, 'Contents', 'MacOS', 'mu'), '');
    const app = {
      executable: join(bundle, 'Contents', 'MacOS', 'mu'),
      resources: join(bundle, 'Contents', 'Resources'),
    };
    expect(packagedApp(out, 'arm64', 'darwin')).toEqual(app);
    expect(packagedApp(bundle, 'arm64', 'darwin')).toEqual(app);
    expect(packagedApp(app.executable, 'arm64', 'darwin')).toEqual({
      executable: app.executable,
      resources: join(bundle, 'Contents', 'MacOS', '..', 'Resources'),
    });
    expect(packagedApp(out, 'x64', 'darwin')).toBeUndefined();
  });

  it("reads the profile's logs where electron-log and the backend write them", () => {
    expect(logFolders({ paths: { userData: '/p/userData', home: '/p/home' } })).toEqual([
      join('/p/userData', 'logs'),
      join('/p/home', 'Library', 'Logs'),
    ]);
  });
});
