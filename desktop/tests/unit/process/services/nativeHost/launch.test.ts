import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isNativeHostEnabled,
  nativeHostEntry,
  nativeHostReady,
  nativeHostSetting,
  startNativeHost,
} from '../../../../../packages/desktop/src/process/services/nativeHost/index.ts';
import {
  checkHost,
  prepareHost,
  type HostPlan,
  type LauncherFs,
  type PrepareOptions,
} from '../../../../../packages/desktop/src/process/services/nativeHost/launch.ts';
import { FakeChild } from './fakeChild.ts';

/**
 * How a host is started: the launcher's plan (launch.ts), and the app's wiring around it (index.ts), with Electron,
 * the system proxy and the harness lookup played by the test.
 */

const electron = vi.hoisted(() => ({
  app: { isPackaged: false },
  utilityProcess: { fork: vi.fn() },
}));
const findHarness = vi.hoisted(() => vi.fn());

vi.mock('electron', () => electron);
vi.mock('../../../../../packages/desktop/src/process/agent/kyrn/config/systemProxy.ts', () => ({
  systemProxyEnv: () => ({ HTTPS_PROXY: 'http://system-proxy:8080', NO_PROXY: '127.0.0.1' }),
}));
vi.mock('../../../../../packages/desktop/src/process/agent/kyrn/harness.ts', () => ({ findHarness }));

const PLAN: HostPlan = {
  module: '/mu/packages/coding-agent/src/index.ts',
  execArgv: ['--import', '/mu/source-resolver.ts'],
  args: ['-e', '/mu/judge.ts', '--mode', 'rpc'],
  env: { HOME: '/home/someone', MU_AGENT_DIR: '/home/someone/.mu/agent' },
  layout: 'repo',
  muDir: '/home/someone/.mu',
  appDir: '/home/someone/.mu/app',
  agentDir: '/home/someone/.mu/agent',
  startJudge: false,
  notes: ['mu: .env: skipped line 3 (not KEY=VALUE)'],
};

const fsWith = (files: string[]): LauncherFs => ({
  exists: (file) => files.includes(file),
  isDir: () => false,
  readFile: () => {
    throw new Error('not read in these tests');
  },
});

const options = (patch: Partial<PrepareOptions> = {}): PrepareOptions => ({
  harness: { root: '/mu' },
  cwd: '/project',
  env: { HOME: '/home/someone' },
  home: '/home/someone',
  platform: 'darwin',
  stripsTypes: true,
  fs: fsWith(['/mu/kyrn/bin/mu.mjs']),
  ...patch,
});

