import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PiRecord } from '../../../../../packages/desktop/src/common/utils/nativeHost/records.ts';
import {
  NativeHost,
  NativeHostError,
  type HostLaunch,
  type NativeHostOptions,
  type NativeHostState,
} from '../../../../../packages/desktop/src/process/services/nativeHost/NativeHost.ts';
import { readFromHost, readToHost } from '../../../../../packages/desktop/src/process/services/nativeHost/protocol.ts';
import { FakeChild, settle } from './fakeChild.ts';

/**
 * The host manager against a host process the test plays (FakeChild): commands and their responses, the order of
 * records, dialogs, deadlines, and every way a host ends. The real host is in tests/integration/nativeHost.test.ts.
 */

/** A model pi can answer with, as `get_state` names it. */
const MODEL = { provider: 'e2e', id: 'e2e-fake-model' };

const LAUNCH: HostLaunch = {
  module: '/mu/packages/coding-agent/src/index.ts',
  args: ['-e', '/mu/packages/kyrn-judge/src/extension/kyrn-judge.ts', '--mode', 'rpc'],
  execArgv: ['--import', '/mu/source-resolver.ts'],
  env: { HOME: '/home/someone' },
  cwd: '/project',
};

function setup(options: Partial<NativeHostOptions> = {}) {
  const child = new FakeChild();
  const logs: string[] = [];
  const host = new NativeHost({ launch: LAUNCH, fork: () => child, log: (line) => logs.push(line), ...options });
  const records: PiRecord[] = [];
  host.subscribe((record) => records.push(record));
  const phases: string[] = [];
  host.onState((state) => phases.push(state.phase));
  return { child, host, records, logs, phases };
}

/** The host's next state of `phase`. */
const reaches = (host: NativeHost, phase: NativeHostState['phase']): Promise<NativeHostState> =>
  new Promise((resolve) => {
    if (host.state.phase === phase) resolve(host.state);
    const stop = host.onState((state) => {
      if (state.phase !== phase) return;
      stop();
      resolve(state);
    });
  });

/** pi answers the `get_state` the manager asks as it starts (always `h1`). */
const answerProbe = (child: FakeChild, model: unknown = MODEL): void =>
  child.write({ type: 'response', id: 'h1', command: 'get_state', success: true, data: { model } });

