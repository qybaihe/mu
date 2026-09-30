import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  NativeChangedEvent,
  NativeRecordEvent,
  NativeReplacedEvent,
  NativeStatusEvent,
} from '../../../packages/desktop/src/common/kyrn/nativeBridge.ts';
import { fromEntries, type NativeView } from '../../../packages/desktop/src/common/utils/nativeHost/index.ts';
import { hostEnv } from '../../../packages/desktop/src/process/services/nativeHost/conversations/hostEnv.ts';
import { NativeConversations } from '../../../packages/desktop/src/process/services/nativeHost/conversations/NativeConversations.ts';
import { prepareHost } from '../../../packages/desktop/src/process/services/nativeHost/launch.ts';
import { NativeHost } from '../../../packages/desktop/src/process/services/nativeHost/NativeHost.ts';
import { forkWithNode } from '../../../packages/desktop/src/process/services/nativeHost/nodeFork.ts';
import { sessionFolders } from '../../../packages/desktop/src/process/services/nativeHost/sessions/folders.ts';
import { PLAIN_TEXT, startFakeModel } from '../../e2e/mu-conversation/fakeModel.mjs';
import { createHostWorld, hostEnvironment, launcherFs } from './hostWorld.mjs';

/**
 * The native conversations on a real mu (docs/native-host.md, M2): the registry the bridge answers from, its hosts
 * forked with Node from entry.ts (the app forks the same file as an Electron utility process), pi and the judgment
 * layer of a mu checkout, the E2E fake model and the offline mock judge, in a throwaway home (hostWorld.mjs).
 *
 * With MU_MEASURE=1 it also times the list of many sessions and the opening of a large one, and prints what it
 * measured (`[measure]` lines) for the document.
 */

const ROOT = join(__dirname, '../../..');
const ENTRY = join(ROOT, 'packages/desktop/src/process/services/nativeHost/entry.ts');
const TURN_MS = 180_000;

const found: { harness: { root: string }; node: string } | { skip: string } = hostEnvironment(ROOT);
const skip = 'skip' in found ? found.skip : undefined;
const measuring = process.env.MU_MEASURE === '1';

