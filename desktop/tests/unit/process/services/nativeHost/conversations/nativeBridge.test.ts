import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  nativeBridge,
  type NativeConversation,
} from '../../../../../../packages/desktop/src/common/kyrn/nativeBridge.ts';
import { bridge } from '../../../../../../packages/desktop/src/common/platform/bridge.ts';
import { emptyView } from '../../../../../../packages/desktop/src/common/utils/nativeHost/view.ts';
import {
  bridgeEvents,
  initNativeBridge,
  nativeConversationOf,
  nativeFailure,
  readCommand,
  registerNativeBridge,
  sendable,
} from '../../../../../../packages/desktop/src/process/bridge/nativeBridge.ts';
import { NativeRequestError } from '../../../../../../packages/desktop/src/process/services/nativeHost/conversations/errors.ts';
import type { NativeConversationsApi } from '../../../../../../packages/desktop/src/process/services/nativeHost/conversations/types.ts';
import { NativeHostError } from '../../../../../../packages/desktop/src/process/services/nativeHost/NativeHost.ts';
import { assistant, header, user, writeSession } from '../sessions/sessionFiles.ts';

const electron = vi.hoisted(() => ({
  beforeQuit: [] as ((event: { preventDefault(): void }) => void)[],
  quit: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    on: (event: string, listener: (event: { preventDefault(): void }) => void) => {
      if (event === 'before-quit') electron.beforeQuit.push(listener);
    },
    quit: electron.quit,
  },
  shell: { trashItem: vi.fn(async () => undefined) },
  utilityProcess: { fork: vi.fn() },
}));

/**
 * The bridge's main-process side (process/bridge/nativeBridge.ts) over a loopback transport that JSON round-trips every
 * message, as Electron's IPC does: what each provider answers, how failures reach the renderer, what is refused before
 * the native conversations see it, and the events they push.
 */

beforeAll(() => {
  let incoming: { emit(name: string, data: unknown): unknown } | undefined;
  bridge.adapter({
    emit: (name, data) => incoming?.emit(name, data === undefined ? undefined : JSON.parse(JSON.stringify(data))),
    on: (emitter) => {
      incoming = emitter;
    },
  });
});

const CONVERSATION: NativeConversation = {
  id: 'session-1',
  cwd: '/project',
  sessionFile: '/home/me/.mu/agent/sessions/--project--/2026_session-1.jsonl',
  title: 'Hello',
  createdAt: 1,
  updatedAt: 2,
  live: false,
};

function conversations(patch: Partial<NativeConversationsApi> = {}): NativeConversationsApi {
  return {
    list: vi.fn(async () => [CONVERSATION]),
    create: vi.fn(async ({ cwd }) => ({ ...CONVERSATION, id: 'draft-1', cwd, title: '' })),
    open: vi.fn(async () => ({
      conversation: CONVERSATION,
      status: { phase: 'idle' as const },
      seq: 0,
      view: emptyView(),
    })),
    request: vi.fn(async () => ({ sessionId: 'session-1' })),
    respond: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    ...patch,
  };
}

