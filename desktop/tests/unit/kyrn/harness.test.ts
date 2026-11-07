import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bundledHarnessRoot,
  envFileOf,
  expectedHarness,
  findHarness,
  launcherOf,
  layoutOf,
  manifestOf,
  nodeVersionOk as adapterNodeOk,
  type HarnessDeps,
} from '../../../packages/desktop/src/process/agent/kyrn/harness.ts';
import { loadManifest } from '../../../packages/desktop/src/process/agent/kyrn/config/features.ts';
import { endTree, launchCommand } from '../../../packages/desktop/src/process/agent/kyrn/piRpc.ts';
// @ts-expect-error -- a plain .mjs script with no type declarations
import { nodeVersionOk } from '../../../scripts/kyrn/acp.mjs';

/** Only these files exist, for layoutOf. */
const onlyFiles = (files: string[]) => ({ platform: 'linux' as const, exists: (file: string) => files.includes(file) });

/** A machine made of the files named, nothing else. */
function machine(platform: NodeJS.Platform, files: string[], patch: Partial<HarnessDeps> = {}): Partial<HarnessDeps> {
  const found = new Set(files);
  return {
    platform,
    env: {},
    home: platform === 'win32' ? 'C:\\Users\\someone' : '/home/someone',
    exists: (file) => found.has(file),
    list: () => [],
    real: (file) => file,
    resourcesPath: undefined,
    ...patch,
  };
}

