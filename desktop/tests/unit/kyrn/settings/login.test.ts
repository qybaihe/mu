import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { offeredProviders, type SwitchedModel } from '../../../../packages/desktop/src/common/kyrn/login';
import type { AvailableModels, ModelDefaults } from '../../../../packages/desktop/src/common/kyrn/models';
import { leaveProvider } from '../../../../packages/desktop/src/process/agent/kyrn/config/signOut';
import {
  LoginManager,
  openable,
  spawnAuth,
  type RunnerProcess,
} from '../../../../packages/desktop/src/process/agent/kyrn/login';

/** A runner that says what a test tells it to and records what it is sent. No process, no pi, no network. */
class FakeRunner extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stdin = new PassThrough();
  readonly sent: Record<string, unknown>[] = [];
  killed = false;

  constructor(readonly args: string[]) {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) this.sent.push(JSON.parse(line) as Record<string, unknown>);
    });
  }

  say(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  end(code: number): void {
    this.stdout.end();
    this.emit('close', code);
  }

  kill(): void {
    this.killed = true;
  }
}

function setup() {
  const runners: FakeRunner[] = [];
  const opened: string[] = [];
  const manager = new LoginManager(
    (args) => {
      const runner = new FakeRunner(args);
      runners.push(runner);
      return runner as unknown as RunnerProcess;
    },
    (url) => opened.push(url)
  );
  return { manager, runners, opened };
}

