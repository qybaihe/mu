import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NativeConversation } from '@/common/kyrn/nativeBridge';
import { KyrnError } from '@/common/kyrn/errors';
import { repoRoots, ROOTS_LIMIT } from '@/process/services/folderGit/repoRoots';
import { folderKey, groupProjects, projectFolder, within } from '@/renderer/pages/native/sider/projects';

/**
 * The sidebar's projects: the repository each conversation's folder is in, found on the disk by the main process
 * (process/services/folderGit/repoRoots.ts), and how the conversations group by it and by the folders the person added
 * (renderer/pages/native/sider/projects.ts).
 */

const dirs: string[] = [];
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mu-roots-')));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('repoRoots', () => {
  it('finds the nearest folder up that holds a .git: a repository, a worktree, a nested one', async () => {
    const top = temp();
    const repo = join(top, 'mu');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'packages', 'app'), { recursive: true });
    // A worktree's .git is a file; a submodule's too.
    const worktree = join(top, 'mu-wt');
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, '.git'), 'gitdir: ../mu/.git/worktrees/mu-wt\n');
    const nested = join(repo, 'vendor', 'lib');
    mkdirSync(join(nested, '.git'), { recursive: true });
    const loose = join(top, 'notes');
    mkdirSync(loose);
    const gone = join(repo, 'deleted', 'folder');

    expect(
      await repoRoots([repo, join(repo, 'packages', 'app'), join(worktree, 'src'), join(nested, 'src'), loose, gone])
    ).toEqual({
      [repo]: repo,
      [join(repo, 'packages', 'app')]: repo,
      [join(worktree, 'src')]: worktree,
      [join(nested, 'src')]: nested,
      // A folder that is gone is still in the repository it was in.
      [gone]: repo,
    });
  });

  it('looks at each folder once, and leaves out what is not a full path', async () => {
    // Paths as this platform resolves them (a drive on Windows).
    const mu = resolve('/work/mu');
    const seen: string[] = [];
    const roots = await repoRoots(
      ['/work/mu/a', '/work/mu/b', '/work/mu/a', 'relative/path', 7, '', '/x\n/y'],
      async (dir) => {
        seen.push(dir);
        return dir === mu;
      }
    );
    expect(roots).toEqual({ '/work/mu/a': mu, '/work/mu/b': mu });
    expect(seen.toSorted()).toEqual([mu, resolve('/work/mu/a'), resolve('/work/mu/b')]);
  });

  it('refuses anything but a list, and looks up at most ROOTS_LIMIT folders', async () => {
    await expect(repoRoots('/work')).rejects.toBeInstanceOf(KyrnError);
    const many = Array.from({ length: ROOTS_LIMIT + 5 }, (_, index) => `/work/repo/f${index}`);
    const roots = await repoRoots(many, async (dir) => dir === resolve('/work/repo'));
    expect(Object.keys(roots)).toHaveLength(ROOTS_LIMIT);
  });
});

const conversation = (id: string, cwd: string, updatedAt: number): NativeConversation => ({
  id,
  cwd,
  title: id,
  createdAt: updatedAt,
  updatedAt,
  live: false,
});

describe('the sidebar’s projects', () => {
  it('compares folders without a separator at the end, Windows ones in one case', () => {
    expect(folderKey('/work/mu/')).toBe('/work/mu');
    expect(folderKey('/')).toBe('/');
    expect(folderKey('C:\\Work\\Mu\\')).toBe('c:/work/mu');
    expect(folderKey('C:\\')).toBe('c:/');
    expect(within('/work/mu/app', '/work/mu')).toBe(true);
    expect(within('/work/mu', '/work/mu/')).toBe(true);
    expect(within('/work/mu-wt', '/work/mu')).toBe(false);
    expect(within('/anything', '/')).toBe(true);
    expect(within('c:\\work\\MU\\app', 'C:\\Work\\mu')).toBe(true);
  });

  it('puts a conversation in the deepest of the added folders and the repositories that holds its folder', () => {
    expect(projectFolder('/work/mu/packages/app', ['/work/mu'])).toBe('/work/mu');
    // Added above the repository: the repository is deeper.
    expect(projectFolder('/work/mu/packages/app', ['/work', '/work/mu'])).toBe('/work/mu');
    // Added inside it: the added folder is.
    expect(projectFolder('/work/mu/docs/site', ['/work/mu/docs', '/work/mu'])).toBe('/work/mu/docs');
    // A repository nested in another holds its own folders.
    expect(projectFolder('/work/mu/vendor/lib/src', ['/work/mu', '/work/mu/vendor/lib'])).toBe('/work/mu/vendor/lib');
    // In no repository: under an added folder, or a project of its own.
    expect(projectFolder('/work/scratch/a', ['/work/scratch'])).toBe('/work/scratch');
    expect(projectFolder('/work/scratch/a', ['/elsewhere', '/work/mu'])).toBe('/work/scratch/a');
  });

  it('groups the conversations, newest first in each, the project changed last first; an added one shows empty', () => {
    // `/work/mu/docs` is not looked up yet: it is in a repository the list knows, so it goes there already.
    const roots = new Map([
      ['/work/mu', '/work/mu'],
      ['/work/mu/packages/app', '/work/mu'],
    ]);
    const projects = groupProjects(
      [
        conversation('c', '/work/mu/packages/app', 5),
        conversation('b', '/work/notes', 4),
        conversation('d', '/work/mu/docs', 3),
        conversation('a', '/work/mu', 2),
      ],
      [
        { folder: '/work/empty', addedAt: 3 },
        { folder: '/work/notes/', addedAt: 1 },
      ],
      roots
    );
    expect(
      projects.map((project) => [project.folder, project.conversations.map((each) => each.id), project.time])
    ).toEqual([
      ['/work/mu', ['c', 'd', 'a'], 5],
      // As it was added: the conversation's folder is the same one.
      ['/work/notes/', ['b'], 4],
      ['/work/empty', [], 3],
    ]);
  });
});