describe('where the desktop finds the mu harness', () => {
  it('takes MU_ROOT or KYRN_ROOT first, as in development', () => {
    const deps = machine('darwin', [], { env: { KYRN_ROOT: '/work/KYRN' } });
    expect(findHarness('/work/KYRN-desktop', deps)).toEqual({ root: '/work/KYRN', layout: 'repo', source: 'env' });
    const both = machine('darwin', [], { env: { MU_ROOT: '/work/mu', KYRN_ROOT: '/work/KYRN' } });
    expect(findHarness('/work/KYRN-desktop', both)?.root).toBe('/work/mu');
  });

  it('then the copy the packaged app carries, before anything else on the machine', () => {
    const resources = '/Applications/mu.app/Contents/Resources';
    const bundled = `${resources}/harness/mu-agent`;
    const files = [
      `${bundled}/kyrn/bin/mu.mjs`,
      `${bundled}/dist/bundle/cli.js`,
      // A checkout beside and an npm install: both lose to the app's own copy.
      '/work/KYRN/kyrn/bin/mu.mjs',
      '/usr/local/lib/node_modules/mu-agent/kyrn/bin/mu.mjs',
    ];
    const app = machine('darwin', files, { resourcesPath: resources });
    expect(findHarness(undefined, app)).toEqual({ root: bundled, layout: 'package', source: 'bundled' });
    expect(findHarness('/work/KYRN-desktop', app)?.source).toBe('bundled');
    expect(findHarness(undefined, { ...app, env: { MU_ROOT: '/work/KYRN' } })?.source).toBe('env');
    // Development: Electron's own resources folder holds no mu.
    expect(findHarness('/work/KYRN-desktop', { ...app, resourcesPath: '/dev/electron/Resources' })?.source).toBe(
      'beside'
    );
    expect(bundledHarnessRoot('C:\\Program Files\\mu\\resources', 'win32')).toBe(
      'C:\\Program Files\\mu\\resources\\harness\\mu-agent'
    );
  });

  it('names where mu should be when none is found: the packaged app’s own copy, else the checkout beside', () => {
    expect(expectedHarness(undefined, '/Applications/mu.app/Contents/Resources', 'darwin')).toEqual({
      root: '/Applications/mu.app/Contents/Resources/harness/mu-agent',
      layout: 'package',
    });
    expect(expectedHarness('/work/KYRN-desktop', '/dev/electron/Resources', 'darwin')).toEqual({
      root: '/work/KYRN',
      layout: 'repo',
    });
  });

  it('then a checkout beside the desktop: the two repositories side by side, or the MU monorepo', () => {
    const sideBySide = machine('darwin', [
      '/work/KYRN/kyrn/bin/mu.mjs',
      '/work/KYRN/packages/coding-agent/package.json',
    ]);
    expect(findHarness('/work/KYRN-desktop', sideBySide)).toEqual({
      root: '/work/KYRN',
      layout: 'repo',
      source: 'beside',
    });
    const monorepo = machine('win32', ['C:\\src\\MU\\kyrn\\bin\\mu.mjs']);
    expect(findHarness('C:\\src\\MU\\desktop', monorepo)).toMatchObject({ root: 'C:\\src\\MU', source: 'beside' });
    // The packaged app has no checkout: nothing is looked for beside wherever it starts.
    expect(findHarness(undefined, monorepo)).toBeUndefined();
  });

  it('then mu-agent installed with npm, found from `mu` on PATH or in the usual global folders', () => {
    const pkg = '/usr/local/lib/node_modules/mu-agent';
    const packaged = [`${pkg}/kyrn/bin/mu.mjs`, `${pkg}/dist/bundle/cli.js`];
    // npm links bin/mu to the package's launcher.
    const linked = machine('linux', ['/usr/local/bin/mu', ...packaged], {
      env: { PATH: '/usr/bin:/usr/local/bin' },
      real: (file) => (file === '/usr/local/bin/mu' ? `${pkg}/kyrn/bin/mu.mjs` : file),
    });
    expect(findHarness('/opt/mu-desktop', linked)).toEqual({ root: pkg, layout: 'package', source: 'global' });
    // A Mac app's PATH is short: the usual prefix is looked in anyway.
    expect(findHarness('/Applications/mu.app/Contents', machine('darwin', packaged))).toMatchObject({ root: pkg });
    // nvm: the newest Node's global folder first.
    const nvm = '/home/someone/.nvm/versions/node';
    const nvmFiles = [
      `${nvm}/v22.19.0/lib/node_modules/mu-agent/kyrn/bin/mu.mjs`,
      `${nvm}/v24.16.0/lib/node_modules/mu-agent/kyrn/bin/mu.mjs`,
    ];
    const withNvm = machine('linux', nvmFiles, {
      list: (dir) => (dir === nvm ? ['v22.19.0', 'v24.16.0', 'v9.11.2'] : []),
    });
    expect(findHarness('/opt/mu-desktop', withNvm)?.root).toBe(`${nvm}/v24.16.0/lib/node_modules/mu-agent`);
  });

  it('on Windows: beside npm’s mu.cmd on PATH, or in %APPDATA%\\npm', () => {
    const nodeDir = 'C:\\Program Files\\nodejs';
    const beside = machine('win32', [`${nodeDir}\\mu.cmd`, `${nodeDir}\\node_modules\\mu-agent\\kyrn\\bin\\mu.mjs`], {
      env: { PATH: `C:\\Windows;${nodeDir}` },
    });
    expect(findHarness('C:\\Program Files\\mu', beside)?.root).toBe(`${nodeDir}\\node_modules\\mu-agent`);
    const appData = 'C:\\Users\\someone\\AppData\\Roaming';
    const pkg = `${appData}\\npm\\node_modules\\mu-agent`;
    const roaming = machine('win32', [`${pkg}\\kyrn\\bin\\mu.mjs`, `${pkg}\\dist\\bundle\\cli.js`], {
      env: { APPDATA: appData },
    });
    expect(findHarness('C:\\Program Files\\mu', roaming)).toEqual({ root: pkg, layout: 'package', source: 'global' });
    expect(findHarness('C:\\Program Files\\mu', machine('win32', []))).toBeUndefined();
  });

  it('tells a checkout from the npm package as the harness does', () => {
    expect(layoutOf('/m', onlyFiles(['/m/packages/coding-agent/package.json', '/m/dist/bundle/cli.js']))).toBe('repo');
    expect(layoutOf('/m', onlyFiles(['/m/dist/bundle/cli.js']))).toBe('package');
    expect(layoutOf('/m', onlyFiles([]))).toBe('repo');
  });
});

