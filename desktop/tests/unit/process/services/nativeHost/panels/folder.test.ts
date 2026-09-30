import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KyrnError } from '@/common/kyrn/errors';
import { FOLDER_LISTING_LIMIT } from '@/common/kyrn/folderBridge';
import { listFolder, readFolder } from '@/process/agent/kyrn/folderFiles';
import { lessonsProject, LessonsStore } from '@/process/agent/kyrn/lessons';
import { canSymlink } from '../symlinks.ts';

const linking = canSymlink();

/**
 * What a native conversation's work panel reads by its folder (common/kyrn/folderBridge.ts): the folder's lessons, as
 * the lessons tab reads them for an app conversation's workspace, and the folder's files, one directory at a time.
 */

const dirs: string[] = [];
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mu-folder-')));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const code = (work: () => unknown): string | undefined => {
  try {
    work();
  } catch (error) {
    return error instanceof KyrnError ? error.code : 'other';
  }
  return undefined;
};

describe('a folder as the screen names it', () => {
  it('is a full path on one line', () => {
    expect(readFolder('/work/app')).toBe('/work/app');
    for (const bad of ['', 'work/app', '/work\napp', '/work\u0000app', 42, undefined, `/${'x'.repeat(5000)}`])
      expect(code(() => readFolder(bad))).toBe('invalid');
  });
});

describe('a folder’s files', () => {
  it('lists one directory, folders first, each by name, without git’s folder', async () => {
    const folder = temp();
    mkdirSync(join(folder, 'notes'));
    mkdirSync(join(folder, '.git'));
    mkdirSync(join(folder, 'src'));
    writeFileSync(join(folder, 'README.md'), '# app\n');
    writeFileSync(join(folder, 'file10.txt'), '');
    writeFileSync(join(folder, 'file2.txt'), '');
    writeFileSync(join(folder, 'notes', 'hello.txt'), 'hi\n');
    const root = await listFolder(folder, '');
    expect(root).toEqual({
      path: '',
      more: 0,
      entries: [
        { name: 'notes', path: 'notes', kind: 'dir' },
        { name: 'src', path: 'src', kind: 'dir' },
        { name: 'file2.txt', path: 'file2.txt', kind: 'file' },
        { name: 'file10.txt', path: 'file10.txt', kind: 'file' },
        { name: 'README.md', path: 'README.md', kind: 'file' },
      ],
    });
    expect(await listFolder(folder, 'notes')).toEqual({
      path: 'notes',
      more: 0,
      entries: [{ name: 'hello.txt', path: 'notes/hello.txt', kind: 'file' }],
    });
  });

  it.skipIf(!linking)('takes a link as what it points to, and a broken one as a file', async () => {
    const folder = temp();
    const elsewhere = temp();
    symlinkSync(elsewhere, join(folder, 'linked'));
    symlinkSync(join(folder, 'gone'), join(folder, 'broken'));
    expect((await listFolder(folder, '')).entries).toEqual([
      { name: 'linked', path: 'linked', kind: 'dir' },
      { name: 'broken', path: 'broken', kind: 'file' },
    ]);
  });

  it('never reads above the folder, and names a directory it cannot read', async () => {
    const folder = temp();
    await Promise.all(
      ['..', '../x', 'a/../../x', 42].map((path) =>
        expect(listFolder(folder, path)).rejects.toMatchObject({ code: 'invalid' })
      )
    );
    // A name that starts with two dots is inside.
    mkdirSync(join(folder, '..notes'));
    expect((await listFolder(folder, '..notes')).path).toBe('..notes');
    await expect(listFolder(folder, 'missing')).rejects.toMatchObject({ code: 'unreadable' });
  });

  it('carries at most the limit, and counts the rest', async () => {
    const folder = temp();
    for (let index = 0; index < FOLDER_LISTING_LIMIT + 5; index += 1) writeFileSync(join(folder, `f${index}`), '');
    const listing = await listFolder(folder, '');
    expect(listing.entries).toHaveLength(FOLDER_LISTING_LIMIT);
    expect(listing.more).toBe(5);
  });
});

const line = (id: string, cwd?: string) => ({
  id,
  kind: 'correction',
  trigger: `when ${id} comes up`,
  lesson: `Do ${id}.`,
  scope: cwd === undefined ? {} : { cwd },
  source: { origin: 'user' },
  status: 'active',
  uses: { recalled: 0, applied: 0 },
  created: '2026-09-29T08:00:00.000Z',
  updated: '2026-09-29T08:00:00.000Z',
});

describe('a folder’s lessons', () => {
  it.skipIf(!linking)(
    'are the folder’s own, by its real path too, and those for everywhere; a change is one line more',
    () => {
      const agentDir = temp();
      const real = temp();
      const linked = join(temp(), 'project');
      symlinkSync(real, linked);
      const file = join(agentDir, 'mu', 'lessons.jsonl');
      mkdirSync(join(agentDir, 'mu'));
      writeFileSync(
        file,
        `${[line('own', real), line('other', '/work/other'), line('everywhere')].map((each) => JSON.stringify(each)).join('\n')}\n`
      );
      const store = new LessonsStore(agentDir);
      // The screen names the folder as the conversation has it: a link to the folder mu wrote the lesson in.
      const project = lessonsProject(join(agentDir, 'acp-sessions'), '', linked);
      expect(project).toEqual({ folder: real, places: [real, linked] });
      expect(store.view(project).lessons.map((lesson) => lesson.id)).toEqual(['own', 'everywhere']);
      const after = store.change(project, { id: 'own', action: 'retire' }, new Date('2026-09-29T09:00:00.000Z'));
      expect(after.lessons.find((lesson) => lesson.id === 'own')?.status).toBe('retired');
      expect(readFileSync(file, 'utf8').trim().split('\n').at(-1)).toBe(
        JSON.stringify({ id: 'own', status: 'retired', updated: '2026-09-29T09:00:00.000Z' })
      );
      expect(() => store.change(project, { id: 'other', action: 'retire' })).toThrow('No such lesson in this project');
    }
  );
});
