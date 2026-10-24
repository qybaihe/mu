import { EventEmitter } from 'node:events';
import { posix } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { DecisionModel } from '@/common/kyrn/mude';
import { DecisionModels, parseModel, type MudeDeps, type MudeProcess } from '@/process/agent/kyrn/mude';
import { isAddedModel, isMude, kindOf } from '@/renderer/pages/settings/KyrnSettings/judgeChoice';

vi.mock('@/process/agent/kyrn/config/systemProxy', () => ({ systemProxyEnv: () => ({}) }));

// The manager is tested as on a Mac, whatever runs the tests: its paths are POSIX ones.
const { join } = posix;
const HOME = '/Users/someone';
const APP = '/Applications/mu.app/Contents/MacOS/mu';
const PACKAGE = { root: '/Applications/mu.app/Contents/Resources/harness/mu-agent', layout: 'package' as const };
const LAUNCHER = join(PACKAGE.root, 'kyrn', 'bin', 'mu.mjs');

const MUDE: DecisionModel = {
  name: 'mude',
  label: 'mude 1.0',
  repo: 'qybaihe/mude-1.0-mlx-8bit',
  revision: '269b71dbc4276770b5a021d7adbad100010473c8',
  bytes: 1_782_006_237,
  builtIn: true,
  installed: true,
  downloadedBytes: 1_782_006_237,
  running: false,
  ready: false,
  enabled: false,
  localOnly: false,
};
const ADDED: DecisionModel = {
  name: 'fast-judge',
  label: 'fast-judge',
  repo: 'owner/fast-judge',
  revision: '0123456789abcdef0123456789abcdef01234567',
  bytes: 900_000_000,
  builtIn: false,
  installed: true,
  downloadedBytes: 900_000_000,
  running: true,
  ready: true,
  enabled: true,
  localOnly: false,
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
    fail: (text: string) => stderr.write(text),
    exit: async (code: number | null) => {
      await new Promise((resolve) => setImmediate(resolve));
      events.emit('close', code);
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

type Spawned = { args: string[]; child: ReturnType<typeof child> };

/** A manager whose `list` answers with `models` at once, and whose other commands wait for the test. */
function manager(models: () => DecisionModel[] = () => [MUDE], patch: Partial<MudeDeps> = {}) {
  const spawned: Spawned[] = [];
  const models_ = new DecisionModels(PACKAGE, {
    platform: 'darwin',
    env: { PATH: '/usr/bin', HOME },
    home: HOME,
    agentDir: `${HOME}/.mu/agent`,
    proxyEnv: () => ({}),
    node: APP,
    electron: true,
    statusTimeoutMs: 1000,
    spawn: (_command, args, _env) => {
      const next = child();
      spawned.push({ args, child: next });
      if (args.includes('list')) {
        setImmediate(() => {
          next.line({ type: 'models', models: models() });
          void next.exit(0);
        });
      }
      return next.process;
    },
    ...patch,
  });
  const commands = () => spawned.filter((entry) => !entry.args.includes('list'));
  return { models: models_, spawned, commands };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('decision models as the app manages them', () => {
  it('lists mude and the added models through `mu judge model list --json`', async () => {
    const { models, spawned } = manager(() => [MUDE, ADDED]);
    expect(await models.state()).toEqual({ available: true, models: [MUDE, ADDED] });
    expect(spawned[0].args).toEqual([LAUNCHER, 'judge', 'model', 'list', '--json']);
  });

  it('adds a model from a link, with its progress and its name, then reads the list again', async () => {
    let listed = [MUDE];
    const { models, commands } = manager(() => listed);
    await models.state();
    const link = 'https://huggingface.co/owner/fast-judge';
    const started = await models.run({ action: 'add', target: ` ${link} `, localOnly: true });
    expect(started.task).toMatchObject({ command: 'add', target: link, phase: 'running' });
    const add = commands()[0];
    expect(add.args).toEqual([LAUNCHER, 'judge', 'model', 'add', link, '--local-only', '--json']);

    add.child.line({ type: 'step', step: 'resolve', message: 'Looking up owner/fast-judge on Hugging Face' });
    add.child.line({ type: 'model', name: 'fast-judge', repo: 'owner/fast-judge', bytes: 900_000_000 });
    add.child.line({ type: 'step', step: 'download', message: 'Downloading fast-judge' });
    add.child.line({
      type: 'progress',
      file: 'weights.safetensors',
      done: 450_000_000,
      total: 900_000_000,
      checking: false,
    });
    await settle();
    const running = await models.state();
    expect(running.task).toMatchObject({
      name: 'fast-judge',
      step: 'download',
      download: { done: 450_000_000, total: 900_000_000 },
    });
    // While it runs, a second request only reads.
    expect((await models.run({ action: 'use', target: 'mude' })).task?.command).toBe('add');
    expect(commands()).toHaveLength(1);

    listed = [MUDE, ADDED];
    await add.child.exit(0);
    await settle();
    const done = await models.state();
    expect(done.task).toMatchObject({ phase: 'done', name: 'fast-judge' });
    expect(done.task?.download).toBeUndefined();
    expect(done.models).toEqual([MUDE, ADDED]);
  });

  it('switches the judge and removes a model by its name', async () => {
    const { models, commands } = manager(() => [MUDE, ADDED]);
    await models.run({ action: 'use', target: 'mude', localOnly: false });
    expect(commands()[0].args).toEqual([LAUNCHER, 'judge', 'model', 'use', 'mude', '--with-fallback', '--json']);
    await commands()[0].child.exit(0);
    await models.run({ action: 'remove', target: 'fast-judge', localOnly: true });
    // remove takes no flags.
    expect(commands()[1].args).toEqual([LAUNCHER, 'judge', 'model', 'remove', 'fast-judge', '--json']);
  });

  it('keeps what a failed add said, and cancels a running one', async () => {
    const { models, commands } = manager();
    await models.run({ action: 'add', target: 'owner/llm' });
    const first = commands()[0];
    first.child.line({
      type: 'error',
      message: "owner/llm isn't packaged as a decision model mu can run: it has no d3_server_mac.py.",
      kind: 'notRunnable',
    });
    await first.child.exit(1);
    await settle();
    expect((await models.state()).task).toMatchObject({
      phase: 'failed',
      error: { message: expect.stringContaining('no d3_server_mac.py'), kind: 'notRunnable' },
    });

    await models.run({ action: 'add', target: 'owner/fast-judge' });
    const second = commands()[1];
    const cancelled = await models.run({ action: 'cancel' });
    expect(cancelled.task?.phase).toBe('cancelled');
    expect(second.child.kill).toHaveBeenCalledOnce();
  });

  it('refuses an empty target or one that reads as an option, and runs nothing off a Mac', async () => {
    const { models, commands } = manager();
    await expect(models.run({ action: 'add', target: '  ' })).rejects.toThrow('Name the model');
    await expect(models.run({ action: 'add', target: '--local-only' })).rejects.toThrow('Name the model');
    expect(commands()).toHaveLength(0);
    const linux = manager(undefined, { platform: 'linux' });
    expect(await linux.models.state()).toEqual({ available: false });
    await expect(linux.models.run({ action: 'add', target: 'owner/model' })).rejects.toThrow('macOS only');
    expect(linux.spawned).toHaveLength(0);
  });

  it('reads a model line, and skips one that is not', () => {
    expect(parseModel({ ...ADDED, extra: 1 })).toEqual(ADDED);
    expect(parseModel({ name: 'x' })).toBeUndefined();
    expect(parseModel({ installed: true })).toBeUndefined();
    expect(parseModel({ name: 'x', installed: false })).toMatchObject({ label: 'x', bytes: 0, builtIn: false });
  });
});

describe('an added model in the judges settings', () => {
  const profile = {
    type: 'typesafe' as const,
    model: 'fast-judge',
    baseUrl: 'http://127.0.0.1:8791/v1/systemone',
    apiKeyEnv: 'MU_JUDGE_FAST_JUDGE_KEY',
    timeoutMs: 4000,
  };

  it('is the decision model on this Mac, like mude, and nothing else is', () => {
    expect(isAddedModel(profile)).toBe(true);
    expect(isMude(profile)).toBe(false);
    expect(kindOf(profile)).toBe('mude');
    expect(kindOf({ ...profile, apiKeyEnv: 'MU_JUDGE_MUDE_KEY', baseUrl: 'http://127.0.0.1:8790/v1/systemone' })).toBe(
      'mude'
    );
    // Jev at an address of one's own, even on this Mac, stays Jev.
    expect(isAddedModel({ ...profile, apiKeyEnv: 'MU_JUDGE_CUSTOM_API_KEY' })).toBe(false);
    expect(kindOf({ ...profile, apiKeyEnv: 'TYPESAFE_API_KEY' })).toBe('jev');
    expect(isAddedModel({ ...profile, baseUrl: 'https://api.example.com/v1/systemone' })).toBe(false);
  });
});
