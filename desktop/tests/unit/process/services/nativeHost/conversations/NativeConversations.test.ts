import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  NativeAttentionEvent,
  NativeChangedEvent,
  NativeRecordEvent,
  NativeReplacedEvent,
  NativeStatusEvent,
} from '../../../../../../packages/desktop/src/common/kyrn/nativeBridge.ts';
import { fromEntries } from '../../../../../../packages/desktop/src/common/utils/nativeHost/reducer.ts';
import { durable, emptyView } from '../../../../../../packages/desktop/src/common/utils/nativeHost/view.ts';
import {
  ATTENTION_DELAY_MS,
  LOCKED_RETRY_MS,
} from '../../../../../../packages/desktop/src/process/services/nativeHost/conversations/Conversation.ts';
import {
  NativeConversations,
  type NativeConversationsOptions,
} from '../../../../../../packages/desktop/src/process/services/nativeHost/conversations/NativeConversations.ts';
import { NativeHostError } from '../../../../../../packages/desktop/src/process/services/nativeHost/NativeHost.ts';
import type { SessionFolders } from '../../../../../../packages/desktop/src/process/services/nativeHost/sessions/folders.ts';
import { assistant, header, user, writeSession } from '../sessions/sessionFiles.ts';
import { FakePi } from './fakePi.ts';

/**
 * The native conversations (process/services/nativeHost/conversations/) on a stand-in pi (fakePi.ts): drafts and their
 * session ids, one host per conversation started on demand, records numbered into the held view, history read from
 * session files without a host, sessions that change under a conversation, the idle policy and the host cap, and what
 * the CLI bridge did per session (the model search, the locked store, the permission mode).
 */

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world(options: Partial<NativeConversationsOptions> = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mu-native-conversations-')));
  roots.push(root);
  const agentDir = join(root, 'agent');
  const sessionsDir = join(agentDir, 'sessions');
  const project = join(root, 'project');
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(project);
  const pi = new FakePi(sessionsDir);
  const events = {
    records: [] as NativeRecordEvent[],
    status: [] as NativeStatusEvent[],
    replaced: [] as NativeReplacedEvent[],
    changed: [] as NativeChangedEvent[],
    attention: [] as NativeAttentionEvent[],
  };
  const trashed: string[] = [];
  let folders: SessionFolders = { agentDir, sessionsDir };
  const conversations = new NativeConversations({
    events: {
      records: (event) => events.records.push(event),
      status: (event) => events.status.push(event),
      replaced: (event) => events.replaced.push(event),
      changed: (event) => events.changed.push(event),
      attention: (event) => events.attention.push(event),
    },
    startHost: pi.startHost,
    folders: () => folders,
    env: (conversation) => ({
      MU_DESKTOP_SESSION: conversation.desktopSession,
      ...(conversation.permissions ? { MU_PERMISSIONS: conversation.permissions } : {}),
    }),
    trash: async (file) => {
      trashed.push(file);
      rmSync(file);
    },
    log: () => {},
    ...options,
  });
  return {
    root,
    agentDir,
    sessionsDir,
    project,
    pi,
    events,
    trashed,
    conversations,
    moveFolders: (next: SessionFolders) => {
      folders = next;
    },
  };
}

type World = ReturnType<typeof world>;

