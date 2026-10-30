import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KyrnError } from '@/common/kyrn/errors';
import type { FolderGitStatus } from '@/common/kyrn/gitBridge';
import { createFolderGit } from '@/process/services/folderGit';
import { splitPatch } from '@/process/services/folderGit/folderGit';
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

  it('is the person’s own for a commit: only what points elsewhere goes, and prompts stay off', () => {
    const made = gitEnv(
      {
        PATH: '/bin',
        LANG: 'de_DE.UTF-8',
        GIT_DIR: '/elsewhere/.git',
        GIT_AUTHOR_NAME: 'Ada',
        GIT_SSH_COMMAND: 'ssh -i k',
      },
      true
    );
    expect(made).toEqual({
      PATH: '/bin',
      LANG: 'de_DE.UTF-8',
      GIT_AUTHOR_NAME: 'Ada',
      GIT_SSH_COMMAND: 'ssh -i k',
      GIT_TERMINAL_PROMPT: '0',
    });
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

describe.skipIf(!working)('one hunk of a file’s diff', () => {
  /** twenty.txt committed with lines 1 to 20, then lines 2 and 18 changed: two hunks, far apart. */
  const twoHunks = (): string => {
    const dir = repository();
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    writeFileSync(join(dir, 'twenty.txt'), `${lines.join('\n')}\n`);
    git(dir, 'add', 'twenty.txt');
    git(dir, 'commit', '-q', '-m', 'twenty');
    lines[1] = 'line 2, changed';
    lines[17] = 'line 18, changed';
    writeFileSync(join(dir, 'twenty.txt'), `${lines.join('\n')}\n`);
    return dir;
  };
  const hunksOf = (patch: string) => splitPatch(patch)?.hunks ?? [];

  it('stages one hunk of an unstaged diff and unstages it again, the working tree untouched', async () => {
    const dir = twoHunks();
    const { diff, hunk } = folderGit();
    const before = readFileSync(join(dir, 'twenty.txt'), 'utf8');
    const unstaged = await diff({ cwd: dir, path: 'twenty.txt', area: 'unstaged' });
    expect(unstaged.hunks).toBe(true);
    const [first, second] = hunksOf(unstaged.patch);
    expect(first).toContain('+line 2, changed');
    expect(second).toContain('+line 18, changed');

    // The answer is the area's diff as it is now: the other hunk alone.
    const left = await hunk({ cwd: dir, path: 'twenty.txt', area: 'unstaged', hunk: first });
    expect(hunksOf(left.patch)).toEqual([second]);
    const staged = await diff({ cwd: dir, path: 'twenty.txt', area: 'staged' });
    expect(staged.patch).toContain('+line 2, changed');
    expect(staged.patch).not.toContain('line 18, changed');
    expect(readFileSync(join(dir, 'twenty.txt'), 'utf8')).toBe(before);

    const [stagedHunk] = hunksOf(staged.patch);
    expect((await hunk({ cwd: dir, path: 'twenty.txt', area: 'staged', hunk: stagedHunk })).patch).toBe('');
    expect(hunksOf((await diff({ cwd: dir, path: 'twenty.txt', area: 'unstaged' })).patch)).toHaveLength(2);
    expect(readFileSync(join(dir, 'twenty.txt'), 'utf8')).toBe(before);
  });

  it('changes nothing when the hunk is no longer in the diff, and says so', async () => {
    const dir = twoHunks();
    const { diff, hunk } = folderGit();
    const [first] = hunksOf((await diff({ cwd: dir, path: 'twenty.txt', area: 'unstaged' })).patch);
    writeFileSync(
      join(dir, 'twenty.txt'),
      readFileSync(join(dir, 'twenty.txt'), 'utf8').replace('line 2, changed', 'line 2, again')
    );

    expect(await failure(() => hunk({ cwd: dir, path: 'twenty.txt', area: 'unstaged', hunk: first }))).toBe('stale');
    expect((await diff({ cwd: dir, path: 'twenty.txt', area: 'staged' })).patch).toBe('');
    // A hunk made up by the screen is not one of the diff's either.
    const madeUp = '@@ -1,1 +1,1 @@\n-line 1\n+rm -rf\n';
    expect(await failure(() => hunk({ cwd: dir, path: 'twenty.txt', area: 'unstaged', hunk: madeUp }))).toBe('stale');
  });

  it('offers no hunks for a new file, a rename, a change of mode or an untracked file, and refuses other areas', async () => {
    const dir = repository();
    const { diff, hunk } = folderGit();
    writeFileSync(join(dir, 'new.txt'), 'new\n');
    git(dir, 'add', 'new.txt');
    git(dir, 'mv', 'b.txt', 'b2.txt');
    chmodSync(join(dir, 'a.txt'), 0o755);
    writeFileSync(join(dir, 'a.txt'), 'one, and more\n');
    writeFileSync(join(dir, 'loose.txt'), 'loose\n');

    expect((await diff({ cwd: dir, path: 'new.txt', area: 'staged' })).hunks).toBeUndefined();
    expect((await diff({ cwd: dir, path: 'b2.txt', area: 'staged', from: 'b.txt' })).hunks).toBeUndefined();
    expect((await diff({ cwd: dir, path: 'loose.txt', area: 'untracked' })).hunks).toBeUndefined();
    const moded = await diff({ cwd: dir, path: 'a.txt', area: 'unstaged' });
    if (moded.patch.includes('new mode')) expect(moded.hunks).toBeUndefined();

    const any = '@@ -1 +1 @@\n-x\n+y\n';
    expect(await failure(() => hunk({ cwd: dir, path: 'loose.txt', area: 'untracked', hunk: any }))).toBe('invalid');
    expect(await failure(() => hunk({ cwd: dir, path: 'a.txt', area: 'unstaged', hunk: 42 }))).toBe('invalid');
    expect(await failure(() => hunk({ cwd: dir, path: '../out.txt', area: 'unstaged', hunk: any }))).toBe('invalid');
  });
});

describe('a diff taken apart into its hunks', () => {
  it('splits a content change’s diff at its @@ lines, and none whose header says more', () => {
    const patch = 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d\n';
    expect(splitPatch(patch)).toEqual({
      header: 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n',
      hunks: ['@@ -1 +1 @@\n-a\n+b\n', '@@ -9 +9 @@\n-c\n+d\n'],
    });
    expect(splitPatch(patch.replace('index 1..2 100644\n', 'old mode 100644\nnew mode 100755\n'))).toBeNull();
    expect(splitPatch('')).toBeNull();
  });
});

describe.skipIf(!working)('staging and committing', () => {
  /** A home whose git config names a person and does not sign, as a person who commits has. */
  const person = (): string => {
    const dir = temp('mu-git-person-');
    writeFileSync(
      join(dir, '.gitconfig'),
      '[user]\n\tname = Ada Lovelace\n\temail = ada@mu.invalid\n[commit]\n\tgpgsign = false\n'
    );
    return dir;
  };
  const as = (personHome: string) => createFolderGit({ run: gitRunner({ env: { ...env(), HOME: personHome } }) });
  const areas = async (dir: string) =>
    Object.fromEntries((await readRepository(dir)).changes.map((change) => [change.path, change.area]));

  it('stages files as they are, a deletion and a new file included, and takes them out again', async () => {
    const dir = repository();
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    rmSync(join(dir, 'b.txt'));
    writeFileSync(join(dir, 'new [1].txt'), 'n\n');
    const folder = folderGit();
    await folder.stage({ cwd: dir, paths: ['a.txt', 'b.txt', 'new [1].txt'] });
    expect(await areas(dir)).toEqual({ 'a.txt': 'staged', 'b.txt': 'staged', 'new [1].txt': 'staged' });

    await folder.unstage({ cwd: dir, paths: ['a.txt', 'new [1].txt'] });
    expect(await areas(dir)).toEqual({ 'a.txt': 'unstaged', 'b.txt': 'staged', 'new [1].txt': 'untracked' });
    // The working tree is as it was.
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('two\n');
    expect(existsSync(join(dir, 'b.txt'))).toBe(false);
  });

  it('takes a new file out of the index before the first commit', async () => {
    const dir = temp();
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'first.txt'), '1\n');
    const folder = folderGit();
    await folder.stage({ cwd: dir, paths: ['first.txt'] });
    expect(await areas(dir)).toEqual({ 'first.txt': 'staged' });
    await folder.unstage({ cwd: dir, paths: ['first.txt'] });
    expect(await areas(dir)).toEqual({ 'first.txt': 'untracked' });
  });

  it('stages many files in several runs', async () => {
    const dir = repository();
    const names = Array.from({ length: 250 }, (_, index) => `many/f${index}.txt`);
    mkdirSync(join(dir, 'many'));
    for (const name of names) writeFileSync(join(dir, name), 'x\n');
    await folderGit().stage({ cwd: dir, paths: names });
    expect(Object.values(await areas(dir)).filter((area) => area === 'staged')).toHaveLength(250);
  });

  it('refuses paths that leave the repository, no paths, and a folder in no repository', async () => {
    const dir = repository();
    const folder = folderGit();
    expect(await failure(() => folder.stage({ cwd: dir, paths: ['../x'] }))).toBe('invalid');
    expect(await failure(() => folder.stage({ cwd: dir, paths: [] }))).toBe('invalid');
    expect(await failure(() => folder.unstage({ cwd: dir, paths: 'a.txt' }))).toBe('invalid');
    expect(await failure(() => folder.stage({ cwd: temp(), paths: ['a.txt'] }))).toBe('invalid');
  });

  it('commits what is staged as the person, and says the commit and its first line', async () => {
    const dir = repository();
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    writeFileSync(join(dir, 'b.txt'), 'bee bee\n');
    const folder = as(person());
    await folder.stage({ cwd: dir, paths: ['a.txt'] });
    const made = await folder.commit({ cwd: dir, message: '  Two in a\r\n\nBecause one was not enough.\n' });
    expect(made).toEqual({
      committed: true,
      commit: git(dir, 'rev-parse', '--short', 'HEAD').trim(),
      subject: 'Two in a',
    });
    expect(git(dir, 'log', '-1', '--format=%an <%ae>%n%B').trim()).toBe(
      'Ada Lovelace <ada@mu.invalid>\nTwo in a\n\nBecause one was not enough.'
    );
    // Only what was staged went in.
    expect(await areas(dir)).toEqual({ 'b.txt': 'unstaged' });
  });

  it('commits every change with `all`, new files included', async () => {
    const dir = repository();
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    writeFileSync(join(dir, 'new.txt'), 'n\n');
    const made = await as(person()).commit({ cwd: dir, message: 'Everything', all: true });
    expect(made).toMatchObject({ committed: true, subject: 'Everything' });
    expect(await areas(dir)).toEqual({});
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual([
      'a.txt',
      'new.txt',
    ]);
  });

  it('says what git and the hooks wrote when the commit does not happen', async () => {
    const dir = repository();
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    // Nothing staged.
    const nothing = await as(person()).commit({ cwd: dir, message: 'Nothing' });
    expect(nothing.committed).toBe(false);

    // No name to commit as (and git told not to make one up from the machine's).
    git(dir, 'add', 'a.txt');
    const nameless = temp('mu-git-nobody-');
    writeFileSync(join(nameless, '.gitconfig'), '[user]\n\tuseConfigOnly = true\n[commit]\n\tgpgsign = false\n');
    const nobody = await as(nameless).commit({ cwd: dir, message: 'Who' });
    expect(nobody).toMatchObject({ committed: false });
    if (!nobody.committed) expect(nobody.output).toMatch(/tell me who you are|user\.email|identity/i);

    // A hook that says no, run in the person's environment (pathspecs are not forced to be literal there).
    if (process.platform !== 'win32') {
      const hook = join(dir, '.git', 'hooks', 'pre-commit');
      writeFileSync(
        hook,
        '#!/bin/sh\necho "literal=${GIT_LITERAL_PATHSPECS:-unset}"\necho "lint failed: a.txt" >&2\nexit 1\n'
      );
      chmodSync(hook, 0o755);
      const refused = await as(person()).commit({ cwd: dir, message: 'Lint me' });
      expect(refused).toMatchObject({ committed: false });
      if (!refused.committed) {
        expect(refused.output).toContain('lint failed: a.txt');
        expect(refused.output).toContain('literal=unset');
      }
      expect(git(dir, 'log', '-1', '--format=%s').trim()).toBe('first');
    }
  });

  it('refuses an empty message', async () => {
    const dir = repository();
    const folder = as(person());
    expect(await failure(() => folder.commit({ cwd: dir, message: ' \n ' }))).toBe('invalid');
    expect(await failure(() => folder.commit({ cwd: dir, message: 42 }))).toBe('invalid');
  });
});