describe('prepareHost', () => {
  it('asks the harness’s launcher for the plan, and prepares the launch as the command line does', async () => {
    const planHost = vi.fn(() => PLAN);
    const prepareLaunch = vi.fn((input: { err(line: string): void }) => input.err(PLAN.notes[0]));
    const importLauncher = vi.fn(async () => ({ planHost, prepareLaunch }));
    const note = vi.fn();
    const prepared = await prepareHost(options({ importLauncher, note }));
    expect(importLauncher).toHaveBeenCalledWith('/mu/kyrn/bin/mu.mjs');
    expect(planHost).toHaveBeenCalledWith({
      platform: 'darwin',
      env: { HOME: '/home/someone' },
      argv: ['--mode', 'rpc'],
      root: '/mu',
      home: '/home/someone',
      stripsTypes: true,
      fs: expect.any(Object),
    });
    expect(prepareLaunch).toHaveBeenCalledWith({
      plan: PLAN,
      platform: 'darwin',
      root: '/mu',
      bin: '/mu/kyrn/bin',
      err: expect.any(Function),
    });
    expect(note).toHaveBeenCalledWith(PLAN.notes[0]);
    expect(prepared).toEqual({
      module: PLAN.module,
      args: PLAN.args,
      execArgv: PLAN.execArgv,
      env: PLAN.env,
      cwd: '/project',
      layout: 'repo',
      agentDir: PLAN.agentDir,
      notes: PLAN.notes,
    });
  });

  it('prepares with prepareLaunchAsync when the launcher has it, and waits for it', async () => {
    const prepareLaunch = vi.fn();
    let finish: (() => void) | undefined;
    const prepareLaunchAsync = vi.fn(
      (input: { err(line: string): void }) =>
        new Promise<void>((resolve) => {
          input.err('mu: the local judge did not start (mu judge status); decisions fall back to pi’s behaviour');
          finish = resolve;
        })
    );
    const importLauncher = vi.fn(async () => ({ planHost: () => PLAN, prepareLaunch, prepareLaunchAsync }));
    let prepared = false;
    const preparing = prepareHost(options({ importLauncher })).then((host) => {
      prepared = true;
      return host;
    });
    await vi.waitFor(() => expect(prepareLaunchAsync).toHaveBeenCalledTimes(1));
    expect(prepareLaunchAsync).toHaveBeenCalledWith({
      plan: PLAN,
      platform: 'darwin',
      root: '/mu',
      bin: '/mu/kyrn/bin',
      err: expect.any(Function),
    });
    await Promise.resolve();
    expect(prepared).toBe(false);
    finish?.();
    await expect(preparing).resolves.toMatchObject({
      module: PLAN.module,
      notes: ['mu: the local judge did not start (mu judge status); decisions fall back to pi’s behaviour'],
    });
    expect(prepareLaunch).not.toHaveBeenCalled();
  });

  it('says `plan` when the launcher cannot prepare the launch', async () => {
    const importLauncher = vi.fn(async () => ({
      planHost: () => PLAN,
      prepareLaunch: () => {
        throw new Error("EACCES: permission denied, mkdir '/home/someone/.mu/agent'");
      },
    }));
    await expect(prepareHost(options({ importLauncher }))).rejects.toMatchObject({
      kind: 'plan',
      message: "mu could not prepare the launch: EACCES: permission denied, mkdir '/home/someone/.mu/agent'",
    });
  });

  it('finds the launcher by Windows paths on Windows', async () => {
    const importLauncher = vi.fn(async () => ({ planHost: () => PLAN, prepareLaunch: vi.fn() }));
    await prepareHost(
      options({
        harness: { root: 'C:\\mu' },
        platform: 'win32',
        fs: fsWith(['C:\\mu\\kyrn\\bin\\mu.mjs']),
        importLauncher,
        argv: ['--mode', 'rpc', '--session', 'abc'],
      })
    );
    expect(importLauncher).toHaveBeenCalledWith('C:\\mu\\kyrn\\bin\\mu.mjs');
  });

  it('says what is wrong with a harness it cannot start', async () => {
    await expect(prepareHost(options({ fs: fsWith([]) }))).rejects.toMatchObject({
      kind: 'no-harness',
      message: 'No mu launcher at /mu/kyrn/bin/mu.mjs',
    });
    await expect(
      prepareHost(options({ importLauncher: () => Promise.reject(new Error('SyntaxError: bad')) }))
    ).rejects.toMatchObject({
      kind: 'no-harness',
      message: "mu's launcher did not load (/mu/kyrn/bin/mu.mjs): SyntaxError: bad",
    });
    await expect(
      prepareHost(options({ importLauncher: async () => ({ planLaunch: () => ({}) }) }))
    ).rejects.toMatchObject({
      kind: 'old-harness',
    });
    const refuses = { planHost: () => ({ error: 'pi needs Node 22.18' }), prepareLaunch: vi.fn() };
    await expect(prepareHost(options({ importLauncher: async () => refuses }))).rejects.toMatchObject({
      kind: 'plan',
      message: 'pi needs Node 22.18',
    });
    expect(refuses.prepareLaunch).not.toHaveBeenCalled();
  });
});

describe('checkHost', () => {
  it('is undefined for a launcher that can plan a host, and prepares nothing', async () => {
    const prepareLaunch = vi.fn();
    const prepareLaunchAsync = vi.fn();
    const importLauncher = vi.fn(async () => ({ planHost: () => PLAN, prepareLaunch, prepareLaunchAsync }));
    await expect(checkHost(options({ importLauncher }))).resolves.toBeUndefined();
    expect(importLauncher).toHaveBeenCalledWith('/mu/kyrn/bin/mu.mjs');
    // Nothing is written and no judge starts: it only asks.
    expect(prepareLaunch).not.toHaveBeenCalled();
    expect(prepareLaunchAsync).not.toHaveBeenCalled();
  });

  it('answers with what a start would fail with', async () => {
    await expect(checkHost(options({ fs: fsWith([]) }))).resolves.toMatchObject({ kind: 'no-harness' });
    await expect(
      checkHost(options({ importLauncher: () => Promise.reject(new Error('SyntaxError: bad')) }))
    ).resolves.toMatchObject({ kind: 'no-harness' });
    // A launcher from before the native host has neither function, or only one.
    await expect(
      checkHost(options({ importLauncher: async () => ({ planLaunch: () => ({}) }) }))
    ).resolves.toMatchObject({ kind: 'old-harness' });
    await expect(checkHost(options({ importLauncher: async () => ({ planHost: () => PLAN }) }))).resolves.toMatchObject(
      { kind: 'old-harness' }
    );
    await expect(
      checkHost(
        options({
          importLauncher: async () => ({ planHost: () => ({ error: 'pi needs Node 22.18' }), prepareLaunch: vi.fn() }),
        })
      )
    ).resolves.toMatchObject({ kind: 'plan', message: 'pi needs Node 22.18' });
  });

  it('does not swallow a launcher that throws something else', async () => {
    const importLauncher = async () => ({
      planHost: () => {
        throw new TypeError('input.fs is undefined');
      },
      prepareLaunch: vi.fn(),
    });
    await expect(checkHost(options({ importLauncher }))).rejects.toThrow('input.fs is undefined');
  });
});

