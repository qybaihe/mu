import { EventEmitter } from 'node:events';
import { posix } from 'node:path';

// The manager is tested as on a Mac, whatever runs the tests: its paths are POSIX ones.
const { delimiter, join } = posix;
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { MudeStatus } from '@/common/kyrn/mude';
import { Mude, parseStatus, type MudeDeps, type MudeProcess } from '@/process/agent/kyrn/mude';

vi.mock('@/process/agent/kyrn/config/systemProxy', () => ({ systemProxyEnv: () => ({}) }));

const HOME = '/Users/someone';
const AGENT_DIR = '/Users/someone/.mu/agent';
const APP = '/Applications/mu.app/Contents/MacOS/mu';
const PACKAGE = { root: '/Applications/mu.app/Contents/Resources/harness/mu-agent', layout: 'package' as const };

const STATUS: MudeStatus = {
  supported: true,
  problems: [],
  installed: true,
  pythonReady: true,
  running: true,
  ready: true,
  port: 8790,
  pid: 4242,
  memoryBytes: 3.6 * 1024 ** 3,
  enabled: true,
  localOnly: false,
  fallback: ['jev'],
  model: 'mude',
  folder: '/Users/someone/.mu/mude',
  log: '/Users/someone/.mu/mude/server.log',
};
const OFF: MudeStatus = {
  ...STATUS,
  installed: false,
  pythonReady: false,
  running: false,
  ready: false,
  enabled: false,
};

/** A child process the test drives: it prints lines, then ends with a code. Never the real command. */
function child() {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => {
    setImmediate(() => events.emit('close', null));
  });
  const process = {
    stdout,
    stderr,
    on: (event: string, listener: (...args: never[]) => void) => events.on(event, listener),
    kill,
  } as MudeProcess;
  return {
    process,
    kill,
    line: (event: Record<string, unknown>) => stdout.write(`${JSON.stringify(event)}\n`),
    print: (text: string) => stdout.write(text),
    fail: (text: string) => stderr.write(text),
    exit: async (code: number | null) => {
      await new Promise((resolve) => setImmediate(resolve));
      events.emit('close', code);
      await new Promise((resolve) => setImmediate(resolve));
    },
    error: (message: string) => events.emit('error', new Error(message)),
  };
}

type Spawned = { command: string; args: string[]; env: NodeJS.ProcessEnv; child: ReturnType<typeof child> };

/**
 * A manager whose `status` answers with `status` at once (never with null), and whose other commands wait for the test.
 */
function mude(patch: Partial<MudeDeps> = {}, status: MudeStatus | null = OFF) {
  const spawned: Spawned[] = [];
  const open = vi.fn(async (_folder: string) => undefined);
  const manager = new Mude(PACKAGE, {
    platform: 'darwin',
    env: { PATH: ['/usr/bin', '/bin'].join(delimiter), HOME },
    home: HOME,
    agentDir: AGENT_DIR,
    proxyEnv: () => ({ HTTPS_PROXY: 'http://proxy:8080' }),
    node: APP,
    electron: true,
    open,
    statusTimeoutMs: 1000,
    spawn: (command, args, env) => {
      const next = child();
      spawned.push({ command, args, env, child: next });
      if (args.includes('status') && status) {
        setImmediate(() => {
          next.line({ type: 'status', ...status });
          void next.exit(0);
        });
      }
      return next.process;
    },
    ...patch,
  });
  const commands = () => spawned.filter((entry) => !entry.args.includes('status'));
  return { manager, spawned, commands, open };
}

const LAUNCHER = join(PACKAGE.root, 'kyrn', 'bin', 'mu.mjs');

