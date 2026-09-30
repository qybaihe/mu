import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KyrnError } from '@/common/kyrn/errors';
import type { FolderGitStatus } from '@/common/kyrn/gitBridge';
import { createFolderGit } from '@/process/services/folderGit';
import { parseStatus } from '@/process/services/folderGit/parseStatus';
import { GitNotStarted, gitEnv, gitRunner } from '@/process/services/folderGit/runGit';

/**
 * The 源码 tab of a native conversation reads its folder's repository through the main process
 * (common/kyrn/gitBridge.ts). These run the git this test's PATH finds on repositories made here, with a home of
 * their own (no global git config is read or written).
 */

const dirs: string[] = [];
const temp = (prefix = 'mu-git-'): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let home = '';
const env = () => ({ ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' });

/** Whether a git runs here: the Xcode stub without its licence accepted does not. */
const working = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
if (!working) console.warn('[git.test] no working git on PATH: the repository tests are skipped');

/** Runs git as a person would in `dir`: their name and address given on the line, no signing. */
const git = (dir: string, ...args: string[]): string =>
  execFileSync(
    'git',
    ['-c', 'user.name=mu test', '-c', 'user.email=test@mu.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, env: env(), encoding: 'utf8' }
  );

/** A repository on `main` with README.md, a.txt, b.txt and `c d.txt` committed. */
const repository = (): string => {
  const dir = temp();
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# app\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  writeFileSync(join(dir, 'b.txt'), 'bee\n');
  writeFileSync(join(dir, 'c d.txt'), 'sea\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
};

const folderGit = (options: { changeLimit?: number; diffLimit?: number } = {}) =>
  createFolderGit({ run: gitRunner({ env: env() }), ...options });

type Repository = Extract<FolderGitStatus, { state: 'repository' }>;
const readRepository = async (dir: string, options?: { changeLimit?: number }): Promise<Repository> => {
  const status = await folderGit(options).status(dir);
  if (status.state !== 'repository') throw new Error(`not read as a repository: ${JSON.stringify(status)}`);
  return status;
};

const failure = async (work: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await work();
  } catch (error) {
    return error instanceof KyrnError ? error.code : 'other';
  }
  return undefined;
};

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'mu-git-home-')));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('git’s environment', () => {
  it('leaves out what would point git elsewhere, and takes no optional lock', () => {
    const made = gitEnv({ PATH: '/bin', GIT_DIR: '/elsewhere/.git', GIT_WORK_TREE: '/elsewhere', git_index_file: 'x' });
    expect(made).toMatchObject({ PATH: '/bin', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' });
    expect(made.GIT_DIR).toBeUndefined();
    expect(made.GIT_WORK_TREE).toBeUndefined();
    expect(made.git_index_file).toBeUndefined();
  });
});

describe('git’s status output', () => {
  it('leaves out a record the cut split, and a rename whose old path was cut', () => {
    const whole = '# branch.head main\0? one.txt\0? two.txt\0';
    expect(parseStatus(whole).changes.map((change) => change.path)).toEqual(['one.txt', 'two.txt']);
    expect(parseStatus('# branch.head main\0? one.txt\0? tw', false).changes.map((change) => change.path)).toEqual([
      'one.txt',
    ]);
    const rename = '2 R. N... 100644 100644 100644 aaaa bbbb R100 new.txt\0old';
    expect(parseStatus(`? one.txt\0${rename}`, false).changes.map((change) => change.path)).toEqual(['one.txt']);
  });
});

describe('when git cannot run', () => {
  it('says so, with what the system said, when there is no git', async () => {
    const empty = temp();
    const status = await createFolderGit({ run: gitRunner({ env: { PATH: empty } }) }).status(empty);
    expect(status.state).toBe('no-git');
    expect(status.state === 'no-git' && status.reason).toMatch(/ENOENT/);
  });

  it.skipIf(process.platform === 'win32')(
    'says so, with git’s first line, when git fails before it does anything',
    async () => {
      // The Xcode stub without its licence accepted: every command, --version too, ends with 69 and a notice.
      const bin = temp();
      writeFileSync(
        join(bin, 'git'),
        '#!/bin/sh\necho "You have not agreed to the Xcode license agreements." >&2\nexit 69\n'
      );
      chmodSync(join(bin, 'git'), 0o755);
      const status = await createFolderGit({ run: gitRunner({ command: join(bin, 'git') }) }).status(bin);
      expect(status).toEqual({ state: 'no-git', reason: 'You have not agreed to the Xcode license agreements.' });
    }
  );

  it.skipIf(!working)('looks git up on the PATH the app has when it runs, not the one it had when made', async () => {
    // The bridges are made before fixPath() gives the main process the login shell's PATH.
    const saved = process.env.PATH;
    const empty = temp();
    let run;
    try {
      process.env.PATH = empty;
      run = gitRunner();
      await expect(run(['--version'], { cwd: empty, timeoutMs: 5_000, maxBytes: 4096 })).rejects.toBeInstanceOf(
        GitNotStarted
      );
    } finally {
      process.env.PATH = saved;
    }
    expect((await run(['--version'], { cwd: empty, timeoutMs: 5_000, maxBytes: 4096 })).code).toBe(0);
  });

  it('fails plainly for a folder that is gone, and refuses one that is not a full path', async () => {
    const gone = join(temp(), 'gone');
    expect(await failure(() => createFolderGit().status(gone))).toBe('unreadable');
    const refused = await Promise.all(
      ['', 'work/app', '/work\napp', 42, undefined].map((bad) => failure(() => createFolderGit().status(bad)))
    );
    expect(refused).toEqual(Array(5).fill('invalid'));
  });
});

describe.skipIf(!working)('a folder’s repository', () => {
  it('names a folder in no repository', async () => {
    expect(await folderGit().status(temp())).toEqual({ state: 'not-repository' });
  });

  it('reads a clean repository: its branch and no changes', async () => {
    const dir = repository();
    const status = await readRepository(dir);
    expect(status).toMatchObject({ root: dir, changes: [], more: 0, truncated: false });
    expect(status.branch.name).toBe('main');
    expect(status.branch.commit).toMatch(/^[0-9a-f]{7}$/);
  });

  it('lists the changes by area, a file changed on both sides twice, paths as they are', async () => {
    const dir = repository();
    git(dir, 'mv', 'b.txt', 'b2.txt');
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
    git(dir, 'add', 'a.txt');
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    rmSync(join(dir, 'c d.txt'));
    mkdirSync(join(dir, 'notes'));
    writeFileSync(join(dir, 'notes', 'hello.txt'), 'hi\n');
    writeFileSync(join(dir, '中文 名.txt'), 'x\n');
    writeFileSync(join(dir, 'staged.txt'), 'new\n');
    git(dir, 'add', 'staged.txt');
    const { changes } = await readRepository(dir);
    expect(changes).toEqual(
      expect.arrayContaining([
        { path: 'a.txt', area: 'staged', kind: 'modified' },
        { path: 'a.txt', area: 'unstaged', kind: 'modified' },
        { path: 'b2.txt', area: 'staged', kind: 'renamed', from: 'b.txt' },
        { path: 'c d.txt', area: 'unstaged', kind: 'deleted' },
        { path: 'staged.txt', area: 'staged', kind: 'added' },
        { path: 'notes/hello.txt', area: 'untracked', kind: 'untracked' },
        { path: '中文 名.txt', area: 'untracked', kind: 'untracked' },
      ])
    );
    expect(changes).toHaveLength(7);
  });

  it('reads the whole repository from a folder inside it', async () => {
    const dir = repository();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'README.md'), '# app, changed\n');
    const status = await readRepository(join(dir, 'src'));
    expect(status.root).toBe(dir);
    expect(status.changes).toEqual([{ path: 'README.md', area: 'unstaged', kind: 'modified' }]);
  });

  it('says how the branch stands: ahead and behind its upstream, detached, before the first commit', async () => {
    const dir = repository();
    git(dir, 'branch', 'base');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'on main');
    git(dir, 'checkout', '-q', 'base');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'on base 1');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'on base 2');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'branch', '-q', '--set-upstream-to=base');
    expect((await readRepository(dir)).branch).toMatchObject({ name: 'main', upstream: 'base', ahead: 1, behind: 2 });

    git(dir, 'checkout', '-q', '--detach');
    const detached = (await readRepository(dir)).branch;
    expect(detached.name).toBeUndefined();
    expect(detached.commit).toMatch(/^[0-9a-f]{7}$/);

    const fresh = temp();
    git(fresh, 'init', '-q', '-b', 'trunk');
    writeFileSync(join(fresh, 'first.txt'), '1\n');
    const unborn = await readRepository(fresh);
    expect(unborn.branch).toEqual({ name: 'trunk' });
    expect(unborn.changes).toEqual([{ path: 'first.txt', area: 'untracked', kind: 'untracked' }]);
  });

  it('carries at most its limit of changes and counts the rest', async () => {
    const dir = repository();
    for (let index = 0; index < 5; index += 1) writeFileSync(join(dir, `new-${index}.txt`), `${index}\n`);
    const status = await readRepository(dir, { changeLimit: 3 });
    expect(status.changes).toHaveLength(3);
    expect(status.more).toBe(2);
    expect(status.truncated).toBe(false);
  });
});

