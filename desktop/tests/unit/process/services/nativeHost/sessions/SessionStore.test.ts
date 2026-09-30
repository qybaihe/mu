import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionFolders } from '../../../../../../packages/desktop/src/process/services/nativeHost/sessions/folders.ts';
import { SessionStore } from '../../../../../../packages/desktop/src/process/services/nativeHost/sessions/SessionStore.ts';
import { TITLE_LENGTH } from '../../../../../../packages/desktop/src/process/services/nativeHost/sessions/summary.ts';
import { appendSession, assistant, at, header, info, system, toolOutput, user, writeSession } from './sessionFiles.ts';

/**
 * The conversation list from pi's session files: what each file says (id, project, title, times), newest first, the
 * command line's sessions and a configured folder's included, and how little of each file is read again.
 */

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mu-session-store-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let worlds = 0;
function world(): { folders: SessionFolders; store: SessionStore; project: (name: string) => string } {
  const agentDir = join(root, `world-${++worlds}`, 'agent');
  const folders: SessionFolders = { agentDir, sessionsDir: join(agentDir, 'sessions') };
  mkdirSync(folders.sessionsDir, { recursive: true });
  return {
    folders,
    store: new SessionStore(() => folders),
    project: (name) => join(folders.sessionsDir, `--${name}--`),
  };
}