/** The session file's entries, as pi wrote them. */
const entriesOf = (file: string): unknown[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
    .slice(1);

/** A turn of the stand-in pi, and the check the conversation makes after it. */
async function turn(w: World, id: string, message: string): Promise<void> {
  await w.conversations.request(id, { type: 'prompt', message });
  await w.pi.last.turn;
  await settled(w);
}

/** The real clock's timer, which a test's fake timers leave alone: session files are read on it. */
const realTimeout = globalThis.setTimeout;

/** Until nothing is on its way: the checks the conversations make after each run, and the files they read. */
async function settled(w: World): Promise<void> {
  let seen = -1;
  let calm = 0;
  while (calm < 5) {
    // oxlint-disable-next-line no-await-in-loop -- until nothing changes for a while
    await new Promise((resolve) => realTimeout(resolve, 2));
    const sent = w.pi.hosts.reduce((count, host) => count + host.sent.length, 0);
    const now = sent + w.events.replaced.length + w.events.changed.length;
    calm = now === seen ? calm + 1 : 0;
    seen = now;
  }
}

const seqsOf = (w: World, id: string): number[] =>
  w.events.records.filter((event) => event.id === id).map((event) => event.seq);

describe('native conversations', () => {
  it('say what a conversation with no host will run with: its file’s model, thinking level and mode', async () => {
    const w = world();
    writeSession(join(w.sessionsDir, '--project--', '2026_cli.jsonl'), [
      header('cli', w.project, 1),
      {
        type: 'thinking_level_change',
        id: 't1',
        parentId: null,
        timestamp: header('cli', w.project, 1).timestamp,
        thinkingLevel: 'high',
      },
      user('u1', 't1', 'From the command line', 2),
      assistant('a1', 'u1', 'Hello', 3),
      {
        type: 'custom',
        id: 'p1',
        parentId: 'a1',
        timestamp: header('cli', w.project, 3).timestamp,
        customType: 'mu.permissions',
        data: { mode: 'full' },
      },
    ]);
    await w.conversations.list();
    await expect(w.conversations.open('cli')).resolves.toMatchObject({
      seq: 0,
      session: { model: 'e2e/e2e-fake-model', thinkingLevel: 'high', permissions: 'full' },
    });
    // A draft has no file yet: the mode it was made with is the one its mu starts in.
    const draft = await w.conversations.create({ cwd: w.project, permissions: 'ask' });
    await expect(w.conversations.open(draft.id)).resolves.toMatchObject({ session: { permissions: 'ask' } });
    expect(w.pi.hosts).toHaveLength(0);
  });

  it('start no host for a draft until a command needs pi; the draft then takes its session’s id', async () => {
    const w = world();
    const draft = await w.conversations.create({ cwd: w.project });
    expect(draft).toMatchObject({ id: expect.stringMatching(/^draft-/), cwd: w.project, title: '', live: false });
    expect(w.events.changed).toEqual([{ conversation: draft }]);
    await expect(w.conversations.list()).resolves.toEqual([draft]);
    await expect(w.conversations.open(draft.id)).resolves.toEqual({
      conversation: draft,
      status: { phase: 'idle' },
      seq: 0,
      view: emptyView(),
    });
    expect(w.pi.hosts).toHaveLength(0);

    // Two calls at once: one host.
    const [state] = await Promise.all([
      w.conversations.request(draft.id, { type: 'get_state' }),
      w.conversations.request(draft.id, { type: 'get_commands' }),
    ]);
    expect(w.pi.hosts).toHaveLength(1);
    const id = w.pi.last.session.id;
    expect(state).toMatchObject({ sessionId: id });
    expect(w.events.changed).toContainEqual({
      conversation: expect.objectContaining({ id, live: true }),
      replaces: draft.id,
    });
    expect(w.events.status.map((event) => event.status.phase)).toEqual(['starting', 'running']);
    expect(w.events.replaced).toEqual([expect.objectContaining({ id, seq: 0 })]);
    // The draft's id still reaches it, and mu names it by the app's name for it.
    await expect(w.conversations.request(draft.id, { type: 'get_state' })).resolves.toMatchObject({ sessionId: id });
    expect(w.pi.hosts).toHaveLength(1);
    const desktopSession = w.pi.last.input.env.MU_DESKTOP_SESSION;
    expect(desktopSession).toMatch(/^n-[0-9a-f-]{36}$/);
    expect(w.conversations.conversationOf(desktopSession)).toBe(id);
    await expect(w.conversations.open('nobody')).rejects.toMatchObject({ kind: 'unknown-conversation' });
  });

  it('refuses a folder that does not exist', async () => {
    const w = world();
    await expect(w.conversations.create({ cwd: join(w.root, 'missing') })).rejects.toMatchObject({ kind: 'invalid' });
    await expect(w.conversations.create({ cwd: 'relative/folder' })).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('numbers every record of a turn, and holds the view the session file gives', async () => {
    const w = world();
    const draft = await w.conversations.create({ cwd: w.project });
    await turn(w, draft.id, 'hello');
    const id = w.pi.last.session.id;
    const seqs = seqsOf(w, id);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    const types = w.events.records.map((event) => event.record.type);
    expect(types).toContain('message_update');
    expect(types.at(-1)).toBe('response');
    // Answers the view reads nothing in stay with whoever asked.
    expect(
      w.events.records.some((event) => event.record.type === 'response' && event.record.command === 'get_entries')
    ).toBe(false);

    const snapshot = await w.conversations.open(id);
    expect(snapshot.seq).toBe(seqs.at(-1));
    expect(snapshot.status).toEqual({ phase: 'running' });
    expect(snapshot.conversation).toMatchObject({ id, title: 'hello', live: true });
    // The held view also has what only the live host says (its activity, pi's session state): not in the file.
    expect(durable(snapshot.view)).toEqual(fromEntries(entriesOf(w.pi.last.session.file)));
    expect(snapshot.view.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('opens a conversation without a host from its session file, and lists the command line’s sessions', async () => {
    const w = world();
    const file = writeSession(join(w.sessionsDir, '--project--', '2026_cli.jsonl'), [
      header('cli', w.project, 1),
      user('u1', null, 'From the command line', 2),
      assistant('a1', 'u1', 'Hello', 3),
    ]);
    const draft = await w.conversations.create({ cwd: w.project });
    const listed = await w.conversations.list();
    expect(listed.map((each) => each.id)).toEqual([draft.id, 'cli']);
    expect(listed[1]).toEqual({
      id: 'cli',
      cwd: w.project,
      sessionFile: file,
      title: 'From the command line',
      createdAt: Date.parse(header('cli', w.project, 1).timestamp as string),
      updatedAt: Date.parse(header('cli', w.project, 3).timestamp as string),
      live: false,
      messageCount: 2,
    });
    const snapshot = await w.conversations.open('cli');
    expect(snapshot).toMatchObject({ seq: 0, status: { phase: 'idle' }, conversation: { id: 'cli', live: false } });
    expect(snapshot.view).toEqual(fromEntries(entriesOf(file)));
    expect(w.pi.hosts).toHaveLength(0);

    // A file that is gone takes its conversation along.
    rmSync(file);
    await expect(w.conversations.list()).resolves.toEqual([expect.objectContaining({ id: draft.id })]);
  });

  it('starts an ended conversation again on the next command, resuming its file with its history', async () => {
    const w = world();
    const draft = await w.conversations.create({ cwd: w.project });
    await turn(w, draft.id, 'one');
    const id = w.pi.last.session.id;
    const file = w.pi.last.session.file;
    const before = seqsOf(w, id).at(-1) ?? 0;

    await w.conversations.close(id);
    expect(w.pi.last.disposed).toBe(true);
    expect(w.events.status.at(-1)).toEqual({ id, status: { phase: 'idle' } });
    expect(w.events.changed.at(-1)).toEqual({ conversation: expect.objectContaining({ id, live: false }) });
    const closed = await w.conversations.open(id);
    expect(closed).toMatchObject({ seq: 0, status: { phase: 'idle' } });
    expect(closed.view.messages).toHaveLength(2);
    expect(w.pi.hosts).toHaveLength(1);

    await turn(w, id, 'two');
    expect(w.pi.hosts).toHaveLength(2);
    expect(w.pi.last.input.session).toBe(file);
    expect(w.pi.last.session.id).toBe(id);
    // The restart's view has the history, and its records go on from where the last host's stopped.
    const restart = w.events.replaced.at(-1);
    expect(restart).toMatchObject({ id, seq: before });
    expect(restart?.view.messages).toHaveLength(2);
    expect(seqsOf(w, id).find((seq) => seq > before)).toBe(before + 1);
    const snapshot = await w.conversations.open(id);
    expect(snapshot.view.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(durable(snapshot.view)).toEqual(fromEntries(entriesOf(file)));
  });

  it('answers a stop or a queue clear itself when no host runs', async () => {
    const w = world();
    const draft = await w.conversations.create({ cwd: w.project });
    await expect(w.conversations.request(draft.id, { type: 'abort' })).resolves.toBeUndefined();
    await expect(w.conversations.request(draft.id, { type: 'clear_queue' })).resolves.toEqual({
      steering: [],
      followUp: [],
    });
    expect(w.pi.hosts).toHaveLength(0);
  });

  it('ends a host after the idle time, never while a dialog waits', async () => {
    vi.useFakeTimers();
    const w = world({ idleMs: 1000 });
    const draft = await w.conversations.create({ cwd: w.project });
    await turn(w, draft.id, 'hello');
    const id = w.pi.last.session.id;
    await vi.advanceTimersByTimeAsync(900);
    expect(w.pi.last.disposed).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(w.pi.last.disposed).toBe(true);
    expect(w.events.changed.at(-1)).toEqual({ conversation: expect.objectContaining({ id, live: false }) });

    const asked = w.conversations.request(id, { type: 'prompt', message: '/ask' });
    await vi.waitFor(() => expect(w.pi.hosts).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.pi.last.disposed).toBe(false);
    const snapshot = await w.conversations.open(id);
    expect(snapshot.view.dialogs).toEqual([expect.objectContaining({ id: 'd1', method: 'confirm' })]);
    await w.conversations.respond(id, 'd1', { confirmed: true });
    await asked;
    await vi.advanceTimersByTimeAsync(1100);
    expect(w.pi.last.disposed).toBe(true);
  });

  it('ends a dialog pi stopped waiting on, so an idle host can end', async () => {
    vi.useFakeTimers();
    const w = world({ idleMs: 1000 });
    const draft = await w.conversations.create({ cwd: w.project });
    const asked = w.conversations.request(draft.id, { type: 'prompt', message: '/ask 5000' });
    await vi.waitFor(() => expect(w.events.records.some((event) => event.record.id === 'd1')).toBe(true));
    const id = w.pi.last.session.id;
    await vi.advanceTimersByTimeAsync(4000);
    expect(w.pi.last.disposed).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await asked;
    expect(w.events.records.map((event) => event.record)).toContainEqual({
      type: 'extension_ui_response',
      id: 'd1',
      cancelled: true,
    });
    await expect(w.conversations.open(id)).resolves.toMatchObject({ view: { dialogs: [] } });
    await vi.advanceTimersByTimeAsync(1100);
    expect(w.pi.last.disposed).toBe(true);
  });

  it('keeps at most the cap of hosts: the least recently used idle one ends, a busy one never', async () => {
    let clock = 0;
    const w = world({ maxLive: 2, now: () => ++clock });
    const start = async () => {
      const draft = await w.conversations.create({ cwd: w.project });
      await w.conversations.request(draft.id, { type: 'get_state' });
      return w.pi.last;
    };
    const first = await start();
    const second = await start();
    // The first one is busy: a command asks, and waits for the answer.
    const asked = w.conversations.request(first.session.id, { type: 'prompt', message: '/ask' });
    await vi.waitFor(() => expect(first.sent.some((command) => command.type === 'prompt')).toBe(true));
    const third = await start();
    expect([first.disposed, second.disposed, third.disposed]).toEqual([false, true, false]);
    // Answered, the first one is idle again, and the one used longest ago is the third.
    await w.conversations.respond(first.session.id, 'd1', { confirmed: true });
    await asked;
    await settled(w);
    const fourth = await start();
    expect([first.disposed, third.disposed, fourth.disposed]).toEqual([false, true, false]);
    expect(w.pi.running).toHaveLength(2);
  });

  it('follows mu into a new session (`/clear`): the conversation takes its id, the old session stays listed', async () => {
    const w = world();
    const draft = await w.conversations.create({ cwd: w.project });
    await turn(w, draft.id, 'hello');
    const old = w.pi.last.session.id;
    const oldFile = w.pi.last.session.file;
    await w.conversations.request(old, { type: 'prompt', message: '/clear' });
    await settled(w);
    const id = w.pi.last.session.id;
    expect(id).not.toBe(old);
    expect(w.events.changed).toContainEqual({
      conversation: expect.objectContaining({ id, live: true, title: '' }),
      replaces: old,
    });
    expect(w.events.replaced.at(-1)).toMatchObject({ id, view: { messages: [] } });
    await vi.waitFor(() =>
      expect(w.events.changed).toContainEqual({
        conversation: expect.objectContaining({ id: old, sessionFile: oldFile, live: false, title: 'hello' }),
      })
    );
    const listed = await w.conversations.list();
    expect(listed.map((each) => each.id).toSorted()).toEqual([id, old].toSorted());
    // The old id names the old session: it opens from its file.
    const snapshot = await w.conversations.open(old);
    expect(snapshot).toMatchObject({ seq: 0, conversation: { id: old, live: false } });
    expect(snapshot.view.messages).toHaveLength(2);
  });

  it('rebuilds the view when mu moves the branch back (a checkpoint rewind)', async () => {
    const w = world();
    const draft = await w.conversations.create({ cwd: w.project });
    await turn(w, draft.id, 'one');
    const id = w.pi.last.session.id;
    const kept = w.pi.last.session.leafId;
    await turn(w, id, 'two');
    const before = w.events.replaced.length;
    await w.conversations.request(id, { type: 'prompt', message: `/rewind ${kept}` });
    await settled(w);
    expect(w.events.replaced).toHaveLength(before + 1);
    const snapshot = await w.conversations.open(id);
    expect(snapshot.view.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    // Rebuilt from the file; what only the live host said (the Jev panel's activity) stays.
    expect(durable(snapshot.view)).toEqual(fromEntries(w.pi.last.session.entries, kept));
    expect(snapshot.view.host.activity.map((line) => line.kind)).toContain('agent_settled');
    expect(w.events.replaced.at(-1)).toMatchObject({ id, seq: snapshot.seq });
  });

  it('rebuilds the view after a session command, and refuses a session another conversation runs', async () => {
    const w = world();
    const one = await w.conversations.create({ cwd: w.project });
    await turn(w, one.id, 'first');
    const first = w.pi.last;
    const two = await w.conversations.create({ cwd: w.project });
    await turn(w, two.id, 'second');
    await expect(
      w.conversations.request(two.id, { type: 'switch_session', sessionPath: first.session.file })
    ).rejects.toMatchObject({ kind: 'invalid' });
    await w.conversations.close(first.session.id);
    await w.conversations.request(two.id, { type: 'switch_session', sessionPath: first.session.file });
    const now = await w.conversations.open(first.session.id);
    expect(now.conversation).toMatchObject({ id: first.session.id, live: true });
    expect(now.view.messages[0]).toMatchObject({ role: 'user', text: 'first' });
  });

  it('sends a prompt again when pi refused it for a locked store, and shows only the run', async () => {
    vi.useFakeTimers();
    const w = world();
    const draft = await w.conversations.create({ cwd: w.project });
    await w.conversations.request(draft.id, { type: 'get_state' });
    const id = w.pi.last.session.id;
    w.pi.last.refusals.push('Lock file is already being held');
    const sent = w.conversations.request(id, { type: 'prompt', message: 'hello' });
    await vi.advanceTimersByTimeAsync(LOCKED_RETRY_MS[0]);
    await sent;
    await w.pi.last.turn;
    expect(w.pi.last.sent.filter((command) => command.type === 'prompt')).toHaveLength(2);
    expect(w.events.records.some((event) => event.record.success === false)).toBe(false);

    // Refused every time: the last refusal goes out, and the call fails with pi's words.
    w.pi.last.refusals.push(...Array(LOCKED_RETRY_MS.length + 1).fill('ELOCKED: lock held'));
    const refused = w.conversations.request(id, { type: 'prompt', message: 'again' });
    const failure = expect(refused).rejects.toMatchObject({ kind: 'command', message: 'ELOCKED: lock held' });
    await vi.advanceTimersByTimeAsync(LOCKED_RETRY_MS[0] + LOCKED_RETRY_MS[1]);
    await failure;
    expect(w.events.records.filter((event) => event.record.success === false)).toHaveLength(1);
  });

  it('says a host crashed, shows the saved session, and starts it again on the next command', async () => {
    const w = world();
    const draft = await w.conversations.create({ cwd: w.project });
    await turn(w, draft.id, 'hello');
    const id = w.pi.last.session.id;
    w.pi.last.crash();
    expect(w.events.status.at(-1)).toEqual({
      id,
      status: {
        phase: 'failed',
        error: { kind: 'crashed', message: 'The mu host stopped by itself (exit code 1)', stderr: 'boom' },
      },
    });
    await vi.waitFor(() => expect(w.events.replaced.at(-1)?.view.status).not.toBe('working'));
    await expect(w.conversations.open(id)).resolves.toMatchObject({
      seq: 0,
      status: { phase: 'failed' },
      conversation: { live: false },
    });
    await turn(w, id, 'again');
    expect(w.pi.hosts).toHaveLength(2);
    expect(w.events.status.at(-1)).toEqual({ id, status: { phase: 'running' } });
  });

  it('ends a host that is still starting when the conversation is closed', async () => {
    const w = world();
    let open: (() => void) | undefined;
    w.pi.gate = new Promise((resolve) => {
      open = resolve;
    });
    const draft = await w.conversations.create({ cwd: w.project });
    const started = w.conversations.request(draft.id, { type: 'get_state' });
    const failure = expect(started).rejects.toMatchObject({ kind: 'closed' });
    await vi.waitFor(() => expect(w.events.status.at(-1)?.status).toEqual({ phase: 'starting' }));
    const closing = w.conversations.close(draft.id);
    open?.();
    await closing;
    await failure;
    expect(w.pi.hosts).toHaveLength(1);
    expect(w.pi.running).toHaveLength(0);
    expect(w.events.status.at(-1)?.status).toEqual({ phase: 'idle' });
    expect(w.events.changed.at(-1)).toEqual({ conversation: expect.objectContaining({ live: false }) });
  });

  it('says why a host did not start, and stays without one', async () => {
    const w = world();
    w.pi.failStart = new NativeHostError('no-harness', 'No mu harness was found');
    const draft = await w.conversations.create({ cwd: w.project });
    await expect(w.conversations.request(draft.id, { type: 'get_state' })).rejects.toMatchObject({
      kind: 'no-harness',
    });
    expect(w.events.status.map((event) => event.status.phase)).toEqual(['starting', 'idle']);
    expect(w.events.changed.at(-1)).toEqual({ conversation: expect.objectContaining({ id: draft.id, live: false }) });
  });

  it('does not start a host for a session whose project folder is gone, and says so', async () => {
    const w = world();
    const gone = join(w.root, 'deleted-worktree');
    writeSession(join(w.sessionsDir, '--gone--', '2026_gone.jsonl'), [
      header('gone', gone, 1),
      user('g-u', null, 'Old work', 2),
      assistant('g-a', 'g-u', 'Done', 3),
    ]);
    // It opens, from its file.
    await expect(w.conversations.open('gone')).resolves.toMatchObject({ conversation: { id: 'gone', cwd: gone } });
    // A message to it is refused before a host is started: pi's process would stop before it started, saying nothing of
    // why, and another conversation's host would have been ended to make room for it.
    await expect(w.conversations.request('gone', { type: 'prompt', message: 'go on' })).rejects.toMatchObject({
      kind: 'no-folder',
      message: expect.stringContaining(gone),
    });
    expect(w.pi.hosts).toHaveLength(0);
    expect(w.events.status).toEqual([]);
    // The folder comes back, and the conversation runs.
    mkdirSync(gone);
    await w.conversations.request('gone', { type: 'get_state' });
    expect(w.pi.hosts).toHaveLength(1);
  });

  it('takes the model new sessions start on when pi started without one', async () => {
    const w = world();
    writeFileSync(join(w.agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'e2e', defaultModel: 'fake2' }));
    w.pi.model = undefined;
    w.pi.available = [
      { provider: 'e2e', id: 'fake' },
      { provider: 'e2e', id: 'fake2' },
    ];
    const draft = await w.conversations.create({ cwd: w.project });
    await w.conversations.request(draft.id, { type: 'get_state' });
    const id = w.pi.last.session.id;
    await vi.waitFor(() => expect(w.events.status.at(-1)).toEqual({ id, status: { phase: 'running' } }));
    expect(w.events.status.map((event) => event.status.phase)).toEqual(['starting', 'needs-model', 'running']);
    expect(w.pi.last.sent).toContainEqual({ type: 'set_model', provider: 'e2e', modelId: 'fake2' });
  });

  it('answers a dialog, and closes it in the view', async () => {
    const w = world();
    const draft = await w.conversations.create({ cwd: w.project });
    await expect(w.conversations.respond(draft.id, 'd1', { confirmed: true })).rejects.toMatchObject({
      kind: 'closed',
    });
    const asked = w.conversations.request(draft.id, { type: 'prompt', message: '/ask' });
    await vi.waitFor(() => expect(w.events.records.some((event) => event.record.id === 'd1')).toBe(true));
    const id = w.pi.last.session.id;
    await w.conversations.respond(id, 'd1', { confirmed: false });
    await asked;
    expect(w.events.records.map((event) => event.record)).toContainEqual({
      type: 'extension_ui_response',
      id: 'd1',
      confirmed: false,
    });
    await expect(w.conversations.open(id)).resolves.toMatchObject({ view: { dialogs: [] } });
  });

  it('starts mu in the conversation’s permission mode, and again in the one it last switched to', async () => {
    const w = world();
    const draft = await w.conversations.create({ cwd: w.project, permissions: 'jev' });
    await turn(w, draft.id, 'hello');
    expect(w.pi.last.input.env.MU_PERMISSIONS).toBe('jev');
    const id = w.pi.last.session.id;
    await w.conversations.request(id, { type: 'prompt', message: '/permissions ask --here' });
    await w.conversations.close(id);
    await w.conversations.request(id, { type: 'get_state' });
    expect(w.pi.last.input.env.MU_PERMISSIONS).toBe('ask');
  });

  it('removes a conversation with its session file, only from mu’s session folders', async () => {
    const w = world();
    const draft = await w.conversations.create({ cwd: w.project });
    await turn(w, draft.id, 'hello');
    const id = w.pi.last.session.id;
    const file = w.pi.last.session.file;

    w.moveFolders({ agentDir: join(w.root, 'other'), sessionsDir: join(w.root, 'other', 'sessions') });
    await expect(w.conversations.remove(id)).rejects.toMatchObject({ kind: 'invalid' });
    expect(existsSync(file)).toBe(true);
    expect(w.pi.last.disposed).toBe(false);

    w.moveFolders({ agentDir: w.agentDir, sessionsDir: w.sessionsDir });
    await w.conversations.remove(id);
    expect(w.trashed).toEqual([file]);
    expect(w.pi.last.disposed).toBe(true);
    expect(w.events.changed.at(-1)).toEqual({ removed: id });
    await expect(w.conversations.list()).resolves.toEqual([]);
    await expect(w.conversations.open(id)).rejects.toMatchObject({ kind: 'unknown-conversation' });

    const empty = await w.conversations.create({ cwd: w.project });
    await w.conversations.remove(empty.id);
    expect(w.trashed).toHaveLength(1);
  });

  it('ends every host when the app quits, and answers nothing after', async () => {
    const w = world();
    for (const message of ['one', 'two']) {
      // oxlint-disable-next-line no-await-in-loop -- one conversation after another
      const draft = await w.conversations.create({ cwd: w.project });
      // oxlint-disable-next-line no-await-in-loop -- as above
      await turn(w, draft.id, message);
    }
    expect(w.conversations.liveCount).toBe(2);
    await w.conversations.dispose();
    expect(w.pi.running).toHaveLength(0);
    expect(w.conversations.liveCount).toBe(0);
    await expect(w.conversations.list()).rejects.toMatchObject({ kind: 'closed' });
  });
});

/** The end of a run as pi streams it when the model stopped for `stopReason`, with no text: what the view reads. */
function endRun(w: World, stopReason: 'aborted' | 'error'): void {
  const host = w.pi.last;
  const now = Date.now();
  const partial = {
    role: 'assistant',
    content: [],
    provider: 'e2e',
    model: 'fake',
    stopReason: 'stop',
    timestamp: now,
  };
  host.emit({ type: 'agent_start' });
  host.emit({ type: 'message_start', message: partial });
  host.emit({
    type: 'message_end',
    message: { ...partial, stopReason, ...(stopReason === 'error' ? { errorMessage: 'the model said no' } : {}) },
  });
  host.emit({ type: 'agent_settled' });
}

describe('the conversation wants its person (attention)', () => {
  it('says a run ended once a moment passed with nothing following it, with the conversation’s title', async () => {
    vi.useFakeTimers();
    const w = world();
    const draft = await w.conversations.create({ cwd: w.project });
    await turn(w, draft.id, 'hello');
    const id = w.pi.last.session.id;
    await vi.advanceTimersByTimeAsync(ATTENTION_DELAY_MS - 100);
    expect(w.events.attention).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(w.events.attention).toEqual([{ id, kind: 'done', title: 'hello' }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.events.attention).toHaveLength(1);
  });

  it('says nothing for a run another one follows within the moment (a goal’s next step, a queued message)', async () => {
    vi.useFakeTimers();
    const w = world();
    const draft = await w.conversations.create({ cwd: w.project });
    await turn(w, draft.id, 'one');
    const id = w.pi.last.session.id;
    await vi.advanceTimersByTimeAsync(ATTENTION_DELAY_MS - 300);
    await turn(w, id, 'two');
    await vi.advanceTimersByTimeAsync(ATTENTION_DELAY_MS - 300);
    expect(w.events.attention).toEqual([]);
    await vi.advanceTimersByTimeAsync(400);
    expect(w.events.attention).toEqual([{ id, kind: 'done', title: 'one' }]);
  });

  it('says a run failed, and nothing for one the person stopped', async () => {
    vi.useFakeTimers();
    const w = world();
    const draft = await w.conversations.create({ cwd: w.project });
    await turn(w, draft.id, 'hello');
    const id = w.pi.last.session.id;
    await vi.advanceTimersByTimeAsync(ATTENTION_DELAY_MS);
    w.events.attention.length = 0;

    endRun(w, 'aborted');
    await vi.advanceTimersByTimeAsync(ATTENTION_DELAY_MS * 2);
    expect(w.events.attention).toEqual([]);

    endRun(w, 'error');
    await vi.advanceTimersByTimeAsync(ATTENTION_DELAY_MS);
    expect(w.events.attention).toEqual([{ id, kind: 'error', title: 'hello' }]);
  });

  it('says a question the moment pi asks it, in the middle of a run or not', async () => {
    vi.useFakeTimers();
    const w = world();
    const draft = await w.conversations.create({ cwd: w.project });
    const asked = w.conversations.request(draft.id, { type: 'prompt', message: '/ask' });
    await vi.waitFor(() => expect(w.events.records.some((event) => event.record.id === 'd1')).toBe(true));
    const id = w.pi.last.session.id;
    expect(w.events.attention).toEqual([{ id, kind: 'question', title: '' }]);
    await w.conversations.respond(id, 'd1', { confirmed: true });
    await asked;
    // A notice is no question.
    w.pi.last.emit({ type: 'extension_ui_request', id: 'n9', method: 'notify', message: 'FYI' });
    expect(w.events.attention).toHaveLength(1);
  });

  it('says nothing when the host ends before the moment passes', async () => {
    vi.useFakeTimers();
    const w = world();
    const draft = await w.conversations.create({ cwd: w.project });
    await turn(w, draft.id, 'hello');
    const id = w.pi.last.session.id;
    await w.conversations.close(id);
    await vi.advanceTimersByTimeAsync(ATTENTION_DELAY_MS * 2);
    expect(w.events.attention).toEqual([]);
  });

  it('lists a conversation as running while its run goes, and not before or after', async () => {
    const w = world();
    const draft = await w.conversations.create({ cwd: w.project });
    await turn(w, draft.id, 'hello');
    const running = w.events.changed.flatMap((event) =>
      'conversation' in event ? [event.conversation.running === true] : []
    );
    // Not running when the host starts; running once the run starts; not running once it settles.
    expect(running).toContain(true);
    expect(running.lastIndexOf(true)).toBeLessThan(running.length - 1);
    const last = w.events.changed.at(-1);
    expect(last && 'conversation' in last ? last.conversation.running : 'no event').toBeUndefined();
  });
});

describe('the list and the names (milestone 3)', () => {
  /** A session file of the command line's, in the test's project: a question and its answer. */
  const cliSession = (w: World, id: string, text: string, minute = 1): string =>
    writeSession(join(w.sessionsDir, '--project--', `2026_${id}.jsonl`), [
      header(id, w.project, minute),
      user(`${id}-u`, null, text, minute + 1),
      assistant(`${id}-a`, `${id}-u`, 'Hello', minute + 2),
    ]);

  it('leaves out the sessions AionCore’s conversations run, until their record goes', async () => {
    const bound = new Set<string>();
    const w = world({ bound: async () => bound });
    const taken = cliSession(w, 'taken', 'Run by AionCore');
    cliSession(w, 'free', 'Only here', 5);
    bound.add(taken);
    await expect(w.conversations.list()).resolves.toMatchObject([{ id: 'free' }]);
    // Hidden from the list only: it can still be opened by its id.
    await expect(w.conversations.open('taken')).resolves.toMatchObject({ conversation: { id: 'taken' } });
    bound.clear();
    expect((await w.conversations.list()).map((each) => each.id)).toEqual(['free', 'taken']);

    // One a native host runs stays listed.
    bound.add(taken);
    await turn(w, 'taken', 'again');
    expect((await w.conversations.list()).map((each) => each.id)).toEqual(['taken', 'free']);
  });

  it('counts a session’s messages and names the session it was forked from', async () => {
    const w = world();
    const parent = cliSession(w, 'parent', 'The start');
    writeSession(join(w.sessionsDir, '--project--', '2026_fork.jsonl'), [
      { ...header('fork', w.project, 3), parentSession: parent },
      user('f-u', null, 'The start', 4),
    ]);
    const listed = await w.conversations.list();
    expect(listed.find((each) => each.id === 'parent')).toMatchObject({ messageCount: 2 });
    expect(listed.find((each) => each.id === 'parent')?.forkedFrom).toBeUndefined();
    expect(listed.find((each) => each.id === 'fork')).toMatchObject({ messageCount: 1, forkedFrom: parent });

    // A new conversation counts from nothing, as its messages come.
    const draft = await w.conversations.create({ cwd: w.project });
    expect(draft.messageCount).toBe(0);
    await turn(w, draft.id, 'one');
    const id = w.pi.last.session.id;
    expect(w.events.changed.findLast((event) => 'conversation' in event && event.conversation.id === id)).toEqual({
      conversation: expect.objectContaining({ id, messageCount: 2 }),
    });
  });

  it('names a conversation without a host by appending the entry pi writes, which pi then reads', async () => {
    const w = world();
    const file = cliSession(w, 'cli', 'From the command line');
    await w.conversations.list();
    await w.conversations.rename('cli', 'Login work');
    expect(w.pi.hosts).toHaveLength(0);
    const entries = entriesOf(file) as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(3);
    // As pi's SessionManager.appendSessionInfo writes it: on the branch pi opens the file at.
    expect(entries[2]).toEqual({
      type: 'session_info',
      id: expect.stringMatching(/^[0-9a-f]{8}$/),
      parentId: 'cli-a',
      timestamp: expect.any(String),
      name: 'Login work',
    });
    expect(Number.isNaN(Date.parse(entries[2].timestamp as string))).toBe(false);
    expect(w.events.changed.at(-1)).toEqual({
      conversation: expect.objectContaining({ id: 'cli', title: 'Login work', live: false }),
    });
    await expect(w.conversations.list()).resolves.toMatchObject([{ id: 'cli', title: 'Login work' }]);

    // pi resumes the file on its branch, and the name stays.
    await turn(w, 'cli', 'go on');
    expect(w.pi.last.session.leafId).not.toBe(entries[2].id);
    expect(w.pi.last.session.entries.find((entry) => entry.type === 'session_info')).toMatchObject({
      name: 'Login work',
    });
    await expect(w.conversations.list()).resolves.toMatchObject([{ id: 'cli', title: 'Login work' }]);
  });

  it('shows no token in a conversation’s title: not from its first message, not from a name', async () => {
    const w = world();
    const draft = await w.conversations.create({ cwd: w.project });
    await turn(w, draft.id, `ghp_${'A1b2'.repeat(9)} fix this`);
    const id = w.pi.last.session.id;
    expect(w.events.changed.at(-1)).toEqual({
      conversation: expect.objectContaining({ id, title: 'ghp_•••• fix this' }),
    });
    // A name a tool made from that first message says the same as the message did.
    await w.conversations.rename(id, `key sk-ant-api03-${'A1b2'.repeat(9)}`);
    expect(w.events.changed.at(-1)).toEqual({
      conversation: expect.objectContaining({ id, title: 'key sk-ant-••••' }),
    });
  });

  it('names a conversation with a host through pi, and starts one for a draft pi has not written', async () => {
    const w = world();
    const draft = await w.conversations.create({ cwd: w.project });
    await turn(w, draft.id, 'hello');
    const id = w.pi.last.session.id;
    await w.conversations.rename(id, 'Greetings');
    expect(w.pi.last.sent.at(-1)).toEqual({ type: 'set_session_name', name: 'Greetings' });
    expect(w.pi.hosts).toHaveLength(1);
    expect(w.events.changed.at(-1)).toEqual({ conversation: expect.objectContaining({ id, title: 'Greetings' }) });

    const empty = await w.conversations.create({ cwd: w.project });
    await w.conversations.rename(empty.id, 'Later');
    expect(w.pi.hosts).toHaveLength(2);
    expect(w.pi.last.sent.at(-1)).toEqual({ type: 'set_session_name', name: 'Later' });
    await expect(w.conversations.open(empty.id)).resolves.toMatchObject({ conversation: { title: 'Later' } });
  });
});