describe.skipIf(!working)('one file’s diff', () => {
  it('shows an edit, a staged edit, a staged rename and a new file all added', async () => {
    const dir = repository();
    writeFileSync(join(dir, 'README.md'), '# app\nA line the model wrote.\n');
    writeFileSync(join(dir, 'a.txt'), 'one, staged\n');
    git(dir, 'add', 'a.txt');
    git(dir, 'mv', 'b.txt', 'b2.txt');
    mkdirSync(join(dir, 'notes'));
    writeFileSync(join(dir, 'notes', 'hello.txt'), 'hi\n');
    const diff = folderGit().diff;

    const edit = await diff({ cwd: dir, path: 'README.md', area: 'unstaged' });
    expect(edit).toMatchObject({ binary: false, truncated: false });
    expect(edit.patch).toContain('+A line the model wrote.');
    expect(edit.patch).toContain('--- a/README.md');

    const staged = await diff({ cwd: dir, path: 'a.txt', area: 'staged' });
    expect(staged.patch).toContain('-one');
    expect(staged.patch).toContain('+one, staged');
    // The working tree matches the index: nothing unstaged.
    expect((await diff({ cwd: dir, path: 'a.txt', area: 'unstaged' })).patch).toBe('');

    const renamed = await diff({ cwd: dir, path: 'b2.txt', area: 'staged', from: 'b.txt' });
    expect(renamed.patch).toMatch(/rename from b\.txt\nrename to b2\.txt/);

    const added = await diff({ cwd: join(dir, 'notes'), path: 'notes/hello.txt', area: 'untracked' });
    expect(added.patch).toContain('new file mode');
    expect(added.patch).toContain('+hi');
  });

  it('marks a binary file, and cuts a long diff at a line’s end', async () => {
    const dir = repository();
    writeFileSync(join(dir, 'image.bin'), Buffer.from([0, 1, 2, 0, 255, 0, 3]));
    expect(await folderGit().diff({ cwd: dir, path: 'image.bin', area: 'untracked' })).toEqual({
      patch: '',
      binary: true,
      truncated: false,
    });

    const lines = Array.from({ length: 2000 }, (_, index) => `line ${index} of a long file`).join('\n');
    writeFileSync(join(dir, 'long.txt'), `${lines}\n`);
    const long = await folderGit({ diffLimit: 4096 }).diff({ cwd: dir, path: 'long.txt', area: 'untracked' });
    expect(long.truncated).toBe(true);
    expect(Buffer.byteLength(long.patch)).toBeLessThanOrEqual(4096);
    expect(long.patch.endsWith('\n')).toBe(true);
    expect(long.patch).toContain('+line 0 of a long file');
  });

  it('refuses a path that leaves the repository, an unknown area, a folder in no repository', async () => {
    const dir = repository();
    const diff = folderGit().diff;
    const refused = await Promise.all(
      ['../outside.txt', '/etc/hosts', '', 'a\nb'].map((path) =>
        failure(() => diff({ cwd: dir, path, area: 'untracked' }))
      )
    );
    expect(refused).toEqual(Array(4).fill('invalid'));
    expect(await failure(() => diff({ cwd: dir, path: 'a.txt', area: 'everything' }))).toBe('invalid');
    expect(await failure(() => diff({ cwd: dir, path: 'b2.txt', area: 'staged', from: '../b.txt' }))).toBe('invalid');
    expect(await failure(() => diff({ cwd: temp(), path: 'a.txt', area: 'unstaged' }))).toBe('invalid');
  });
});