describe('SessionStore', () => {
  it('lists every project’s sessions, newest first, titled by name, else first message, else nothing', async () => {
    const { store, project } = world();
    const named = writeSession(join(project('a'), '2026-09-29T12-00_s1.jsonl'), [
      header('s1', '/a'),
      user('u1', null, 'Fix the login page', 1),
      assistant('a1', 'u1', 'Done.', 2),
      info('i1', 'a1', 'Login work', 3),
    ]);
    const plain = writeSession(join(project('b'), '2026-09-29T12-05_s2.jsonl'), [
      header('s2', '/b', 5),
      user('u2', null, '  \n  Why does\tthe build   fail?\nIt says ENOENT', 6),
      assistant('a2', 'u2', 'Because…', 30),
    ]);
    const empty = writeSession(join(project('b'), '2026-09-29T12-10_s3.jsonl'), [header('s3', '/b', 10)]);
    // Not sessions: another file type, a file whose first line is no session header, a broken first line.
    writeFileSync(join(project('a'), 'notes.txt'), 'hello');
    writeSession(join(project('a'), 'x.jsonl'), [user('u9', null, 'no header', 1)]);
    mkdirSync(project('c'), { recursive: true });
    writeFileSync(join(project('c'), 'broken.jsonl'), '{"type":"sess');

    const listed = await store.list();
    expect(listed.map((session) => [session.id, session.title])).toEqual([
      ['s2', 'Why does the build fail?'],
      ['s3', ''],
      ['s1', 'Login work'],
    ]);
    expect(listed[0]).toEqual({
      id: 's2',
      cwd: '/b',
      file: plain,
      title: 'Why does the build fail?',
      firstText: 'Why does the build fail?',
      createdAt: at(5),
      updatedAt: at(30),
      messageCount: 2,
    });
    expect(listed[2]).toMatchObject({ id: 's1', file: named, name: 'Login work', createdAt: at(0), updatedAt: at(2) });
    // No message: last active when it began, as pi's list has it.
    expect(listed[1]).toMatchObject({ id: 's3', file: empty, updatedAt: at(10) });
  });

  it('reads a session mu wrote: the recorded conversation', async () => {
    const { store, project } = world();
    const file = join(project('tmp-mu-fixture-project'), '2026-09-29T12-44-12-067Z_01a0ed31.jsonl');
    mkdirSync(project('tmp-mu-fixture-project'), { recursive: true });
    copyFileSync(join(__dirname, '..', 'fixtures', 'conversation.session.jsonl'), file);
    await expect(store.list()).resolves.toEqual([
      {
        id: '01a0ed31-b1a2-73ba-a0a7-e281fbe1b9ff',
        cwd: '/tmp/mu-fixture/project',
        file,
        title: 'E2E:PLAIN',
        firstText: 'E2E:PLAIN',
        createdAt: Date.parse('2026-09-29T12:44:12.067Z'),
        updatedAt: expect.any(Number),
        messageCount: 21,
      },
    ]);
  });

  it('includes the folder the configuration names, with its sessions side by side', async () => {
    const { folders, store } = world();
    folders.customDir = join(root, `flat-${worlds}`);
    writeSession(join(folders.customDir, '2026_s1.jsonl'), [header('s1', '/p'), user('u', null, 'flat', 1)]);
    await expect(store.list()).resolves.toMatchObject([{ id: 's1', title: 'flat' }]);
  });

  it('clips a long first message, and clears a name an empty one replaced', async () => {
    const { store, project } = world();
    writeSession(join(project('p'), '1_s1.jsonl'), [
      header('s1', '/p'),
      user('u1', null, 'é'.repeat(TITLE_LENGTH + 20), 1),
      info('i1', 'u1', 'Named once', 2),
      info('i2', 'i1', '   ', 3),
    ]);
    const [session] = await store.list();
    expect(session.title).toBe('é'.repeat(TITLE_LENGTH));
    expect(session.name).toBeUndefined();
  });

  it('titles a conversation by the person’s own words: a host preamble and attached files are left out, a token is masked', async () => {
    const { store, project } = world();
    const rules = '[Assistant Rules]\n## Available Skills\n\n- **cron**: Scheduled\n[/Assistant Rules]\n\n';
    writeSession(join(project('p'), '1_s1.jsonl'), [
      header('s1', '/p', 1),
      user('u1', null, `${rules}Refactor the parser`, 1),
    ]);
    writeSession(join(project('p'), '2_s2.jsonl'), [
      header('s2', '/p', 2),
      user('u2', null, '@"/Users/a b/report.pdf" summarize it', 2),
    ]);
    writeSession(join(project('p'), '3_s3.jsonl'), [
      header('s3', '/p', 3),
      user('u3', null, `ghp\\_${'A1b2'.repeat(9)} 新pr`, 3),
    ]);
    const listed = await store.list();
    expect(listed.map((session) => [session.id, session.title])).toEqual([
      ['s3', 'ghp\\_•••• 新pr'],
      ['s2', 'summarize it'],
      ['s1', 'Refactor the parser'],
    ]);
  });

  it('masks a token in a name too: a tool names a session from its first message, which may be a pasted key', async () => {
    const { store, project } = world();
    writeSession(join(project('p'), '1_s1.jsonl'), [
      header('s1', '/p', 1),
      user('u1', null, `sk-${'A1b2'.repeat(9)}`, 1),
      info('i1', 'u1', `sk-${'A1b2'.repeat(9)}`, 2),
    ]);
    const [session] = await store.list();
    expect(session.title).toBe('sk-••••');
    // The name itself is what the file says: only what is shown is masked.
    expect(session.name).toBe(`sk-${'A1b2'.repeat(9)}`);
  });

  it('reads a large file’s start up to its first message and its end, not its middle', async () => {
    const { store, project } = world();
    const file = writeSession(join(project('p'), '1_big.jsonl'), [
      header('big', '/p'),
      // A system prompt larger than one chunk comes before the first message.
      system('sys', null, 150_000),
      user('u1', 'sys', 'The first question', 1),
      info('i-middle', 'u1', 'Named in the middle', 2),
      toolOutput('t1', 'i-middle', 600_000, 3),
      toolOutput('t2', 't1', 600_000, 4),
      assistant('a1', 't2', 'The last answer', 40),
    ]);
    expect(statSync(file).size).toBeGreaterThan(1_300_000);
    // The name sits far from both ends: this read does not see it.
    await expect(store.list()).resolves.toMatchObject([{ id: 'big', title: 'The first question', updatedAt: at(40) }]);
    // Nor the messages in the middle: the count is not known.
    expect((await store.list())[0].messageCount).toBeUndefined();
    // A name at the end is seen, and then kept as the file grows.
    appendSession(file, [info('i-end', 'a1', 'Named at the end', 41)]);
    await expect(store.list()).resolves.toMatchObject([
      { id: 'big', title: 'Named at the end', name: 'Named at the end' },
    ]);
    appendSession(file, [user('u2', 'i-end', 'Another question', 50)]);
    await expect(store.list()).resolves.toMatchObject([{ id: 'big', title: 'Named at the end', updatedAt: at(50) }]);
  });

  it('reads only what a file gained, and a file written anew from its start', async () => {
    const { store, project } = world();
    const file = writeSession(join(project('p'), '1_s1.jsonl'), [header('s1', '/p'), user('u1', null, 'first', 1)]);
    await expect(store.list()).resolves.toMatchObject([{ title: 'first', updatedAt: at(1), messageCount: 1 }]);
    appendSession(file, [assistant('a1', 'u1', 'answer', 5), info('i1', 'a1', 'Renamed', 6)]);
    // Counted on from where the last read stopped: every message entry, as pi's own list counts them.
    await expect(store.list()).resolves.toMatchObject([{ title: 'Renamed', updatedAt: at(5), messageCount: 2 }]);
    // Written anew, shorter: read again from the start.
    writeSession(file, [header('s1', '/p'), user('u1', null, 'rewritten', 7)]);
    await expect(store.list()).resolves.toMatchObject([{ title: 'rewritten', updatedAt: at(7) }]);
  });

  it('keeps what it read while a file keeps its size and time', async () => {
    const { store, project } = world();
    const file = writeSession(join(project('p'), '1_s1.jsonl'), [header('s1', '/p'), user('u1', null, 'aaaa', 1)]);
    // A whole second, which every file system keeps exactly.
    const second = 1_790_000_000;
    utimesSync(file, second, second);
    await expect(store.list()).resolves.toMatchObject([{ title: 'aaaa' }]);
    writeSession(file, [header('s1', '/p'), user('u1', null, 'bbbb', 1)]);
    utimesSync(file, second, second);
    // Same size, same time: not read again.
    await expect(store.list()).resolves.toMatchObject([{ title: 'aaaa' }]);
  });

  it('leaves out a last line pi is still writing, and reads it once it is whole', async () => {
    const { store, project } = world();
    const file = writeSession(join(project('p'), '1_s1.jsonl'), [header('s1', '/p'), user('u1', null, 'first', 1)]);
    const next = JSON.stringify(info('i1', 'u1', 'Half written', 2));
    appendFileSync(file, next.slice(0, 20));
    await expect(store.list()).resolves.toMatchObject([{ title: 'first' }]);
    appendFileSync(file, `${next.slice(20)}\n`);
    await expect(store.list()).resolves.toMatchObject([{ title: 'Half written' }]);
  });

  it('finds a session by its id, listing again for one it has not seen yet', async () => {
    const { store, project } = world();
    writeSession(join(project('p'), '1_s1.jsonl'), [header('s1', '/p'), user('u1', null, 'one', 1)]);
    await store.list();
    const later = writeSession(join(project('q'), '2_s2.jsonl'), [header('s2', '/q'), user('u2', null, 'two', 2)]);
    await expect(store.find('s2')).resolves.toMatchObject({ id: 's2', file: later, cwd: '/q' });
    await expect(store.find('nope')).resolves.toBeUndefined();
    await expect(store.describe(join(project('p'), 'gone.jsonl'))).resolves.toBeUndefined();
  });

  it('says which session a fork or a clone came from', async () => {
    const { store, project } = world();
    const parent = writeSession(join(project('p'), '1_s1.jsonl'), [header('s1', '/p'), user('u1', null, 'one', 1)]);
    writeSession(join(project('p'), '2_s2.jsonl'), [
      { ...header('s2', '/p', 2), parentSession: parent },
      user('u1', null, 'one', 1),
      toolOutput('t1', 'u1', 10, 2),
    ]);
    const listed = await store.list();
    expect(listed.find((session) => session.id === 's2')).toMatchObject({ parentSession: parent, messageCount: 2 });
    expect(listed.find((session) => session.id === 's1')?.parentSession).toBeUndefined();
  });

  it('lists nothing when mu has no sessions yet', async () => {
    const store = new SessionStore(() => ({
      agentDir: join(root, 'none'),
      sessionsDir: join(root, 'none', 'sessions'),
    }));
    await expect(store.list()).resolves.toEqual([]);
  });
});