describe('mude as the app manages it', () => {
  it('runs `mu judge mude <cmd> --json` through the launcher, on the app as Node, with mu’s environment', async () => {
    const { manager, spawned } = mude();
    const state = await manager.state();
    expect(state).toEqual({ available: true, status: OFF });
    expect(spawned[0].command).toBe(APP);
    expect(spawned[0].args).toEqual([LAUNCHER, 'judge', 'mude', 'status', '--json']);
    expect(spawned[0].env).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      MU_AGENT_DIR: AGENT_DIR,
      HTTPS_PROXY: 'http://proxy:8080',
      HOME,
    });
    // A Mac app's PATH is short: where uv and Homebrew usually are come first.
    expect(spawned[0].env.PATH).toBe(
      [join(HOME, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter)
    );
  });

  it('starts a checkout through its bash forwarder', () => {
    const { manager } = mude();
    const checkout = new Mude({ root: '/src/mu', layout: 'repo' }, { platform: 'darwin', node: APP, electron: true });
    expect(checkout.command(['start']).command).toBe(join('/src/mu', 'kyrn', 'bin', 'kyrn'));
    expect(checkout.command(['start']).args).toEqual(['judge', 'mude', 'start', '--json']);
    expect(manager.command(['enable', '--local-only']).args).toEqual([
      LAUNCHER,
      'judge',
      'mude',
      'enable',
      '--local-only',
      '--json',
    ]);
  });

  it('is not offered off macOS, and runs nothing there', async () => {
    const spawn = vi.fn();
    const { manager } = mude({ platform: 'win32', spawn });
    expect(await manager.state()).toEqual({ available: false });
    await expect(manager.run('install')).rejects.toThrow('macOS');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('passes the flags each command takes', async () => {
    const cases: [Parameters<Mude['run']>, string[]][] = [
      [['install'], ['install']],
      [['install', false], ['install']],
      [
        ['install', true],
        ['install', '--local-only'],
      ],
      [['enable'], ['enable']],
      [
        ['enable', true],
        ['enable', '--local-only'],
      ],
      [
        ['enable', false],
        ['enable', '--with-fallback'],
      ],
      [['disable', true], ['disable']],
      [['start'], ['start']],
      [['stop'], ['stop']],
      [['uninstall'], ['uninstall']],
    ];
    const runs = cases.map(([input]) => {
      const one = mude();
      return one.manager.run(...input).then(() => one.commands()[0].args);
    });
    expect(await Promise.all(runs)).toEqual(
      cases.map(([, args]) => [LAUNCHER, 'judge', 'mude'].concat(args, '--json'))
    );
    await expect(mude().manager.run('reboot' as never)).rejects.toThrow('Unknown');
  });

  it('follows an install: its steps, the download, the Python log, then the status it ends with', async () => {
    // `status` never answers here: what the app knows at the end is what the install's last line said.
    const { manager, commands } = mude({ statusTimeoutMs: 5 }, null);
    const started = await manager.run('install');
    expect(started.task).toEqual({ id: 1, command: 'install', phase: 'running', log: [] });
    const run = commands()[0].child;
    run.line({ type: 'step', step: 'download', message: 'Downloading mude (1.8 GB) from Hugging Face.' });
    run.line({ type: 'progress', file: 'model.safetensors', done: 900, total: 1800, checking: false });
    await new Promise((resolve) => setImmediate(resolve));
    let state = await manager.state();
    expect(state.task).toMatchObject({
      phase: 'running',
      step: 'download',
      message: 'Downloading mude (1.8 GB) from Hugging Face.',
      download: { file: 'model.safetensors', done: 900, total: 1800, checking: false },
    });
    run.line({ type: 'progress', file: 'model.safetensors', done: 1800, total: 1800, checking: true });
    run.line({ type: 'step', step: 'python', message: 'Setting up Python.' });
    for (let index = 1; index <= 10; index++) run.line({ type: 'log', line: `Collecting package-${index}` });
    // A line that is not JSON (a Node warning) is kept with the log; a line split across chunks is joined.
    run.print('(node:1) ExperimentalWarning\n{"type":"step","step":"st');
    run.print('art","message":"Starting mude."}\n');
    await new Promise((resolve) => setImmediate(resolve));
    state = await manager.state();
    expect(state.task?.step).toBe('start');
    expect(state.task?.download).toBeUndefined();
    expect(state.task?.log).toHaveLength(8);
    expect(state.task?.log.at(-1)).toBe('(node:1) ExperimentalWarning');
    expect(state.task?.log[0]).toBe('Collecting package-4');
    run.line({ type: 'status', ...STATUS });
    await run.exit(0);
    state = await manager.state();
    expect(state.task).toMatchObject({ id: 1, phase: 'done' });
    expect(state.status).toEqual(STATUS);
  });

  it('runs one command at a time: a request while one runs only reads', async () => {
    const { manager, commands } = mude();
    await manager.run('install');
    const again = await manager.run('uninstall');
    expect(again.task).toMatchObject({ id: 1, command: 'install', phase: 'running' });
    expect(commands()).toHaveLength(1);
    // Nor is the status asked for while it runs: the command's own lines say where it stands.
    const before = (await manager.state()).task;
    expect(before?.id).toBe(1);
    await commands()[0].child.exit(0);
    await manager.run('start');
    expect(commands()).toHaveLength(2);
  });

  it('keeps the error a command reports, with its kind, and its exit code', async () => {
    const { manager, commands } = mude();
    await manager.run('install');
    const run = commands()[0].child;
    run.line({ type: 'step', step: 'download', message: 'Downloading.' });
    run.line({ type: 'error', message: 'Hugging Face refused the download (401).', kind: 'access' });
    await run.exit(1);
    const state = await manager.state();
    expect(state.task).toMatchObject({
      phase: 'failed',
      error: { message: 'Hugging Face refused the download (401).', kind: 'access' },
    });
    // An unknown kind is dropped; the message stays.
    await manager.run('start');
    const start = commands()[1].child;
    start.line({ type: 'error', message: 'Port 8790 is taken.', kind: 'surprise' });
    await start.exit(1);
    expect((await manager.state()).task?.error).toEqual({ message: 'Port 8790 is taken.' });
  });

  it('says what went wrong when the command printed no error line', async () => {
    const { manager, commands } = mude();
    await manager.run('enable', true);
    const usage = commands()[0].child;
    usage.fail('mu judge mude: unknown flag\n');
    await usage.exit(2);
    expect((await manager.state()).task).toMatchObject({
      phase: 'failed',
      error: { message: 'mu judge mude: unknown flag', kind: 'usage' },
    });
    await manager.run('stop');
    await commands()[1].child.exit(1);
    expect((await manager.state()).task?.error).toEqual({ message: 'mu judge mude stop ended with code 1' });
    await manager.run('start');
    commands()[2].child.error('spawn ENOENT');
    await new Promise((resolve) => setImmediate(resolve));
    expect((await manager.state()).task).toMatchObject({ phase: 'failed', error: { message: 'spawn ENOENT' } });
  });

  it('cancels a running install by ending the command, and waits for it to end before the next', async () => {
    const { manager, commands } = mude();
    await manager.run('install');
    const install = commands()[0].child;
    // Only an install is cancelled.
    expect((await manager.run('cancel')).task?.phase).toBe('cancelled');
    expect(install.kill).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const state = await manager.state();
    expect(state.task).toMatchObject({ id: 1, phase: 'cancelled' });
    expect(state.task?.error).toBeUndefined();
    await manager.run('install');
    expect(commands()).toHaveLength(2);

    const other = mude();
    await other.manager.run('uninstall');
    expect((await other.manager.run('cancel')).task?.phase).toBe('running');
    expect(other.commands()[0].child.kill).not.toHaveBeenCalled();
  });

  it('says why the status could not be read, and reads it afresh when asked again', async () => {
    let answer = false;
    const { manager } = mude({
      spawn: (_command, args) => {
        const next = child();
        setImmediate(() => {
          if (answer) next.line({ type: 'status', ...OFF });
          else next.fail(`Unknown judge command: ${args[args.indexOf('mude')]}\n`);
          void next.exit(answer ? 0 : 1);
        });
        return next.process;
      },
    });
    expect(await manager.state()).toEqual({ available: true, problem: 'Unknown judge command: mude' });
    answer = true;
    expect(await manager.state()).toEqual({ available: true, status: OFF });
  });

  it('ends a status that does not answer', async () => {
    const { manager, spawned } = mude({ statusTimeoutMs: 5 }, null);
    const state = await manager.state();
    expect(state.problem).toBe('mu judge mude status did not answer in time');
    expect(spawned[0].child.kill).toHaveBeenCalled();
  });

  it('opens mude’s folder from its status, never one it is handed', async () => {
    const { manager, open } = mude({}, STATUS);
    await expect(manager.run('open')).rejects.toThrow('no folder');
    await manager.state();
    await manager.run('open');
    expect(open).toHaveBeenCalledWith(STATUS.folder);
  });

  it('ends a running command when the app quits', async () => {
    const { manager, commands } = mude();
    await manager.run('install');
    manager.dispose();
    expect(commands()[0].child.kill).toHaveBeenCalled();
  });
});

describe('parseStatus', () => {
  it('keeps the fields the app shows and drops what is not a status', () => {
    expect(parseStatus({ type: 'status', ...STATUS })).toEqual(STATUS);
    expect(parseStatus({ supported: false, installed: false, problems: ['Needs Apple silicon.', 3] })).toEqual({
      supported: false,
      problems: ['Needs Apple silicon.'],
      installed: false,
      pythonReady: false,
      running: false,
      ready: false,
      port: 0,
      enabled: false,
      localOnly: false,
      fallback: [],
      model: '',
      folder: '',
      log: '',
    });
    expect(parseStatus({ type: 'status' })).toBeUndefined();
  });

  it('keeps how much of the model is on disk, an install stopped part way, only when there is some', () => {
    expect(parseStatus({ type: 'status', ...OFF, downloadedBytes: 700_000_000 })).toEqual({
      ...OFF,
      downloadedBytes: 700_000_000,
    });
    expect(parseStatus({ type: 'status', ...OFF, downloadedBytes: 0 })).toEqual(OFF);
    expect(parseStatus({ type: 'status', ...OFF, downloadedBytes: 'lots' })).toEqual(OFF);
  });
});