describe('how the harness is started and where it keeps things', () => {
  it('starts a checkout through its bash forwarder on macOS and Linux, and mu.mjs on Windows or from npm', () => {
    expect(launcherOf({ root: '/work/KYRN', layout: 'repo' }, 'darwin')).toBe('/work/KYRN/kyrn/bin/kyrn');
    expect(launcherOf({ root: '/g/mu-agent', layout: 'package' }, 'linux')).toBe('/g/mu-agent/kyrn/bin/mu.mjs');
    expect(launcherOf({ root: 'C:\\src\\MU', layout: 'repo' }, 'win32')).toBe('C:\\src\\MU\\kyrn\\bin\\mu.mjs');
  });

  it('runs a Node launcher with Node and no shell, and anything else as it is', () => {
    expect(launchCommand('C:\\src\\MU\\kyrn\\bin\\mu.mjs', ['--mode', 'rpc'], 'C:\\node\\node.exe', false)).toEqual({
      command: 'C:\\node\\node.exe',
      args: ['C:\\src\\MU\\kyrn\\bin\\mu.mjs', '--mode', 'rpc'],
      env: {},
    });
    expect(launchCommand('/work/KYRN/kyrn/bin/kyrn', ['--mode', 'rpc'], '/usr/bin/node', true)).toEqual({
      command: '/work/KYRN/kyrn/bin/kyrn',
      args: ['--mode', 'rpc'],
      env: {},
    });
  });

  it('runs the Node launcher on the app’s own Electron as Node, which needs no Node on the machine', () => {
    const app = '/Applications/mu.app/Contents/MacOS/mu';
    const launcher = '/Applications/mu.app/Contents/Resources/harness/mu-agent/kyrn/bin/mu.mjs';
    expect(launchCommand(launcher, ['auth', 'status'], app, true)).toEqual({
      command: app,
      args: [launcher, 'auth', 'status'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
  });

  it('ends the whole tree: the process group on POSIX, taskkill /T on Windows', () => {
    const calls: string[] = [];
    const run = {
      group: (pid: number, signal: NodeJS.Signals) => calls.push(`group ${pid} ${signal}`),
      taskkill: (args: string[]) => calls.push(`taskkill ${args.join(' ')}`),
      own: (signal: NodeJS.Signals) => calls.push(`own ${signal}`),
    };
    endTree(42, 'SIGTERM', 'darwin', run);
    endTree(42, 'SIGTERM', 'win32', run);
    endTree(undefined, 'SIGKILL', 'linux', run);
    expect(calls).toEqual(['group 42 SIGTERM', 'taskkill /pid 42 /T /F', 'own SIGKILL']);
  });

  it('reads keys from mu’s home and the manifest from the built layer when mu comes from npm', () => {
    const repo = { root: '/work/KYRN', layout: 'repo' as const };
    const pkg = { root: '/g/mu-agent', layout: 'package' as const };
    expect(envFileOf(repo, '/home/someone/.mu', 'linux')).toBe('/work/KYRN/.env');
    expect(envFileOf(pkg, '/home/someone/.mu', 'linux')).toBe('/home/someone/.mu/.env');
    expect(manifestOf(repo, 'linux')).toBe('/work/KYRN/packages/kyrn-judge/manifest.json');
    expect(manifestOf(pkg, 'linux')).toBe('/g/mu-agent/judge/manifest.json');
  });

  it('asks for the Node the harness needs before starting the adapter, from source and bundled alike', () => {
    for (const ok of [nodeVersionOk, adapterNodeOk]) {
      expect(ok('v22.19.0')).toBe(true);
      expect(ok('24.16.0')).toBe(true);
      expect(ok('22.18.1')).toBe(false);
      expect(ok('v20.20.1')).toBe(false);
    }
  });
});

describe('files of an npm-installed harness', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('reads the manifest from the file it is given', () => {
    dir = mkdtempSync(join(tmpdir(), 'mu-harness-'));
    const file = join(dir, 'judge', 'manifest.json');
    mkdirSync(join(dir, 'judge'), { recursive: true });
    writeFileSync(file, '{"not":"a manifest"');
    expect(loadManifest(dir, file)).toEqual({ status: 'missing' });
    expect(loadManifest(dir)).toEqual({ status: 'missing' });
  });
});