const refused = (message: string) => ({ ok: false, kind: 'invalid', message });

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mu-native-bridge-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the native conversation bridge in the main process', () => {
  it('is off without native conversations: every call but `enabled` says so', async () => {
    registerNativeBridge(undefined);
    await expect(nativeBridge.enabled.invoke()).resolves.toBe(false);
    const off = { ok: false, kind: 'off', message: 'The native host is off: MU_NATIVE_HOST=0 turned it off' };
    await expect(nativeBridge.list.invoke()).resolves.toEqual(off);
    await expect(nativeBridge.create.invoke({ cwd: '/project' })).resolves.toEqual(off);
    await expect(nativeBridge.open.invoke({ id: 'session-1' })).resolves.toEqual(off);
    await expect(nativeBridge.request.invoke({ id: 'session-1', command: { type: 'get_state' } })).resolves.toEqual(
      off
    );
    await expect(
      nativeBridge.respond.invoke({ id: 'session-1', dialogId: 'd1', answer: { confirmed: true } })
    ).resolves.toEqual(off);
    await expect(nativeBridge.close.invoke({ id: 'session-1' })).resolves.toEqual(off);
    await expect(nativeBridge.remove.invoke({ id: 'session-1' })).resolves.toEqual(off);
    await expect(nativeBridge.rename.invoke({ id: 'session-1', name: 'Build fix' })).resolves.toEqual(off);
  });

  it('answers `enabled` when the mu on this machine is known to run inside the app, or not', async () => {
    registerNativeBridge(conversations(), () => Promise.resolve(false));
    await expect(nativeBridge.enabled.invoke()).resolves.toBe(false);
    registerNativeBridge(conversations(), () => Promise.resolve(true));
    await expect(nativeBridge.enabled.invoke()).resolves.toBe(true);
    // Without native conversations (the kill switch) the readiness is not even asked.
    const ready = vi.fn(() => true);
    registerNativeBridge(undefined, ready);
    await expect(nativeBridge.enabled.invoke()).resolves.toBe(false);
    expect(ready).not.toHaveBeenCalled();
  });

  it('renames a conversation with a name pi would keep, and refuses one it would not', async () => {
    const api = conversations();
    registerNativeBridge(api);
    await expect(nativeBridge.rename.invoke({ id: 'session-1', name: '  Build\r\nfix  ' })).resolves.toEqual({
      ok: true,
    });
    // One line, trimmed, as pi's appendSessionInfo keeps it.
    expect(api.rename).toHaveBeenCalledWith('session-1', 'Build fix');
    const answers = await Promise.all(
      ['', '  \n ', 7, 'x'.repeat(501)].map((name) => nativeBridge.rename.invoke({ id: 'session-1', name } as never))
    );
    for (const refusal of answers) expect(refusal).toMatchObject({ ok: false, kind: 'invalid' });
    await expect(nativeBridge.rename.invoke({ id: '', name: 'Build fix' })).resolves.toEqual(
      refused('Invalid conversation')
    );
    expect(api.rename).toHaveBeenCalledTimes(1);
  });

  it('answers each provider from the native conversations', async () => {
    const api = conversations();
    registerNativeBridge(api);
    await expect(nativeBridge.enabled.invoke()).resolves.toBe(true);
    await expect(nativeBridge.list.invoke()).resolves.toEqual({ ok: true, data: [CONVERSATION] });
    await expect(nativeBridge.create.invoke({ cwd: '/elsewhere', permissions: 'ask' })).resolves.toMatchObject({
      ok: true,
      data: { id: 'draft-1', cwd: '/elsewhere' },
    });
    expect(api.create).toHaveBeenCalledWith({ cwd: '/elsewhere', permissions: 'ask' });
    await expect(nativeBridge.open.invoke({ id: 'session-1' })).resolves.toMatchObject({ ok: true, data: { seq: 0 } });
    expect(api.open).toHaveBeenCalledWith('session-1');
    await expect(
      nativeBridge.request.invoke({ id: 'session-1', command: { type: 'prompt', message: 'hi' } })
    ).resolves.toEqual({ ok: true, data: { sessionId: 'session-1' } });
    expect(api.request).toHaveBeenCalledWith('session-1', { type: 'prompt', message: 'hi' });
    await expect(
      nativeBridge.respond.invoke({ id: 'session-1', dialogId: 'd1', answer: { value: 'Allow once' } })
    ).resolves.toEqual({ ok: true });
    expect(api.respond).toHaveBeenCalledWith('session-1', 'd1', { value: 'Allow once' });
    await expect(nativeBridge.close.invoke({ id: 'session-1' })).resolves.toEqual({ ok: true });
    expect(api.close).toHaveBeenCalledWith('session-1');
    await expect(nativeBridge.remove.invoke({ id: 'session-1' })).resolves.toEqual({ ok: true });
    expect(api.remove).toHaveBeenCalledWith('session-1');
  });

  it('answers a failure with its kind, its message and the end of the host’s output', async () => {
    registerNativeBridge(
      conversations({
        request: vi.fn(async () => {
          throw new NativeHostError('crashed', 'The mu host stopped by itself (exit code 1)', {
            code: 1,
            stderr: 'TypeError: boom',
          });
        }),
        open: vi.fn(async () => {
          throw new NativeRequestError('unknown-conversation', 'No conversation session-9');
        }),
        list: vi.fn(async () => {
          throw new Error("EACCES: permission denied, scandir '/home/me/.mu/agent/sessions'");
        }),
        close: vi.fn(async () => {
          throw new NativeHostError('timeout', 'mu did not answer get_state in 30000 ms');
        }),
      })
    );
    await expect(nativeBridge.request.invoke({ id: 'session-1', command: { type: 'get_state' } })).resolves.toEqual({
      ok: false,
      kind: 'crashed',
      message: 'The mu host stopped by itself (exit code 1)',
      stderr: 'TypeError: boom',
    });
    await expect(nativeBridge.open.invoke({ id: 'session-9' })).resolves.toEqual({
      ok: false,
      kind: 'unknown-conversation',
      message: 'No conversation session-9',
    });
    await expect(nativeBridge.list.invoke()).resolves.toEqual({
      ok: false,
      kind: 'failed',
      message: "EACCES: permission denied, scandir '/home/me/.mu/agent/sessions'",
    });
    // No output, no `stderr`.
    await expect(nativeBridge.close.invoke({ id: 'session-1' })).resolves.toEqual({
      ok: false,
      kind: 'timeout',
      message: 'mu did not answer get_state in 30000 ms',
    });
  });

  it('refuses what the screen should never send, before the native conversations see it', async () => {
    const api = conversations();
    registerNativeBridge(api);
    await expect(nativeBridge.open.invoke({ id: '' })).resolves.toEqual(refused('Invalid conversation'));
    await expect(nativeBridge.open.invoke({ id: 'a\nb' })).resolves.toEqual(refused('Invalid conversation'));
    await expect(
      nativeBridge.request.invoke({ id: 'session-1', command: { type: 'rm_rf' } as never })
    ).resolves.toEqual(refused('Invalid command'));
    await expect(
      nativeBridge.request.invoke({ id: 'session-1', command: { type: 'prompt' } as never })
    ).resolves.toEqual(refused('A prompt needs a message'));
    await expect(
      nativeBridge.request.invoke({ id: 'session-1', command: { type: 'switch_session' } as never })
    ).resolves.toEqual(refused('A switch_session needs a sessionPath'));
    await expect(
      nativeBridge.respond.invoke({ id: 'session-1', dialogId: 'd1', answer: { value: 3 } as never })
    ).resolves.toEqual(refused('Invalid dialog answer'));
    await expect(nativeBridge.create.invoke({ cwd: '' })).resolves.toEqual(refused('A conversation needs a folder'));
    await expect(nativeBridge.create.invoke({ cwd: '/project', permissions: 'ALL; rm' })).resolves.toEqual(
      refused('Invalid permission mode')
    );
    expect(api.open).not.toHaveBeenCalled();
    expect(api.request).not.toHaveBeenCalled();
    expect(api.respond).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('drops an id the screen put on a command: the manager pairs its own', () => {
    expect(readCommand({ type: 'abort', id: 'h1' })).toEqual({ type: 'abort' });
    expect(readCommand({ type: 'fork', entryId: 'a1b2c3d4' })).toEqual({ type: 'fork', entryId: 'a1b2c3d4' });
  });

  it('fails a view too large to cross to the renderer instead of leaving the call unanswered', async () => {
    expect(sendable({ ok: true, data: 'x'.repeat(100) }, 1000)).toEqual({ ok: true, data: 'x'.repeat(100) });
    expect(sendable({ ok: true, data: 'x'.repeat(3 * 1024 * 1024) }, 1024 * 1024)).toEqual({
      ok: false,
      kind: 'failed',
      message: 'The conversation is too large to show (3 MB)',
    });
    const failure = { ok: false as const, kind: 'closed' as const, message: 'closed' };
    expect(sendable(failure, 1)).toBe(failure);
    const huge = {
      ...emptyView(),
      messages: [{ id: 'm1', role: 'custom' as const, customType: 'x', text: 'x'.repeat(49 * 1024 * 1024) }],
    };
    registerNativeBridge(
      conversations({
        open: vi.fn(async () => ({
          conversation: CONVERSATION,
          status: { phase: 'idle' as const },
          seq: 0,
          view: huge,
        })),
      })
    );
    await expect(nativeBridge.open.invoke({ id: 'session-1' })).resolves.toEqual({
      ok: false,
      kind: 'failed',
      message: 'The conversation is too large to show (49 MB)',
    });
  });

  it('maps every manager kind onto the renderer’s kind of the same name', () => {
    for (const kind of [
      'off',
      'no-harness',
      'old-harness',
      'plan',
      'no-models',
      'failed',
      'crashed',
      'closed',
      'timeout',
      'command',
    ] as const)
      expect(nativeFailure(new NativeHostError(kind, 'why'))).toEqual({ ok: false, kind, message: 'why' });
  });

  it('is set up in the app unless MU_NATIVE_HOST=0: off with it, the sessions of mu without', async () => {
    vi.stubEnv('MU_NATIVE_HOST', '0');
    initNativeBridge();
    await expect(nativeBridge.enabled.invoke()).resolves.toBe(false);
    expect(electron.beforeQuit).toHaveLength(0);

    const agentDir = join(root, 'agent');
    writeSession(join(agentDir, 'sessions', '--project--', '2026_s1.jsonl'), [
      header('s1', '/project'),
      user('u1', null, 'Hello there', 1),
      assistant('a1', 'u1', 'Hi', 2),
    ]);
    // 1 forces it on (no mu is looked for), which is what a developer testing an older mu wants.
    vi.stubEnv('MU_NATIVE_HOST', '1');
    vi.stubEnv('MU_AGENT_DIR', agentDir);
    vi.stubEnv('MU_CODING_AGENT_SESSION_DIR', '');
    try {
      initNativeBridge();
      await expect(nativeBridge.enabled.invoke()).resolves.toBe(true);
      await expect(nativeBridge.list.invoke()).resolves.toMatchObject({
        ok: true,
        data: [{ id: 's1', cwd: '/project', title: 'Hello there', live: false }],
      });
      await expect(nativeBridge.open.invoke({ id: 's1' })).resolves.toMatchObject({
        ok: true,
        data: { seq: 0, status: { phase: 'idle' }, view: { messages: [{ role: 'user' }, { role: 'assistant' }] } },
      });
      expect(nativeConversationOf('n-unknown')).toBeUndefined();
      // No host runs: the quit is not held up.
      const event = { preventDefault: vi.fn() };
      expect(electron.beforeQuit).toHaveLength(1);
      electron.beforeQuit[0](event);
      expect(event.preventDefault).not.toHaveBeenCalled();
      await expect(nativeBridge.list.invoke()).resolves.toMatchObject({ ok: false, kind: 'closed' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('left alone, it follows the mu found: on for one that can run inside the app, off for an older one', async () => {
    const harnessWith = (name: string, source: string): string => {
      const folder = join(root, name);
      mkdirSync(join(folder, 'kyrn', 'bin'), { recursive: true });
      writeFileSync(join(folder, 'kyrn', 'bin', 'mu.mjs'), source);
      return folder;
    };
    // A mu of today, and the mu a packaged app carried before the native host: a launcher without planHost.
    const current = harnessWith(
      'mu-current',
      `export function planHost() { return { module: '/mu/pi.js', execArgv: [], args: [], env: {}, layout: 'package', muDir: '/m', appDir: '/m/app', agentDir: '/m/agent', startJudge: false, notes: [] }; }
export function prepareLaunch() {}
`
    );
    const older = harnessWith('mu-older', 'export function planLaunch() { return {}; }\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      vi.stubEnv('MU_NATIVE_HOST', '');
      vi.stubEnv('KYRN_ROOT', '');
      vi.stubEnv('MU_ROOT', current);
      initNativeBridge();
      await expect(nativeBridge.enabled.invoke()).resolves.toBe(true);
      expect(warn).not.toHaveBeenCalled();

      vi.stubEnv('MU_ROOT', older);
      initNativeBridge();
      await expect(nativeBridge.enabled.invoke()).resolves.toBe(false);
      // The reason is in the log, and nothing else says a word: the app just keeps the classic path.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('the native host stays off: This mu cannot run'));
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('pushes what the native conversations emit to every window', () => {
    const records = vi.fn();
    const status = vi.fn();
    const replaced = vi.fn();
    const changed = vi.fn();
    const stops = [
      nativeBridge.records.on(records),
      nativeBridge.status.on(status),
      nativeBridge.replaced.on(replaced),
      nativeBridge.changed.on(changed),
    ];
    bridgeEvents.records({ id: 'session-1', seq: 1, record: { type: 'agent_start' } });
    bridgeEvents.status({ id: 'session-1', status: { phase: 'running' } });
    bridgeEvents.replaced({ id: 'session-1', seq: 1, view: emptyView(), conversation: CONVERSATION });
    bridgeEvents.changed({ removed: 'session-1' });
    for (const stop of stops) stop();
    expect(records).toHaveBeenCalledWith({ id: 'session-1', seq: 1, record: { type: 'agent_start' } });
    expect(status).toHaveBeenCalledWith({ id: 'session-1', status: { phase: 'running' } });
    expect(replaced).toHaveBeenCalledWith({ id: 'session-1', seq: 1, view: emptyView(), conversation: CONVERSATION });
    expect(changed).toHaveBeenCalledWith({ removed: 'session-1' });
  });
});
