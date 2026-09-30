import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  durable,
  fromEntries,
  reduceAll,
  type PiRecord,
} from '../../../packages/desktop/src/common/utils/nativeHost/index.ts';
import { prepareHost } from '../../../packages/desktop/src/process/services/nativeHost/launch.ts';
import {
  NativeHost,
  type NativeHostError,
  type NativeHostState,
} from '../../../packages/desktop/src/process/services/nativeHost/NativeHost.ts';
import { forkWithNode } from '../../../packages/desktop/src/process/services/nativeHost/nodeFork.ts';
import { PLAIN_TEXT, startFakeModel } from '../../e2e/mu-conversation/fakeModel.mjs';
import { createHostWorld, hostEnvironment, launcherFs } from './hostWorld.mjs';

/**
 * The native host for real: entry.ts forked with Node (the app forks the same file as an Electron utility process),
 * pi and the judgment layer of a mu checkout inside it, the E2E fake model and the offline mock judge, in a throwaway
 * home (hostWorld.mjs). Skipped where there is no harness that plans hosts: MU_ROOT, or the KYRN checkout beside this
 * repository.
 */

const ROOT = join(__dirname, '../../..');
const ENTRY = join(ROOT, 'packages/desktop/src/process/services/nativeHost/entry.ts');
const TURN_MS = 120_000;

const found: { harness: { root: string }; node: string } | { skip: string } = hostEnvironment(ROOT);
const skip = 'skip' in found ? found.skip : undefined;

/** The next record `test` accepts. */
const next = (host: NativeHost, test: (record: PiRecord) => boolean): Promise<PiRecord> =>
  new Promise((resolve) => {
    const stop = host.subscribe((record) => {
      if (!test(record)) return;
      stop();
      resolve(record);
    });
  });

/** The host's state once it is `phase`. */
const reaches = (host: NativeHost, phase: NativeHostState['phase']): Promise<NativeHostState> =>
  new Promise((resolve, reject) => {
    const check = (state: NativeHostState) => {
      if (state.phase === phase) resolve(state);
      else if (state.phase === 'failed') reject(state.error);
    };
    check(host.state);
    host.onState(check);
  });

/** Whether a process is still there. */
function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(skip !== undefined)(`the native host on a mu checkout${skip ? ` (${skip})` : ''}`, () => {
  const { harness, node } = 'skip' in found ? { harness: { root: '' }, node: '' } : found;
  let model: Awaited<ReturnType<typeof startFakeModel>>;
  const hosts: NativeHost[] = [];
  const worlds: { remove(): void }[] = [];

  beforeAll(async () => {
    model = await startFakeModel();
  });

  afterAll(async () => {
    await Promise.all(hosts.map((host) => host.dispose()));
    for (const world of worlds) world.remove();
    await model?.close();
  });

  async function start(withModel: boolean) {
    const world = createHostWorld({ baseUrl: withModel ? model.baseUrl : undefined, nodeDir: dirname(node) });
    worlds.push(world);
    const launch = await prepareHost({
      harness,
      cwd: world.project,
      env: world.env,
      home: world.home,
      platform: process.platform,
      stripsTypes: true,
      fs: launcherFs(harness.root),
    });
    const host = new NativeHost({ launch, fork: forkWithNode(ENTRY, node) });
    hosts.push(host);
    const records: PiRecord[] = [];
    host.subscribe((record) => records.push(record));
    host.start();
    return { host, records };
  }

  it(
    'runs a turn in a process of its own, and streams the view its session file gives back',
    async () => {
      const { host, records } = await start(true);
      const state = await host.request({ type: 'get_state' });
      expect(state.model).toMatchObject({ provider: 'e2e', id: 'e2e-fake-model' });
      expect(host.state).toEqual({ phase: 'running' });
      expect(host.timings.importMs).toBeGreaterThan(0);

      const settled = next(host, (record) => record.type === 'agent_settled');
      await host.request({ type: 'prompt', message: 'E2E:PLAIN' });
      await settled;
      const live = reduceAll(records);
      expect(live.status).toBe('settled');
      expect(live.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
      expect(live.messages[1]).toMatchObject({ blocks: [{ type: 'text', text: PLAIN_TEXT }], streaming: false });

      const pid = host.pid;
      await host.dispose();
      expect(host.state).toEqual({ phase: 'stopped' });
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000, interval: 50 });
      const session = readFileSync(state.sessionFile ?? '', 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown);
      // What only the live host says (its activity, the session as pi described it) is not in the file.
      expect(fromEntries(session)).toStrictEqual(durable(live));
    },
    TURN_MS
  );

  it(
    'waits for a model when none is set up, and says why a prompt cannot run',
    async () => {
      const { host, records } = await start(false);
      await reaches(host, 'needs-model');
      await expect(host.request({ type: 'get_available_models' })).resolves.toEqual({ models: [] });
      const refused = (await host
        .request({ type: 'prompt', message: 'hello' })
        .catch((reason: unknown) => reason)) as NativeHostError;
      expect(refused).toMatchObject({ kind: 'command' });
      const view = reduceAll(records);
      expect(view.status).toBe('error');
      expect(view.error).toBe(refused.message);
      expect(host.state).toEqual({ phase: 'needs-model' });
      await host.dispose();
      expect(host.state).toEqual({ phase: 'stopped' });
    },
    TURN_MS
  );

  it(
    'ends a host in the middle of a turn',
    async () => {
      const { host } = await start(true);
      await host.request({ type: 'get_state' });
      const streaming = next(host, (record) => record.type === 'message_update');
      const turn = host.request({ type: 'prompt', message: 'E2E:SLOW' });
      await streaming;
      const pid = host.pid;
      await host.dispose();
      expect(host.state).toEqual({ phase: 'stopped' });
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000, interval: 50 });
      // The prompt was answered before the run, or is rejected now: either way nothing waits any longer.
      await expect(turn.then(() => 'answered').catch((error: NativeHostError) => error.kind)).resolves.toMatch(
        /^(answered|closed)$/
      );
    },
    TURN_MS
  );
});
