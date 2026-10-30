/**
 * The pull request of a native conversation's branch and its checks, for the source tab: what GitHub's CLI says, read
 * with a fake `gh`, so no network and no sign-in are needed.
 */
import { describe, expect, it, vi } from 'vitest';
import { branchPr, checkState, type GhRunner, parsePr, remoteRepo } from '@/process/services/folderGit/githubPr';
import { GitNotStarted, type GitRunner } from '@/process/services/folderGit/runGit';

const folder = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app';
const ok = (stdout: string) => ({ code: 0, stdout, stderr: '', overflow: false });
const failed = (stderr: string, code = 1) => ({ code, stdout: '', stderr, overflow: false });
const noneHere = failed('no pull requests found for branch "feat/x"');

/** A repository on `feat/x`, pushed to `url` (none: HEAD detached). */
const gitOn = (url?: string) =>
  vi.fn<GitRunner>(async (args) => {
    if (args[0] === 'symbolic-ref') return url ? ok('feat/x\n') : failed('', 1);
    if (args[0] === 'for-each-ref') return ok('origin\0origin\n');
    if (args[0] === 'remote') return ok(`${url}\n`);
    return failed(`unexpected git ${args.join(' ')}`);
  });

const viewed = {
  number: 267,
  title: 'feat(desktop): stage one hunk',
  url: 'https://github.com/o/r/pull/267',
  state: 'OPEN',
  isDraft: false,
  statusCheckRollup: [
    {
      __typename: 'CheckRun',
      name: 'Desktop · checks',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      detailsUrl: 'https://github.com/o/r/actions/runs/1/job/2',
    },
    { __typename: 'CheckRun', name: 'Windows tests', status: 'IN_PROGRESS', conclusion: '', detailsUrl: '' },
    { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
    { __typename: 'StatusContext', context: 'netlify', state: 'PENDING', targetUrl: 'https://app.netlify.com/x' },
  ],
};

describe('a pull request and its checks as gh says them', () => {
  it('reads the number, title, page, where it stands and each check', () => {
    expect(parsePr(JSON.stringify(viewed))).toEqual({
      state: 'pr',
      number: 267,
      title: 'feat(desktop): stage one hunk',
      url: 'https://github.com/o/r/pull/267',
      status: 'open',
      checks: [
        { name: 'Desktop · checks', state: 'pass', url: 'https://github.com/o/r/actions/runs/1/job/2' },
        { name: 'Windows tests', state: 'pending' },
        { name: 'lint', state: 'fail' },
        { name: 'netlify', state: 'pending', url: 'https://app.netlify.com/x' },
      ],
    });
    expect(parsePr(JSON.stringify({ ...viewed, isDraft: true }))).toMatchObject({ status: 'draft' });
    expect(parsePr(JSON.stringify({ ...viewed, state: 'MERGED' }))).toMatchObject({ status: 'merged' });
    expect(parsePr(JSON.stringify({ ...viewed, state: 'CLOSED', statusCheckRollup: null }))).toMatchObject({
      status: 'closed',
      checks: [],
    });
  });

  it('takes no page that is not https, and nothing that is not a pull request', () => {
    expect(parsePr(JSON.stringify({ ...viewed, url: 'javascript:alert(1)' }))).toBeNull();
    expect(parsePr('not json')).toBeNull();
    expect(parsePr('{"number":"1"}')).toBeNull();
    const local = parsePr(
      JSON.stringify({ ...viewed, statusCheckRollup: [{ ...viewed.statusCheckRollup[0], detailsUrl: 'file:///etc' }] })
    );
    expect(local).toMatchObject({ checks: [{ name: 'Desktop · checks', state: 'pass' }] });
    expect(local && 'checks' in local ? local.checks[0] : undefined).not.toHaveProperty('url');
  });

  it("names a remote's repository for gh, its host unless it is github.com", () => {
    expect(remoteRepo('https://github.com/me/app.git')).toEqual({ repo: 'me/app', owner: 'me' });
    expect(remoteRepo('git@github.com:me/app.git\n')).toEqual({ repo: 'me/app', owner: 'me' });
    expect(remoteRepo('ssh://git@ghe.corp.io:2222/me/app')).toEqual({ repo: 'ghe.corp.io/me/app', owner: 'me' });
    expect(remoteRepo('https://token@github.com/me/app/')).toEqual({ repo: 'me/app', owner: 'me' });
    expect(remoteRepo('/srv/git/app.git')).toBeNull();
    expect(remoteRepo('https://github.com/me')).toBeNull();
  });

  it('counts a neutral or skipped run as skipped, and a cancelled one as failed', () => {
    expect(checkState({ status: 'COMPLETED', conclusion: 'NEUTRAL' })).toBe('skipped');
    expect(checkState({ status: 'COMPLETED', conclusion: 'SKIPPED' })).toBe('skipped');
    expect(checkState({ status: 'COMPLETED', conclusion: 'CANCELLED' })).toBe('fail');
    expect(checkState({ status: 'QUEUED' })).toBe('pending');
    expect(checkState({ __typename: 'StatusContext', state: 'ERROR' })).toBe('fail');
    expect(checkState({ __typename: 'StatusContext', state: 'SUCCESS' })).toBe('pass');
  });
});

describe('the branch’s pull request, asked of gh in the folder', () => {
  it('asks gh in the folder, and answers its pull request', async () => {
    const gh = vi.fn<GhRunner>(async () => ok(JSON.stringify(viewed)));
    const git = gitOn('git@github.com:o/r.git');
    expect(await branchPr(folder, gh, git)).toMatchObject({ state: 'pr', number: 267 });
    expect(git).not.toHaveBeenCalled();
    expect(gh).toHaveBeenCalledWith(['pr', 'view', '--json', 'number,title,url,state,isDraft,statusCheckRollup'], {
      cwd: folder,
      timeoutMs: expect.any(Number),
    });
  });

  it('says there is none, with the default branch, when the branch has no pull request', async () => {
    const gh = vi.fn<GhRunner>(async (args) => (args[0] === 'pr' ? noneHere : ok('main\n')));
    expect(await branchPr(folder, gh, gitOn())).toEqual({ state: 'none', defaultBranch: 'main' });
    expect(gh).toHaveBeenLastCalledWith(
      ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
      expect.anything()
    );

    const noRepo = vi.fn<GhRunner>(async (args) => (args[0] === 'pr' ? noneHere : failed('HTTP 404')));
    expect(await branchPr(folder, noRepo, gitOn())).toEqual({ state: 'none' });
  });

  it('asks the repository the branch is pushed to when gh looked in the one it was forked from', async () => {
    // gh takes a remote named upstream as the folder's repository; the pull request is in the fork.
    const gh = vi.fn<GhRunner>(async (args) => {
      if (args.includes('--repo')) return ok(JSON.stringify({ ...viewed, headRepositoryOwner: { login: 'Me' } }));
      return args[0] === 'pr' ? noneHere : ok('main\n');
    });
    expect(await branchPr(folder, gh, gitOn('git@github.com:me/app.git'))).toMatchObject({ state: 'pr', number: 267 });
    expect(gh).toHaveBeenLastCalledWith(
      ['pr', 'view', 'feat/x', '--repo', 'me/app', '--json', expect.stringContaining('headRepositoryOwner')],
      { cwd: folder, timeoutMs: expect.any(Number) }
    );
  });

  it("takes no pull request there from another owner's branch of the same name", async () => {
    const gh = vi.fn<GhRunner>(async (args) => {
      if (args[0] === 'repo') return ok(args[2] === 'ghe.corp.io/me/app' ? 'trunk\n' : 'main\n');
      if (args.includes('--repo')) return ok(JSON.stringify({ ...viewed, headRepositoryOwner: { login: 'someone' } }));
      return noneHere;
    });
    expect(await branchPr(folder, gh, gitOn('https://ghe.corp.io/me/app.git'))).toEqual({
      state: 'none',
      defaultBranch: 'trunk',
    });
  });

  it('says why when gh cannot answer, and that it is missing when it cannot start', async () => {
    const signedOut = vi.fn<GhRunner>(async () =>
      failed('To get started with GitHub CLI, please run:  gh auth login\nAlternatively…', 4)
    );
    expect(await branchPr(folder, signedOut)).toEqual({
      state: 'unavailable',
      reason: 'To get started with GitHub CLI, please run:  gh auth login',
    });
    const missing = vi.fn<GhRunner>(async () => {
      throw new GitNotStarted('spawn gh ENOENT');
    });
    expect(await branchPr(folder, missing)).toEqual({ state: 'no-gh' });
    await expect(branchPr('relative/folder', missing)).rejects.toThrow();
  });
});