describe('startNativeHost', () => {
  const root = mkdtempSync(join(tmpdir(), 'mu-native-launch-'));
  mkdirSync(join(root, 'kyrn', 'bin'), { recursive: true });
  // A launcher that plans from what it was given, so the test sees what the app handed it.
  writeFileSync(
    join(root, 'kyrn', 'bin', 'mu.mjs'),
    `export function planHost(input) {
  return {
    module: '/mu/pi.ts',
    execArgv: input.stripsTypes ? ['--strips-types'] : [],
    args: ['-e', '/mu/judge.ts', ...input.argv],
    env: { HOME: input.home, MARK: input.env.MARK ?? '', HTTPS_PROXY: 'http://planned-proxy:3128' },
    layout: 'repo', muDir: '/m', appDir: '/m/app', agentDir: '/m/agent', startJudge: false, notes: [],
  };
}
export function prepareLaunch() {}
`
  );

  beforeEach(() => {
    electron.app.isPackaged = false;
    electron.utilityProcess.fork.mockReset();
    findHarness.mockReset();
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is on unless MU_NATIVE_HOST=0 turns it off', async () => {
    for (const value of [undefined, '', '1', 'true', 'on', 'anything'])
      expect(isNativeHostEnabled({ MU_NATIVE_HOST: value })).toBe(true);
    for (const value of ['0', 'false', 'off', 'no', ' OFF '])
      expect(isNativeHostEnabled({ MU_NATIVE_HOST: value })).toBe(false);
    // Left alone it is `auto` (native where mu can run inside the app); 1 forces it; 0 is the kill switch.
    expect(nativeHostSetting({})).toBe('auto');
    expect(nativeHostSetting({ MU_NATIVE_HOST: '1' })).toBe('on');
    expect(nativeHostSetting({ MU_NATIVE_HOST: '0' })).toBe('off');
    await expect(startNativeHost({ cwd: '/project', env: { MU_NATIVE_HOST: '0' } })).rejects.toMatchObject({
      kind: 'off',
    });
    expect(findHarness).not.toHaveBeenCalled();
  });

  it('says so when no harness is found', async () => {
    findHarness.mockReturnValue(undefined);
    const env = { MU_NATIVE_HOST: '1', KYRN_DESKTOP_ROOT: '/desktop' };
    await expect(startNativeHost({ cwd: '/project', env })).rejects.toMatchObject({ kind: 'no-harness' });
    expect(findHarness).toHaveBeenCalledWith('/desktop', { env });
  });

  it('starts pi in a utility process with the launcher’s plan and the system’s proxy under it', async () => {
    findHarness.mockReturnValue({ root, layout: 'repo', source: 'env' });
    const child = new FakeChild();
    electron.utilityProcess.fork.mockReturnValue(child);
    const env = { MU_NATIVE_HOST: '1', MARK: 'from-the-app' };
    const host = await startNativeHost({ cwd: '/project', session: 'abc', entry: '/out/main/nativeHost.js', env });
    expect(electron.utilityProcess.fork).toHaveBeenCalledWith('/out/main/nativeHost.js', [], {
      env: {
        HTTPS_PROXY: 'http://planned-proxy:3128',
        NO_PROXY: '127.0.0.1',
        HOME: expect.any(String),
        MARK: 'from-the-app',
      },
      cwd: '/project',
      stdio: 'pipe',
      serviceName: 'mu',
    });
    // The Node options go in the init message: a utility process does not act on its execArgv.
    expect(child.posted[0]).toEqual({
      type: 'init',
      module: '/mu/pi.ts',
      args: ['-e', '/mu/judge.ts', '--mode', 'rpc', '--session', 'abc'],
      execArgv: process.features.typescript ? ['--strips-types'] : [],
    });
    expect(host.state).toEqual({ phase: 'starting' });
  });

  it('looks for no checkout beside a packaged app', async () => {
    electron.app.isPackaged = true;
    findHarness.mockReturnValue(undefined);
    const env = { MU_NATIVE_HOST: '1' };
    await expect(startNativeHost({ cwd: '/project', env })).rejects.toMatchObject({ kind: 'no-harness' });
    expect(findHarness).toHaveBeenCalledWith(undefined, { env });
  });

  it('starts the built host entry beside the main entry by default', () => {
    expect(nativeHostEntry()).toMatch(/[\\/]nativeHost\.js$/);
    // Absolute: a utility process runs in the project's folder, where a relative entry is not found (Electron 44's
    // `require.main.filename` is "electron", which made it one).
    expect(isAbsolute(nativeHostEntry())).toBe(true);
  });
});

