import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KyrnError } from '@/common/kyrn/errors';
import { FOLDER_LISTING_LIMIT, FOLDER_SCRIPTS_LIMIT } from '@/common/kyrn/folderBridge';
import { findFiles, folderScripts, listFolder, readFolder } from '@/process/agent/kyrn/folderFiles';
import { GitNotStarted, type GitRunner } from '@/process/services/folderGit/runGit';
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

/** git in a folder outside any repository, and no git at all. */
const notRepository: GitRunner = async () => ({
  code: 128,
  stdout: '',
  stderr: 'not a git repository',
  overflow: false,
});
const noGit: GitRunner = async () => {
  throw new GitNotStarted('spawn git ENOENT');
};
/** git listing more than it may write: cut in the middle of a name. */
const cutShort: GitRunner = async () => ({ code: 0, stdout: 'a.ts\0b.ts\0c.t', stderr: '', overflow: true });

describe('a folder’s files for quick open', () => {
  it('are git’s own list in a repository: tracked and new, never what it ignores', async () => {
    const asked: string[][] = [];
    const git: GitRunner = async (args) => {
      asked.push(args);
      return { code: 0, stdout: 'src/a.ts\0README.md\0src/new.ts\0', stderr: '', overflow: false };
    };
    expect(await findFiles('/work/app', git)).toEqual({ paths: ['src/a.ts', 'README.md', 'src/new.ts'], more: false });
    expect(asked).toEqual([['ls-files', '--cached', '--others', '--exclude-standard', '-z']]);
  });

  it('drops the name a cut list ends in, and says some were left out', async () => {
    expect(await findFiles('/work/app', cutShort)).toEqual({ paths: ['a.ts', 'b.ts'], more: true });
  });

  it('walks the folder outside a repository, or without git: no dot folders, dependencies or build output', async () => {
    const folder = temp();
    for (const dir of ['src/deep', '.cache', 'node_modules/pkg', 'dist'])
      mkdirSync(join(folder, dir), { recursive: true });
    writeFileSync(join(folder, 'README.md'), '');
    writeFileSync(join(folder, '.env'), '');
    writeFileSync(join(folder, '.DS_Store'), '');
    writeFileSync(join(folder, 'src', 'a.ts'), '');
    writeFileSync(join(folder, 'src', 'deep', 'b.ts'), '');
    writeFileSync(join(folder, '.cache', 'x'), '');
    writeFileSync(join(folder, 'node_modules', 'pkg', 'index.js'), '');
    writeFileSync(join(folder, 'dist', 'out.js'), '');
    const found = await Promise.all([notRepository, noGit, undefined].map((git) => findFiles(folder, git)));
    for (const { paths, more } of found) {
      expect(more).toBe(false);
      expect(paths.toSorted()).toEqual(['.env', 'README.md', 'src/a.ts', 'src/deep/b.ts']);
    }
  });
});

describe('a folder’s scripts for the send box’s Run', () => {
  const manifest = (dir: string, value: unknown) =>
    writeFileSync(join(dir, 'package.json'), typeof value === 'string' ? value : JSON.stringify(value));

  it('lists package.json’s scripts in its order, with npm when nothing names another runner', async () => {
    const dir = temp();
    manifest(dir, { scripts: { dev: 'vite', test: 'vitest --run', 'test:e2e': 'playwright test', empty: '  ' } });
    expect(await folderScripts(dir)).toEqual({
      runner: 'npm',
      scripts: [
        { name: 'dev', command: 'vite' },
        { name: 'test', command: 'vitest --run' },
        { name: 'test:e2e', command: 'playwright test' },
      ],
      more: 0,
    });
  });

  it('runs them with packageManager’s runner, else the lockfile’s', async () => {
    const dir = temp();
    manifest(dir, { scripts: { build: 'tsc' } });
    writeFileSync(join(dir, 'yarn.lock'), '');
    expect((await folderScripts(dir))?.runner).toBe('yarn');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    expect((await folderScripts(dir))?.runner).toBe('pnpm');
    writeFileSync(join(dir, 'bun.lock'), '');
    expect((await folderScripts(dir))?.runner).toBe('bun');
    manifest(dir, { packageManager: 'yarn@4.5.0', scripts: { build: 'tsc' } });
    expect((await folderScripts(dir))?.runner).toBe('yarn');
  });

  it('leaves out a name a shell would need quoted, and counts what it left out', async () => {
    const dir = temp();
    const many = Object.fromEntries(Array.from({ length: FOLDER_SCRIPTS_LIMIT + 2 }, (_, i) => [`s${i}`, 'true']));
    manifest(dir, { scripts: { 'two words': 'true', '-flag': 'true', '@scope': 'true', 'a;b': 'true', ...many } });
    const read = await folderScripts(dir);
    expect(read?.scripts).toHaveLength(FOLDER_SCRIPTS_LIMIT);
    expect(read?.scripts[0]).toEqual({ name: 's0', command: 'true' });
    expect(read?.more).toBe(6);
  });

  it('offers none without a package.json, scripts, or JSON that parses', async () => {
    const dir = temp();
    expect(await folderScripts(dir)).toBeNull();
    manifest(dir, { name: 'app' });
    expect(await folderScripts(dir)).toBeNull();
    manifest(dir, { scripts: ['build'] });
    expect(await folderScripts(dir)).toBeNull();
    manifest(dir, '{ "scripts": ');
    expect(await folderScripts(dir)).toBeNull();
    manifest(dir, 'null');
    expect(await folderScripts(dir)).toBeNull();
  });
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