/** Whether a process is still running. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Lines are read asynchronously, as from a real child. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

afterEach(() => {
  vi.useRealTimers();
});

describe('signing in to a subscription', () => {
  it('opens only the provider page, passes the typed code on, and ends with the account’s models', async () => {
    const { manager, runners, opened } = setup();
    expect(manager.start('anthropic')).toMatchObject({ id: 1, provider: 'anthropic', phase: 'running' });
    const runner = runners[0];
    expect(runner.args).toEqual(['login', 'anthropic']);

    runner.say({ type: 'event', event: { type: 'auth_url', url: 'https://claude.ai/oauth/authorize?state=s' } });
    runner.say({ type: 'event', event: { type: 'auth_url', url: 'file:///etc/hosts' } });
    runner.say({ type: 'prompt', prompt: { type: 'manual_code', message: 'Paste the code' } });
    await settle();
    expect(opened).toEqual(['https://claude.ai/oauth/authorize?state=s']);
    expect(manager.state()).toMatchObject({
      url: 'https://claude.ai/oauth/authorize?state=s',
      prompt: { type: 'manual_code', message: 'Paste the code' },
    });

    manager.answer(1, 'the-code');
    await settle();
    expect(runner.sent).toEqual([{ type: 'answer', value: 'the-code' }]);
    expect(manager.state().prompt).toBeUndefined();

    runner.say({
      type: 'done',
      provider: 'anthropic',
      models: [{ id: 'claude-opus-4-8', name: 'Claude Opus 4.8' }, { id: 'claude-fable-5' }, { name: 'no id' }],
    });
    runner.end(0);
    await settle();
    expect(manager.state()).toMatchObject({
      phase: 'done',
      models: [
        { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
        { id: 'claude-fable-5', name: 'claude-fable-5' },
      ],
    });
  });

  it('keeps the flow’s own error, even when the runner ends right after it', async () => {
    const { manager, runners } = setup();
    manager.start('openai-codex');
    runners[0].say({ type: 'error', message: 'Token exchange request failed' });
    runners[0].end(1);
    await settle();
    expect(manager.state()).toMatchObject({ phase: 'failed', error: 'Token exchange request failed' });

    manager.start('openai-codex');
    runners[1].end(1);
    await settle();
    expect(manager.state()).toMatchObject({ id: 2, phase: 'failed', error: 'The sign-in stopped' });
  });

  it('cancels: the runner is told, then ended, and what it says afterwards changes nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { manager, runners } = setup();
    manager.start('anthropic');
    expect(manager.cancel()).toMatchObject({ phase: 'cancelled' });
    await vi.advanceTimersByTimeAsync(5);
    expect(runners[0].sent).toEqual([{ type: 'cancel' }]);
    expect(runners[0].killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(runners[0].killed).toBe(true);

    runners[0].say({ type: 'error', message: 'cancelled' });
    runners[0].end(1);
    await vi.advanceTimersByTimeAsync(5);
    expect(manager.state()).toMatchObject({ phase: 'cancelled' });
    expect(manager.state().error).toBeUndefined();
  });

  it('ends the older sign-in when another starts, and drops what belongs to the older one', async () => {
    const { manager, runners } = setup();
    manager.start('anthropic');
    manager.start('openai-codex');
    await settle();
    expect(runners[0].sent).toEqual([{ type: 'cancel' }]);

    runners[0].say({ type: 'done', provider: 'anthropic', models: [{ id: 'old' }] });
    runners[0].end(0);
    await settle();
    runners[1].say({ type: 'prompt', prompt: { type: 'manual_code', message: 'code' } });
    await settle();
    expect(manager.state()).toMatchObject({ id: 2, provider: 'openai-codex', phase: 'running' });

    manager.answer(1, 'for the old one');
    await settle();
    expect(runners[1].sent).toEqual([]);
    expect(manager.state().prompt).toBeDefined();
  });

  it('shows a device code, opens its page, and keeps the page to open again', async () => {
    const { manager, runners, opened } = setup();
    manager.start('xai');
    expect(runners[0].args).toEqual(['login', 'xai']);
    runners[0].say({
      type: 'event',
      event: {
        type: 'device_code',
        userCode: 'WDJB-MJHT',
        verificationUri: 'https://accounts.x.ai/device?code=WDJB-MJHT',
      },
    });
    await settle();
    expect(opened).toEqual(['https://accounts.x.ai/device?code=WDJB-MJHT']);
    expect(manager.state()).toMatchObject({
      device: { userCode: 'WDJB-MJHT', verificationUri: 'https://accounts.x.ai/device?code=WDJB-MJHT' },
      url: 'https://accounts.x.ai/device?code=WDJB-MJHT',
    });

    manager.start('xai');
    runners[0].end(1);
    await settle();
    runners[1].say({
      type: 'event',
      event: { type: 'device_code', userCode: 'X', verificationUri: 'file:///etc/hosts' },
    });
    await settle();
    expect(opened).toHaveLength(1);
    expect(manager.state()).toMatchObject({ device: { userCode: 'X', verificationUri: '' } });
    expect(manager.state().url).toBeUndefined();
  });

  it('asks the Google risk question as the flow puts it, and a no to it is a cancel, not a failure', async () => {
    const { manager, runners, opened } = setup();
    manager.start('google-gemini-cli');
    runners[0].say({
      type: 'prompt',
      prompt: {
        type: 'select',
        message: 'Experimental: this signs in through Gemini CLI’s own login…',
        options: [
          { id: 'continue', label: 'I understand the risk, sign in' },
          { id: 'cancel', label: 'Cancel' },
        ],
      },
    });
    await settle();
    expect(manager.state().prompt).toMatchObject({ type: 'select', options: [{ id: 'continue' }, { id: 'cancel' }] });
    expect(opened).toEqual([]);

    manager.answer(1, 'cancel');
    runners[0].say({ type: 'error', message: 'Login cancelled' });
    runners[0].end(1);
    await settle();
    expect(runners[0].sent).toEqual([{ type: 'answer', value: 'cancel' }]);
    expect(manager.state()).toMatchObject({ phase: 'cancelled' });
    expect(manager.state().error).toBeUndefined();
  });

  it('knows the account is signed in once the credential is stored, before its models are read', async () => {
    const { manager, runners } = setup();
    manager.start('google-antigravity');
    runners[0].say({ type: 'prompt', prompt: { type: 'manual_code', message: 'paste' } });
    runners[0].say({ type: 'signed_in' });
    await settle();
    expect(manager.state()).toMatchObject({ phase: 'running', stored: true });
    expect(manager.state().prompt).toBeUndefined();
  });

  it('stops a sign-in nobody finishes, after a quarter of an hour, but not one already signed in', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { manager, runners } = setup();
    manager.start('google-gemini-cli');
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
    expect(manager.state().phase).toBe('running');
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.state()).toMatchObject({ phase: 'failed', error: 'The sign-in waited too long and was stopped' });
    expect(runners[0].sent).toEqual([{ type: 'cancel' }]);
    runners[0].end(1);
    await vi.advanceTimersByTimeAsync(0);

    manager.start('google-antigravity');
    runners[1].say({ type: 'signed_in' });
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(manager.state()).toMatchObject({ phase: 'running', stored: true });
  });

  it('refuses a provider it does not offer', () => {
    const { manager, runners } = setup();
    expect(() => manager.start('google' as never)).toThrow('Unknown provider');
    expect(runners).toEqual([]);
  });
});

// QA, 2026-10-23: Sign in with ChatGPT failed with "Port 1455 is in use, probably by an unfinished login in another pi
// session or by the Codex CLI". The app started the next runner at once, while the one before could still be listening
// on the callback port.
describe('the callback port between sign-ins', () => {
  it('starts the next runner only once the one before has ended', async () => {
    const { manager, runners } = setup();
    manager.start('openai');
    expect(manager.start('openai')).toMatchObject({ id: 2, phase: 'running' });
    await settle();
    expect(runners).toHaveLength(1);
    expect(runners[0].sent).toEqual([{ type: 'cancel' }]);

    runners[0].end(1);
    await settle();
    expect(runners.map((runner) => runner.args)).toEqual([
      ['login', 'openai'],
      ['login', 'openai'],
    ]);
    runners[1].say({ type: 'event', event: { type: 'auth_url', url: 'https://auth.openai.com/authorize?state=2' } });
    await settle();
    expect(manager.state()).toMatchObject({
      id: 2,
      phase: 'running',
      url: 'https://auth.openai.com/authorize?state=2',
    });
  });

  it('ends a runner that does not stop, and starts the next one 3 s after at the latest', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { manager, runners } = setup();
    manager.start('openai');
    manager.start('openai');
    await vi.advanceTimersByTimeAsync(1500);
    expect(runners[0].killed).toBe(true);
    expect(runners).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(runners).toHaveLength(2);
  });

  it('never starts a sign-in cancelled while the one before was ending', async () => {
    const { manager, runners } = setup();
    manager.start('openai');
    manager.start('openai');
    expect(manager.cancel()).toMatchObject({ id: 2, phase: 'cancelled' });
    runners[0].end(1);
    await settle();
    expect(runners).toHaveLength(1);
  });

  it('passes on why a sign-in failed, and which program keeps the port', async () => {
    const { manager, runners } = setup();
    manager.start('openai');
    runners[0].say({
      type: 'error',
      message: 'Port 1455 is in use by codex (process 4321), probably for its own sign-in',
      code: 'port_in_use',
      port: 1455,
      holder: { pid: 4321, command: 'codex', cwd: '/private' },
    });
    runners[0].end(1);
    await settle();
    expect(manager.state()).toEqual({
      id: 1,
      provider: 'openai',
      phase: 'failed',
      prompt: undefined,
      error: 'Port 1455 is in use by codex (process 4321), probably for its own sign-in',
      code: 'port_in_use',
      port: 1455,
      holder: { pid: 4321, command: 'codex' },
    });

    // A code the app does not know is no code at all.
    manager.start('openai');
    runners[1].say({ type: 'error', message: 'read ECONNRESET', code: 'ECONNRESET' });
    await settle();
    expect(manager.state()).toMatchObject({ id: 2, phase: 'failed', error: 'read ECONNRESET' });
    expect(manager.state().code).toBeUndefined();
  });

  it('signs in by the pasted address alone when asked to', () => {
    const { manager, runners } = setup();
    expect(manager.start('openai', { paste: true })).toMatchObject({
      provider: 'openai',
      phase: 'running',
      paste: true,
    });
    expect(runners[0].args).toEqual(['login', 'openai', '--paste']);
    runners[0].end(1);
  });

  it('ends a sign-in under way before signing out, and signs in again after the sign-out', async () => {
    const { manager, runners } = setup();
    manager.start('openai');
    const left = manager.logout('openai');
    expect(manager.state()).toMatchObject({ id: 1, phase: 'cancelled' });
    await settle();
    expect(runners[0].sent).toEqual([{ type: 'cancel' }]);
    // The sign-out waits for the sign-in's runner: it keeps the port, and writes the store the sign-out changes.
    expect(runners).toHaveLength(1);
    runners[0].end(1);
    await settle();
    expect(runners[1].args).toEqual(['logout', 'openai']);
    runners[1].say({ type: 'status', signedIn: [] });
    runners[1].end(0);
    await expect(left).resolves.toEqual({ signedIn: [] });

    expect(manager.start('openai')).toMatchObject({ id: 2, phase: 'running' });
    expect(runners[2].args).toEqual(['login', 'openai']);
  });

  it('ends a runner still stopping when the app quits, and starts no other', async () => {
    const { manager, runners } = setup();
    manager.start('openai');
    manager.start('openai');
    manager.dispose();
    expect(runners[0].killed).toBe(true);
    await settle();
    expect(runners).toHaveLength(1);
  });
});

describe('who is signed in', () => {
  it('offers ChatGPT and Grok, and shows a Codex or Claude sign-in only while an account is signed in with it', () => {
    const offered = ['openai', 'xai'] as const;
    expect(offeredProviders({ signedIn: [], offered: [...offered] })).toEqual(['openai', 'xai']);
    const before = [
      { provider: 'openai-codex' as const, models: [] },
      { provider: 'anthropic' as const, models: [] },
    ];
    expect(offeredProviders({ signedIn: before, offered: [...offered] })).toEqual([
      'openai',
      'openai-codex',
      'anthropic',
      'xai',
    ]);
    // Before the runner has said: pi's own sign-ins.
    expect(offeredProviders({ signedIn: [] })).toEqual(['openai', 'xai']);
  });

  it('reads the accounts and the sign-ins the runner reports, and only the ones the app knows', async () => {
    const { manager, runners } = setup();
    const status = manager.status();
    expect(runners[0].args).toEqual(['status']);
    runners[0].say({
      type: 'status',
      offered: ['openai-codex', 'anthropic', 'xai', 'google-antigravity', 'github-copilot'],
      signedIn: [
        { provider: 'anthropic', models: [{ id: 'claude-opus-4-8', name: 'Claude Opus 4.8' }] },
        { provider: 'google-antigravity', models: [{ id: 'gemini-3-flash' }] },
        { provider: 'github-copilot', models: [{ id: 'g' }] },
      ],
    });
    runners[0].end(0);
    await expect(status).resolves.toEqual({
      offered: ['openai-codex', 'anthropic', 'xai', 'google-antigravity'],
      signedIn: [
        { provider: 'anthropic', models: [{ id: 'claude-opus-4-8', name: 'Claude Opus 4.8' }] },
        { provider: 'google-antigravity', models: [{ id: 'gemini-3-flash', name: 'gemini-3-flash' }] },
      ],
    });
  });

  it('leaves out what is offered when an older runner does not say', async () => {
    const { manager, runners } = setup();
    const status = manager.status();
    runners[0].say({ type: 'status', signedIn: [] });
    runners[0].end(0);
    await expect(status).resolves.toEqual({ signedIn: [] });
  });

  it('is nobody when the runner cannot start, ends without a word, or does not answer in time', async () => {
    const failing = new LoginManager(
      () => {
        throw new Error('no node');
      },
      () => undefined
    );
    await expect(failing.status()).resolves.toEqual({ signedIn: [] });

    const { manager, runners } = setup();
    const quiet = manager.status();
    runners[0].end(1);
    await expect(quiet).resolves.toEqual({ signedIn: [] });

    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const slow = manager.status(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(slow).resolves.toEqual({ signedIn: [] });
    expect(runners[1].killed).toBe(true);
  });
});

describe('one runner at a time', () => {
  // Two `mu auth status` runners 0.7 s apart at the app's start: the first exited holding mu's model store lock, and
  // the second (and the first conversation after it) waited half a minute for it.
  it('gives a look asked for while one runs that one’s answer, and starts a new runner only after it', async () => {
    const { manager, runners } = setup();
    const first = manager.status();
    const second = manager.status();
    expect(second).toBe(first);
    expect(runners).toHaveLength(1);
    runners[0].say({ type: 'status', signedIn: [{ provider: 'anthropic', models: [] }] });
    runners[0].end(0);
    await expect(second).resolves.toEqual({ signedIn: [{ provider: 'anthropic', models: [] }] });
    await settle();
    const later = manager.status();
    expect(later).not.toBe(first);
    expect(runners).toHaveLength(2);
    runners[1].say({ type: 'status', signedIn: [] });
    runners[1].end(0);
    await expect(later).resolves.toEqual({ signedIn: [] });
  });

  it('starts a sign-out once the look under way has ended, and a look asked for then after the sign-out', async () => {
    const { manager, runners } = setup();
    const look = manager.status();
    const left = manager.logout('anthropic');
    await settle();
    expect(runners.map((runner) => runner.args)).toEqual([['status']]);
    runners[0].say({ type: 'status', signedIn: [{ provider: 'anthropic', models: [] }] });
    runners[0].end(0);
    await look;
    await settle();
    expect(runners.map((runner) => runner.args)).toEqual([['status'], ['logout', 'anthropic']]);
    const after = manager.status();
    await settle();
    expect(runners).toHaveLength(2);
    runners[1].say({ type: 'status', signedIn: [] });
    runners[1].end(0);
    await expect(left).resolves.toEqual({ signedIn: [] });
    await settle();
    expect(runners[2].args).toEqual(['status']);
    runners[2].say({ type: 'status', signedIn: [] });
    runners[2].end(0);
    await expect(after).resolves.toEqual({ signedIn: [] });
  });

  it('goes on after a runner that failed', async () => {
    const { manager, runners } = setup();
    const failed = manager.logout('openai-codex');
    const look = manager.status();
    runners[0].say({ type: 'error', message: 'Credential store delete failed for openai-codex' });
    runners[0].end(1);
    await expect(failed).rejects.toThrow('Credential store delete failed');
    await settle();
    runners[1].say({ type: 'status', signedIn: [] });
    runners[1].end(0);
    await expect(look).resolves.toEqual({ signedIn: [] });
  });
});

describe('when the app quits', () => {
  it('ends the sign-in and the look at who is signed in that still runs, and starts nothing after', async () => {
    const { manager, runners } = setup();
    manager.start('anthropic');
    const cut = manager.status();
    const waiting = manager.logout('anthropic');
    manager.dispose();
    expect(runners.map((runner) => runner.killed)).toEqual([true, true]);
    // The look that was cut short says nobody, as one that does not answer does.
    runners[1].end(1);
    await expect(cut).resolves.toEqual({ signedIn: [] });
    await expect(waiting).rejects.toThrow('quitting');
    await expect(manager.status()).resolves.toEqual({ signedIn: [] });
    expect(runners).toHaveLength(2);
  });

  it.skipIf(process.platform === 'win32')('ends what the runner started too, not just the runner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mu-auth-'));
    let started: number | undefined;
    try {
      // As a checkout runs `mu auth`: tsx, which starts a second Node for pi.
      const launcher = join(dir, 'mu.mjs');
      writeFileSync(
        launcher,
        [
          "import { spawn } from 'node:child_process';",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
          "console.log(JSON.stringify({ type: 'started', pid: child.pid }));",
          'setInterval(() => {}, 1000);',
        ].join('\n')
      );
      const runner = spawnAuth(launcher, join(dir, 'agent'))(['status']);
      started = await new Promise<number>((resolve) => {
        runner.stdout.setEncoding('utf8');
        runner.stdout.on('data', (chunk: string) => resolve((JSON.parse(chunk) as { pid: number }).pid));
      });
      expect(alive(started)).toBe(true);
      const closed = new Promise((resolve) => runner.on('close', resolve));
      runner.kill();
      await closed;
      await vi.waitFor(() => expect(alive(started as number)).toBe(false), { timeout: 5000 });
    } finally {
      if (started && alive(started)) process.kill(started, 'SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('signing out', () => {
  it('asks the runner to sign out of that one account and reads who is left', async () => {
    const { manager, runners } = setup();
    const left = manager.logout('anthropic');
    expect(runners[0].args).toEqual(['logout', 'anthropic']);
    runners[0].say({ type: 'status', signedIn: [{ provider: 'openai-codex', models: [] }] });
    runners[0].end(0);
    await expect(left).resolves.toEqual({ signedIn: [{ provider: 'openai-codex', models: [] }] });
  });

  it('fails with the runner’s own words, and refuses a provider it does not offer', async () => {
    const { manager, runners } = setup();
    const failed = manager.logout('openai-codex');
    runners[0].say({ type: 'error', message: 'Credential store delete failed for openai-codex' });
    runners[0].end(1);
    await expect(failed).rejects.toThrow('Credential store delete failed for openai-codex');
    await expect(manager.logout('google' as never)).rejects.toThrow('Unknown provider');
    expect(runners).toHaveLength(1);
  });
});

describe('what the sign-in may open and run', () => {
  it('opens web pages only', () => {
    expect(openable('https://auth.openai.com/oauth/authorize?x=1')).toBe(true);
    expect(openable('http://localhost:1455/auth/callback')).toBe(false);
    expect(openable('file:///etc/hosts')).toBe(false);
    expect(openable('javascript:alert(1)')).toBe(false);
    expect(openable('not a url')).toBe(false);
    expect(openable(undefined)).toBe(false);
  });

  it('runs `mu auth` through the harness’s launcher, signed in to mu’s agent dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mu-auth-'));
    try {
      // A launcher that answers as `mu auth status` does, and says what it was started with.
      const launcher = join(dir, 'mu.mjs');
      writeFileSync(
        launcher,
        [
          'const [command, mode] = process.argv.slice(2);',
          'const models = [{ id: `${command} ${mode}`, name: process.env.MU_AGENT_DIR }];',
          "const signedIn = [{ provider: 'openai-codex', models }];",
          "console.log(JSON.stringify({ type: 'status', offered: ['openai-codex', 'anthropic'], signedIn }));",
        ].join('\n')
      );
      const manager = new LoginManager(spawnAuth(launcher, join(dir, 'agent')), () => {});
      await expect(manager.status()).resolves.toEqual({
        offered: ['openai-codex', 'anthropic'],
        signedIn: [{ provider: 'openai-codex', models: [{ id: 'auth status', name: join(dir, 'agent') }] }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * What a sign-out moves besides the credential (process/agent/kyrn/config/signOut.ts): the default model and the
 * running conversations, from what mu reports once it was checked again.
 */