describe('nativeHostReady', () => {
  const roots: string[] = [];
  /** A harness folder whose launcher is `source`, as mu's is at kyrn/bin/mu.mjs. */
  const harnessWith = (source: string): string => {
    const folder = mkdtempSync(join(tmpdir(), 'mu-native-ready-'));
    roots.push(folder);
    mkdirSync(join(folder, 'kyrn', 'bin'), { recursive: true });
    writeFileSync(join(folder, 'kyrn', 'bin', 'mu.mjs'), source);
    return folder;
  };
  const CAPABLE = `export function planHost(input) { return { module: '/mu/pi.ts', execArgv: [], args: input.argv, env: {}, layout: 'repo', muDir: '/m', appDir: '/m/app', agentDir: '/m/agent', startJudge: false, notes: [] }; }
export function prepareLaunch() { throw new Error('a check does not prepare a launch'); }
`;

  beforeEach(() => {
    electron.app.isPackaged = false;
    findHarness.mockReset();
  });

  afterAll(() => {
    for (const folder of roots) rmSync(folder, { recursive: true, force: true });
  });

  it('is off with MU_NATIVE_HOST=0, and looks for no mu', async () => {
    const note = vi.fn();
    await expect(nativeHostReady({ env: { MU_NATIVE_HOST: '0' }, note })).resolves.toBe(false);
    expect(findHarness).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
  });

  it('is on with MU_NATIVE_HOST=1 whatever mu is found: the person asked, and sees what fails', async () => {
    await expect(nativeHostReady({ env: { MU_NATIVE_HOST: '1' } })).resolves.toBe(true);
    expect(findHarness).not.toHaveBeenCalled();
  });

  it('is on, left alone, when the mu found can run inside the app', async () => {
    findHarness.mockReturnValue({ root: harnessWith(CAPABLE), layout: 'repo', source: 'env' });
    const env = { KYRN_DESKTOP_ROOT: '/desktop' };
    const note = vi.fn();
    await expect(nativeHostReady({ env, note })).resolves.toBe(true);
    expect(findHarness).toHaveBeenCalledWith('/desktop', { env });
    expect(note).not.toHaveBeenCalled();
  });

  it('stays off, and says why in a note, when there is no mu or it is too old', async () => {
    const note = vi.fn();
    findHarness.mockReturnValue(undefined);
    await expect(nativeHostReady({ env: {}, note })).resolves.toBe(false);
    expect(note).toHaveBeenLastCalledWith('the native host stays off: no mu harness was found');

    // The mu a packaged app carried before the native host: a launcher, without the functions to plan a host.
    findHarness.mockReturnValue({
      root: harnessWith('export function planLaunch() { return {}; }\n'),
      layout: 'package',
      source: 'bundled',
    });
    await expect(nativeHostReady({ env: {}, note })).resolves.toBe(false);
    expect(note).toHaveBeenLastCalledWith(expect.stringContaining('cannot run inside the app yet'));

    findHarness.mockReturnValue({
      root: harnessWith(
        "export function planHost() { return { error: 'pi needs Node 22.18' }; }\nexport function prepareLaunch() {}\n"
      ),
      layout: 'repo',
      source: 'env',
    });
    await expect(nativeHostReady({ env: {}, note })).resolves.toBe(false);
    expect(note).toHaveBeenLastCalledWith('the native host stays off: pi needs Node 22.18');

    findHarness.mockReturnValue({ root: harnessWith('export const broken = ;\n'), layout: 'repo', source: 'env' });
    await expect(nativeHostReady({ env: {}, note })).resolves.toBe(false);
    expect(note).toHaveBeenLastCalledWith(expect.stringContaining('launcher did not load'));
  });

  it('never rejects: a launcher that throws on planning keeps the classic path', async () => {
    findHarness.mockReturnValue({
      root: harnessWith(
        "export function planHost() { throw new TypeError('input.fs is undefined'); }\nexport function prepareLaunch() {}\n"
      ),
      layout: 'repo',
      source: 'env',
    });
    const note = vi.fn();
    await expect(nativeHostReady({ env: {}, note })).resolves.toBe(false);
    expect(note).toHaveBeenLastCalledWith('the native host stays off: input.fs is undefined');
  });
});