/** A host whose pi runs with a model. The next command's id is `h2`. */
function running(options: Partial<NativeHostOptions> = {}) {
  const context = setup(options);
  context.host.start();
  answerProbe(context.child);
  return context;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('NativeHost', () => {
  it('starts the host with pi’s module and arguments, and sends each command with an id', async () => {
    const { child, host, phases } = setup();
    host.start();
    expect(child.posted[0]).toEqual({
      type: 'init',
      module: LAUNCH.module,
      args: LAUNCH.args,
      execArgv: LAUNCH.execArgv,
    });
    // The manager's own question: what pi runs with.
    expect(child.commands()).toEqual([{ type: 'get_state', id: 'h1' }]);
    expect(host.state).toEqual({ phase: 'starting' });
    expect(host.pid).toBe(4242);

    const state = host.request({ type: 'get_state' });
    expect(child.commands()[1]).toEqual({ type: 'get_state', id: 'h2' });
    child.write({ type: 'extension_ui_request', id: 'u1', method: 'setStatus', statusKey: 'mu', statusText: 'on' });
    expect(host.state).toEqual({ phase: 'starting' });
    answerProbe(child);
    expect(host.state).toEqual({ phase: 'running' });
    child.write({
      type: 'response',
      id: 'h2',
      command: 'get_state',
      success: true,
      data: { sessionId: 's1', model: MODEL },
    });
    await expect(state).resolves.toEqual({ sessionId: 's1', model: MODEL });
    expect(phases).toEqual(['starting', 'running']);
  });

  it('says when pi runs without a model, takes commands all the same, and runs once it has one', async () => {
    const { child, host, phases } = setup();
    host.start();
    answerProbe(child, { provider: 'unknown', id: 'unknown' });
    expect(host.state).toEqual({ phase: 'needs-model' });
    const models = host.request({ type: 'get_available_models' });
    child.write({ type: 'response', id: 'h2', command: 'get_available_models', success: true, data: { models: [] } });
    await expect(models).resolves.toEqual({ models: [] });
    const cycled = host.request({ type: 'cycle_model' });
    child.write({ type: 'response', id: 'h3', command: 'cycle_model', success: true, data: null });
    await expect(cycled).resolves.toBeNull();
    expect(host.state).toEqual({ phase: 'needs-model' });
    const chosen = host.request({ type: 'set_model', provider: 'e2e', modelId: 'e2e-fake-model' });
    child.write({ type: 'response', id: 'h4', command: 'set_model', success: true, data: MODEL });
    await chosen;
    expect(host.state).toEqual({ phase: 'running' });
    expect(phases).toEqual(['starting', 'needs-model', 'running']);
  });

  it('pairs each response with its command, in whatever order they come', async () => {
    const { child, host, records } = running();
    const messages = host.request({ type: 'get_messages' });
    const commands = host.request({ type: 'get_commands' });
    child.write({ type: 'response', id: 'h9', command: 'get_last_assistant_text', success: true, data: {} });
    child.write({ type: 'response', id: 'h3', command: 'get_commands', success: true, data: { commands: [] } });
    child.write({ type: 'response', id: 'h2', command: 'get_messages', success: true, data: { messages: [] } });
    await expect(messages).resolves.toEqual({ messages: [] });
    await expect(commands).resolves.toEqual({ commands: [] });
    // A response no command waits for still reaches the subscribers.
    expect(records.filter((record) => record.type === 'response').map((record) => record.id)).toEqual([
      'h1',
      'h9',
      'h3',
      'h2',
    ]);
  });

  it('rejects a command pi refused, in pi’s words', async () => {
    const { child, host } = running();
    const refused = host.request({ type: 'set_model', provider: 'x', modelId: 'y' });
    child.write({ type: 'response', id: 'h2', command: 'set_model', success: false, error: 'Model not found: x/y' });
    await expect(refused).rejects.toMatchObject({
      name: 'NativeHostError',
      kind: 'command',
      message: 'Model not found: x/y',
    });
  });

  it('hands every record to the subscribers in the order it came, its dialog answers included', () => {
    const { child, host, records } = setup();
    host.start();
    const late: PiRecord[] = [];
    const stop = host.subscribe((record) => late.push(record));
    child.write({ type: 'agent_start' });
    child.write({ type: 'extension_ui_request', id: 'd1', method: 'select', title: 'Allow?', options: ['Yes', 'No'] });
    host.respondToDialog('d1', { value: 'Yes' });
    stop();
    child.write({ type: 'agent_settled' });
    expect(records.map((record) => record.type)).toEqual([
      'agent_start',
      'extension_ui_request',
      'extension_ui_response',
      'agent_settled',
    ]);
    expect(records[2]).toEqual({ type: 'extension_ui_response', id: 'd1', value: 'Yes' });
    expect(child.commands().at(-1)).toEqual({ type: 'extension_ui_response', id: 'd1', value: 'Yes' });
    expect(late).toHaveLength(3);
  });

  it('keeps handing records on when a subscriber throws', () => {
    const { child, host, records, logs } = setup();
    host.subscribe(() => {
      throw new Error('broken view');
    });
    host.start();
    child.write({ type: 'agent_start' });
    expect(records).toHaveLength(1);
    expect(logs).toEqual(['a native host listener failed on a agent_start record: Error: broken view']);
  });

  it('ignores messages that are not pi’s records', () => {
    const { child, host, records } = setup();
    host.start();
    for (const message of [
      'text',
      null,
      { type: 'out', json: '{not json' },
      { type: 'out', json: '[1]' },
      { type: 'out', json: '{"no":"type"}' },
      { type: 'what' },
    ])
      child.emit('message', message);
    expect(records).toEqual([]);
    expect(host.state).toEqual({ phase: 'starting' });
  });

  it('notes when it forked the host, when pi was imported and when pi first wrote', () => {
    let clock = 0;
    const { child, host } = setup({ now: () => clock });
    clock = 10;
    host.start();
    clock = 25;
    child.emit('message', { type: 'ready', importMs: 12 });
    clock = 40;
    child.write({ type: 'agent_settled' });
    clock = 45;
    answerProbe(child);
    clock = 50;
    child.write({ type: 'agent_start' });
    child.write({ type: 'response', id: 'h9', command: 'get_state', success: true, data: { model: MODEL } });
    expect(host.timings).toEqual({ forked: 10, imported: 25, importMs: 12, firstRecord: 40, firstState: 45 });
  });

  it('gives a command the start deadline until pi writes, then the command deadline from then', async () => {
    vi.useFakeTimers();
    const { child, host } = setup({ deadlines: { command: 100, start: 1000 } });
    host.start();
    let outcome: unknown;
    host.request({ type: 'get_state' }).then(
      () => (outcome = 'answered'),
      (error: unknown) => (outcome = error)
    );
    await vi.advanceTimersByTimeAsync(900);
    expect(outcome).toBeUndefined();
    child.write({ type: 'agent_settled' });
    await vi.advanceTimersByTimeAsync(99);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(NativeHostError);
    expect(outcome).toMatchObject({ kind: 'timeout', message: 'mu did not answer get_state in 100 ms' });
  });

  it('never gives up on a turn, and keeps a deadline the caller chose', async () => {
    vi.useFakeTimers();
    const { child, host } = setup({ deadlines: { command: 100, start: 1000 } });
    host.start();
    let prompt: unknown;
    host.request({ type: 'prompt', message: 'hi' }).then(
      () => (prompt = 'answered'),
      (error: unknown) => (prompt = error)
    );
    let chosen: unknown;
    host.request({ type: 'get_entries' }, { timeoutMs: 500 }).then(
      () => (chosen = 'answered'),
      (error: unknown) => (chosen = error)
    );
    child.write({ type: 'agent_start' });
    await vi.advanceTimersByTimeAsync(499);
    expect(chosen).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(chosen).toMatchObject({ kind: 'timeout', message: 'mu did not answer get_entries in 500 ms' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(prompt).toBeUndefined();
    child.write({ type: 'response', id: 'h2', command: 'prompt', success: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(prompt).toBe('answered');
  });

  it('says a host that stopped by itself crashed, with the end of its output, and rejects what waits', async () => {
    const { child, host } = running();
    const waiting = host.request({ type: 'get_state' });
    child.stdout.write('some output\n');
    child.stderr.write('\u001b[31mError: out of memory\u001b[39m\n');
    child.exit(134);
    const error = (await waiting.catch((reason: unknown) => reason)) as NativeHostError;
    expect(error).toBeInstanceOf(NativeHostError);
    expect(error).toMatchObject({
      kind: 'crashed',
      code: 134,
      message: 'The mu host stopped by itself (exit code 134)',
      stderr: 'some output\nError: out of memory',
    });
    expect(host.state).toEqual({ phase: 'failed', error });
    await expect(host.request({ type: 'get_state' })).rejects.toBe(error);
    expect(() => host.respondToDialog('d1', { cancelled: true })).toThrow(error);
  });

  it('waits briefly for what a crashed host writes after its exit', async () => {
    vi.useFakeTimers();
    const late = running();
    late.child.emit('exit', 1);
    late.child.stderr.write('Error: the last words\n');
    late.child.stdout.end();
    late.child.stderr.end();
    const lateState = (await reaches(late.host, 'failed')) as { error: NativeHostError };
    expect(lateState.error.stderr).toBe('Error: the last words');

    // Output streams that never end hold the error back for half a second, no longer.
    const silent = running();
    silent.child.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(499);
    expect(silent.host.state.phase).toBe('running');
    await vi.advanceTimersByTimeAsync(1);
    expect(silent.host.state).toMatchObject({ phase: 'failed', error: { kind: 'crashed', code: 1 } });
  });

  it('does not wait for the output of a host it disposed', async () => {
    vi.useFakeTimers();
    const { child, host } = running();
    let done = false;
    const disposed = host.dispose().then(() => {
      done = true;
    });
    // An Electron utility process reports its exit before its output streams end.
    child.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    await disposed;
    expect(host.state).toEqual({ phase: 'stopped' });
  });

  it('keeps only the end of a long output', async () => {
    const { child, host } = running();
    child.stderr.write(`${'x'.repeat(20_000)}\nthe last line\n`);
    child.exit(1);
    const state = await reaches(host, 'failed');
    const error = (state as { error: NativeHostError }).error;
    expect(error.stderr.length).toBeLessThanOrEqual(8 * 1024);
    expect(error.stderr.endsWith('the last line')).toBe(true);
  });

  it('tells a pi that stopped because no model is set up from one that failed', async () => {
    const { child, host } = setup();
    host.start();
    const waiting = host.request({ type: 'get_state' });
    child.stderr.write(
      '\u001b[31mNo models available. Use /login to log into a provider via OAuth or API key. See:\n  /mu/docs/providers.md\u001b[39m\n'
    );
    child.exit(1);
    const state = await reaches(host, 'failed');
    expect(state).toMatchObject({
      phase: 'failed',
      error: {
        kind: 'no-models',
        code: 1,
        message: 'No models available. Use /login to log into a provider via OAuth or API key. See:',
      },
    });
    await expect(waiting).rejects.toMatchObject({ kind: 'no-models' });
  });

  it('says a host that stopped after pi wrote crashed, even before pi said what it runs with', async () => {
    const { child, host } = setup();
    host.start();
    child.write({ type: 'extension_ui_request', id: 'u1', method: 'setStatus', statusKey: 'mu', statusText: 'on' });
    child.stderr.write('No models available, said something else\n');
    child.exit(1);
    const state = await reaches(host, 'failed');
    expect(state).toMatchObject({ error: { kind: 'crashed', message: 'The mu host stopped by itself (exit code 1)' } });
  });

  it('says why a host could not load pi', async () => {
    const { child, host } = setup();
    host.start();
    child.emit('message', { type: 'failed', stage: 'import', message: "Cannot find module '/mu/index.ts'" });
    child.exit(1);
    const state = await reaches(host, 'failed');
    expect(state).toMatchObject({
      error: { kind: 'failed', code: 1, message: "The mu host could not load pi: Cannot find module '/mu/index.ts'" },
    });
  });

  it('says a host stopped before pi started when it says nothing else', async () => {
    const { child, host } = setup();
    host.start();
    child.stderr.write('SyntaxError: Unexpected token\n');
    child.exit(1);
    const state = await reaches(host, 'failed');
    expect(state).toMatchObject({
      error: { kind: 'failed', message: 'The mu host stopped before pi started (exit code 1)' },
    });
    expect((state as { error: NativeHostError }).error.stderr).toBe('SyntaxError: Unexpected token');
  });

  it('fails at once when the process cannot be started', async () => {
    const host = new NativeHost({
      launch: LAUNCH,
      fork: () => {
        throw new Error('spawn ENOENT');
      },
    });
    host.start();
    expect(host.state).toMatchObject({
      phase: 'failed',
      error: { kind: 'failed', message: 'The mu host did not start: spawn ENOENT' },
    });
    await expect(host.request({ type: 'get_state' })).rejects.toMatchObject({ kind: 'failed' });
  });

  it('ends pi’s input to dispose of it, and waits for the host to exit', async () => {
    const { child, host } = running();
    const turn = host.request({ type: 'prompt', message: 'hi' });
    const disposed = host.dispose();
    expect(host.dispose()).toBe(disposed);
    expect(child.posted.at(-1)).toEqual({ type: 'end' });
    await expect(host.request({ type: 'get_state' })).rejects.toMatchObject({ kind: 'closed' });
    child.exit(0);
    await disposed;
    expect(host.state).toEqual({ phase: 'stopped' });
    expect(child.kills).toBe(0);
    await expect(turn).rejects.toMatchObject({ kind: 'closed', message: 'The mu host was closed' });
  });

  it('kills a host that does not exit in time', async () => {
    vi.useFakeTimers();
    const { child, host } = running();
    const disposed = host.dispose(100);
    await vi.advanceTimersByTimeAsync(99);
    expect(child.kills).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kills).toBe(1);
    child.exit(null);
    await vi.advanceTimersByTimeAsync(1000);
    await disposed;
    expect(host.state).toEqual({ phase: 'stopped' });
  });

  it('stops waiting for a killed host that never says it exited', async () => {
    vi.useFakeTimers();
    const { child, host } = running();
    const disposed = host.dispose(100);
    await vi.advanceTimersByTimeAsync(1100);
    await disposed;
    expect(child.kills).toBe(1);
    expect(host.state).toEqual({ phase: 'stopped' });
  });

  it('passes pi’s log lines on, whole, and nothing else', async () => {
    const { child, logs } = running();
    child.stderr.write('[mu] judge: mo');
    child.stderr.write('ck, shadow\nnot for the log\r\n[mu] second\n');
    child.stdout.write('[mu] stdout is not the log\n');
    await settle();
    expect(logs).toEqual(['judge: mock, shadow', 'second']);
  });

  it('starts once, and needs a start before a command', async () => {
    const { host } = setup();
    await expect(host.request({ type: 'get_state' })).rejects.toMatchObject({
      kind: 'closed',
      message: 'The mu host has not been started',
    });
    host.start();
    expect(() => host.start()).toThrow('This host was started already');
    expect(() => host.respondToDialog('', { cancelled: true })).toThrow('A dialog answer needs the id of the dialog');
  });

  it('stops a host that never started without waiting for anything', async () => {
    const { host, child } = setup();
    await host.dispose();
    expect(host.state).toEqual({ phase: 'stopped' });
    expect(child.posted).toEqual([]);
  });
});

describe('the envelope', () => {
  it('reads what the main process sends', () => {
    expect(
      readToHost({ type: 'init', module: '/pi.js', args: ['--mode', 'rpc'], execArgv: ['--import', '/r.ts'] })
    ).toEqual({
      type: 'init',
      module: '/pi.js',
      args: ['--mode', 'rpc'],
      execArgv: ['--import', '/r.ts'],
    });
    expect(readToHost({ type: 'init', module: '/pi.js', args: [] })).toEqual({
      type: 'init',
      module: '/pi.js',
      args: [],
      execArgv: [],
    });
    expect(readToHost({ type: 'in', json: '{}' })).toEqual({ type: 'in', json: '{}' });
    expect(readToHost({ type: 'end', extra: 1 })).toEqual({ type: 'end' });
    for (const odd of [
      null,
      [],
      'end',
      { type: 'init', module: '/pi.js', args: [1] },
      { type: 'init', module: '/pi.js', args: [], execArgv: '--import /r.ts' },
      { type: 'init', args: [] },
      { type: 'in', json: {} },
    ])
      expect(readToHost(odd)).toBeUndefined();
  });

  it('reads what the host sends', () => {
    expect(readFromHost({ type: 'out', json: '{}' })).toEqual({ type: 'out', json: '{}' });
    expect(readFromHost({ type: 'ready' })).toEqual({ type: 'ready', importMs: 0 });
    expect(readFromHost({ type: 'failed', stage: 'main', message: 'boom' })).toEqual({
      type: 'failed',
      stage: 'main',
      message: 'boom',
    });
    for (const odd of [undefined, { type: 'failed', stage: 'later', message: 'x' }, { type: 'out', json: 1 }])
      expect(readFromHost(odd)).toBeUndefined();
  });
});