const usable = (providers: AvailableModels['providers']): AvailableModels => ({ providers, thinkingLevels: [] });
const defaults = (provider: string, model: string): ModelDefaults => ({ provider, model, thinkingLevel: '' });

function parts(before: ModelDefaults, switched: SwitchedModel[] = []) {
  return {
    defaults: vi.fn(() => before),
    replaceDefault: vi.fn(),
    conversations: vi.fn(async () => switched),
  };
}

describe('a sign-out', () => {
  it('moves the default off the account to the first model mu still offers, and the conversations with it', async () => {
    const moved = parts(defaults('openai-codex', 'gpt-5.5'), [{ provider: 'relay', model: 'plain', name: 'Plain' }]);
    const after = usable([
      { id: 'corp-gateway', models: [] },
      { id: 'relay', models: [{ id: 'plain', name: 'Plain' }] },
      { id: 'xai', models: [{ id: 'grok-5', name: 'Grok 5' }] },
    ]);
    await expect(leaveProvider('openai-codex', after, moved)).resolves.toEqual({
      defaultMoved: true,
      conversations: 1,
      to: { provider: 'relay', model: 'plain', name: 'Plain' },
    });
    expect(moved.replaceDefault).toHaveBeenCalledWith({ provider: 'relay', model: 'plain' });
    expect(moved.conversations).toHaveBeenCalledWith('openai-codex', { provider: 'relay', id: 'plain' });
  });

  it('clears the default when no other model is set up', async () => {
    const moved = parts(defaults('xai', 'grok-5'));
    await expect(leaveProvider('xai', usable([]), moved)).resolves.toEqual({ defaultMoved: true, conversations: 0 });
    expect(moved.replaceDefault).toHaveBeenCalledWith(undefined);
    expect(moved.conversations).toHaveBeenCalledWith('xai', undefined);
  });

  it('keeps a default mu still offers (an API key for the same provider), and on another provider', async () => {
    const byKey = parts(defaults('openai', 'gpt-5.5'));
    const withKey = usable([{ id: 'openai', models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }] }]);
    await expect(leaveProvider('openai', withKey, byKey)).resolves.toEqual({ defaultMoved: false, conversations: 0 });
    expect(byKey.replaceDefault).not.toHaveBeenCalled();

    // A conversation on the account's model still goes on with the default, which is another provider's.
    const elsewhere = parts(defaults('relay', 'plain'), [{ provider: 'relay', model: 'plain', name: 'Plain' }]);
    const after = usable([{ id: 'relay', models: [{ id: 'plain', name: 'Plain' }] }]);
    await expect(leaveProvider('google-antigravity', after, elsewhere)).resolves.toEqual({
      defaultMoved: false,
      conversations: 1,
      to: { provider: 'relay', model: 'plain', name: 'Plain' },
    });
    expect(elsewhere.replaceDefault).not.toHaveBeenCalled();
    expect(elsewhere.conversations).toHaveBeenCalledWith('google-antigravity', { provider: 'relay', id: 'plain' });
  });
});