const entriesOf = (file: string): unknown[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
    .slice(1);

/** What a session file can say: the view without what only a live run has. */
const durable = (view: NativeView) => ({
  messages: view.messages,
  judgments: view.judgments,
  status: view.status,
  error: view.error,
});

function rssMegabytes(pid: number | undefined): number | undefined {
  if (pid === undefined) return undefined;
  try {
    return Math.round(
      Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024
    );
  } catch {
    return undefined;
  }
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A time in a made-up session: second `index` of 2026. */
const at = (index: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();

const measure = (line: string): void => {
  if (measuring) console.log(`[measure] ${line}`);
};

describe.skipIf(skip !== undefined)(`native conversations on a mu checkout${skip ? ` (${skip})` : ''}`, () => {
  const { harness, node } = 'skip' in found ? { harness: { root: '' }, node: '' } : found;
  let model: Awaited<ReturnType<typeof startFakeModel>>;
  const registries: NativeConversations[] = [];
  const worlds: { remove(): void }[] = [];

  beforeAll(async () => {
    model = await startFakeModel();
  });

  afterAll(async () => {
    await Promise.all(registries.map((registry) => registry.dispose()));
    for (const world of worlds) world.remove();
    await model?.close();
  });

  function setUp() {
    const world = createHostWorld({ baseUrl: model.baseUrl, nodeDir: dirname(node) });
    worlds.push(world);
    const events = {
      records: [] as (NativeRecordEvent & { at: number })[],
      status: [] as NativeStatusEvent[],
      replaced: [] as (NativeReplacedEvent & { at: number })[],
      changed: [] as NativeChangedEvent[],
    };
    const starts: { session?: string; host: NativeHost }[] = [];
    const native = new NativeConversations({
      events: {
        records: (event) => events.records.push({ ...event, at: performance.now() }),
        status: (event) => events.status.push(event),
        replaced: (event) => events.replaced.push({ ...event, at: performance.now() }),
        changed: (event) => events.changed.push(event),
        attention: () => {},
      },
      startHost: async ({ cwd, session, env }) => {
        const launch = await prepareHost({
          harness,
          cwd,
          argv: ['--mode', 'rpc', ...(session ? ['--session', session] : [])],
          env: { ...world.env, ...env },
          home: world.home,
          platform: process.platform,
          stripsTypes: true,
          fs: launcherFs(harness.root),
        });
        const host = new NativeHost({ launch, fork: forkWithNode(ENTRY, node) });
        starts.push({ ...(session ? { session } : {}), host });
        host.start();
        return host;
      },
      folders: () => sessionFolders({ env: world.env, home: world.home }),
      env: (conversation) => hostEnv({ ...conversation, home: world.home }),
      trash: async (file) => rmSync(file),
      log: (line) => console.warn(`[native conversations] ${line}`),
    });
    registries.push(native);
    return { world, events, starts, native };
  }

  /** The run's end, and the check the conversation makes after it. */
  async function settle(events: ReturnType<typeof setUp>['events'], id: () => string, from: number): Promise<void> {
    await vi.waitFor(
      () => {
        const settled = events.records.filter((event) => event.id === id() && event.record.type === 'agent_settled');
        expect(settled.length).toBeGreaterThan(from);
      },
      { timeout: TURN_MS, interval: 20 }
    );
    // The check after the run: a get_state answer, then nothing for a while.
    let seen = -1;
    await vi.waitFor(
      () => {
        const now = events.records.length + events.replaced.length;
        const calm = now === seen;
        seen = now;
        expect(calm).toBe(true);
      },
      { timeout: 10_000, interval: 150 }
    );
  }

  it(
    'runs a draft on a new host, reopens it from its file without one, and resumes it with its history',
    async () => {
      const { events, starts, native, world } = setUp();
      const draft = await native.create({ cwd: world.project });
      let id = draft.id;
      const conversationId = () => id;

      const sent = performance.now();
      await native.request(draft.id, { type: 'prompt', message: 'E2E:PLAIN' });
      const replaced = events.changed.find((event) => 'replaces' in event && event.replaces === draft.id);
      expect(replaced).toBeDefined();
      id = replaced && 'conversation' in replaced ? replaced.conversation.id : '';
      await settle(events, conversationId, 0);
      const ready = events.replaced[0];
      const firstRecord = events.records[0];
      measure(
        `new conversation: host ready ${Math.round(ready.at - sent)} ms, first record ${Math.round(firstRecord.at - sent)} ms after the prompt was sent`
      );

      // Numbered from 1, one after the other, and the held view is the file's.
      expect(events.records.map((event) => event.seq)).toEqual(events.records.map((_, index) => index + 1));
      const live = await native.open(id);
      expect(live.seq).toBe(events.records.at(-1)?.seq);
      expect(live.status).toEqual({ phase: 'running' });
      const file = live.conversation.sessionFile ?? '';
      expect(file.startsWith(join(world.agentDir, 'sessions'))).toBe(true);
      expect(durable(live.view)).toEqual(durable(fromEntries(entriesOf(file))));
      expect(live.view.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
      expect(live.view.messages[1]).toMatchObject({ blocks: [{ type: 'text', text: PLAIN_TEXT }] });
      const pid = starts[0].host.pid;
      measure(`host memory after a PLAIN turn: ${rssMegabytes(pid)} MB`);

      // A prompt on the running host: the time to its first record.
      const before = events.records.length;
      const warmSent = performance.now();
      await native.request(id, { type: 'prompt', message: 'E2E:PLAIN' });
      await settle(events, conversationId, 1);
      measure(
        `running host: first record ${Math.round(events.records[before].at - warmSent)} ms after the prompt was sent`
      );

      await native.close(id);
      // pi shuts its session down; a busy machine may take it past the grace time to the kill.
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000, interval: 50 });
      expect(events.changed.at(-1)).toEqual({ conversation: expect.objectContaining({ id, live: false }) });

      // History without a host.
      const reopened = await native.open(id);
      expect(reopened).toMatchObject({ seq: 0, status: { phase: 'idle' }, conversation: { id, live: false } });
      expect(durable(reopened.view)).toEqual(durable(fromEntries(entriesOf(file))));
      expect(reopened.view.messages).toHaveLength(4);
      expect(starts).toHaveLength(1);
      const listed = await native.list();
      expect(listed).toEqual([expect.objectContaining({ id, sessionFile: file, title: 'E2E:PLAIN', live: false })]);

      // The next prompt resumes the file on a new host.
      const lastSeq = events.records.at(-1)?.seq ?? 0;
      const restartSent = performance.now();
      await native.request(id, { type: 'prompt', message: 'E2E:PLAIN' });
      expect(starts).toHaveLength(2);
      expect(starts[1].session).toBe(file);
      const restart = events.replaced.at(-1);
      expect(restart).toMatchObject({ id, seq: lastSeq });
      expect(restart?.view.messages).toHaveLength(4);
      measure(
        `reopened conversation: host ready ${Math.round((restart?.at ?? 0) - restartSent)} ms after the prompt was sent`
      );
      await settle(events, conversationId, 2);
      expect(events.records.find((event) => event.seq > lastSeq)?.seq).toBe(lastSeq + 1);
      const resumed = await native.open(id);
      expect(resumed.conversation.id).toBe(id);
      expect(resumed.view.messages).toHaveLength(6);
      expect(durable(resumed.view)).toEqual(durable(fromEntries(entriesOf(file))));

      // mu's /clear: pi goes on in a new session. The conversation follows it; the old session is listed on its own.
      await native.request(id, { type: 'prompt', message: '/clear' });
      await vi.waitFor(
        () =>
          expect(events.changed).toContainEqual({
            conversation: expect.objectContaining({ live: true }),
            replaces: id,
          }),
        { timeout: 10_000, interval: 50 }
      );
      const cleared = events.changed.find((event) => 'replaces' in event && event.replaces === id);
      const next = cleared && 'conversation' in cleared ? cleared.conversation.id : '';
      expect(next).not.toBe(id);
      expect(events.replaced.at(-1)).toMatchObject({ id: next, view: { messages: [] } });
      await vi.waitFor(
        () =>
          expect(events.changed).toContainEqual({
            conversation: expect.objectContaining({ id, sessionFile: file, live: false }),
          }),
        { timeout: 10_000, interval: 50 }
      );
      const both = await native.list();
      expect(both.map((each) => each.id).toSorted()).toEqual([id, next].toSorted());
      await expect(native.open(id)).resolves.toMatchObject({ seq: 0, conversation: { id, live: false } });
      expect(starts).toHaveLength(2);

      if (measuring) {
        // Many sessions: copies of this one under other ids.
        const project = dirname(file);
        const lines = readFileSync(file, 'utf8').split('\n');
        const header = JSON.parse(lines[0]) as { id: string };
        const count = 500;
        for (let index = 0; index < count; index++) {
          const copy = { ...header, id: `copy-${index}` };
          writeFileSync(
            join(project, `2026-01-01_copy-${index}.jsonl`),
            [JSON.stringify(copy), ...lines.slice(1)].join('\n')
          );
        }
        const coldAt = performance.now();
        const cold = await native.list();
        const coldMs = performance.now() - coldAt;
        const warmAt = performance.now();
        await native.list();
        const warmMs = performance.now() - warmAt;
        measure(
          `list of ${cold.length} sessions (${Math.round(readFileSync(file).length / 1024)} KB each): ${Math.round(coldMs)} ms first, ${Math.round(warmMs)} ms again`
        );
      }
      await native.dispose();
      await vi.waitFor(() => expect(alive(starts[1].host.pid)).toBe(false), { timeout: 5000, interval: 50 });
    },
    TURN_MS * 3
  );

  it.runIf(measuring)(
    'opens a large session from its file without holding up the main process (measured)',
    async () => {
      const { native, world } = setUp();
      const project = join(world.agentDir, 'sessions', '--large--');
      mkdirSync(project, { recursive: true });
      const file = join(project, '2026-01-01_large.jsonl');
      const lines = [
        JSON.stringify({ type: 'session', version: 3, id: 'large', timestamp: at(0), cwd: world.project }),
      ];
      let parent: string | null = null;
      let size = 0;
      for (let index = 0; size < 50 * 1024 * 1024; index++) {
        const user = {
          type: 'message',
          id: `u${index}`,
          parentId: parent,
          timestamp: at(index),
          message: {
            role: 'user',
            content: [{ type: 'text', text: `step ${index}` }],
            timestamp: Date.parse(at(index)),
          },
        };
        const call = { type: 'toolCall', id: `c${index}`, name: 'bash', arguments: { command: 'ls' } };
        const reply = {
          type: 'message',
          id: `a${index}`,
          parentId: `u${index}`,
          timestamp: at(index),
          message: {
            role: 'assistant',
            content: [call],
            provider: 'e2e',
            model: 'fake',
            stopReason: 'toolUse',
            timestamp: Date.parse(at(index)),
          },
        };
        const result = {
          type: 'message',
          id: `r${index}`,
          parentId: `a${index}`,
          timestamp: at(index),
          message: {
            role: 'toolResult',
            toolCallId: `c${index}`,
            toolName: 'bash',
            content: [{ type: 'text', text: 'o'.repeat(8 * 1024) }],
            isError: false,
            timestamp: Date.parse(at(index)),
          },
        };
        for (const line of [user, reply, result].map((each) => JSON.stringify(each))) {
          lines.push(line);
          size += line.length + 1;
        }
        parent = `r${index}`;
      }
      writeFileSync(file, `${lines.join('\n')}\n`);
      let worst = 0;
      let last = performance.now();
      const ticker = setInterval(() => {
        const now = performance.now();
        worst = Math.max(worst, now - last - 10);
        last = now;
      }, 10);
      const openedAt = performance.now();
      const snapshot = await native.open('large');
      const openMs = performance.now() - openedAt;
      // The stop that ends the open (the view is folded last) has no tick after it.
      worst = Math.max(worst, performance.now() - last - 10);
      clearInterval(ticker);
      const json = JSON.stringify(snapshot).length;
      measure(
        `open of a ${Math.round(size / 1024 / 1024)} MB session (${lines.length - 1} entries, ${snapshot.view.messages.length} messages): ${Math.round(openMs)} ms, longest stop of the main process ${Math.round(worst)} ms, snapshot ${Math.round(json / 1024 / 1024)} MB as JSON`
      );
      expect(snapshot.view.messages.length).toBeGreaterThan(0);
    },
    TURN_MS
  );
});
