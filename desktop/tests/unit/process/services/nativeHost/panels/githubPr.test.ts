/**
 * The pull request of a native conversation's branch and its checks, for the source tab: what GitHub's CLI says, read
 * with a fake `gh`, so no network and no sign-in are needed.
 */
import { describe, expect, it, vi } from 'vitest';
import { branchPr, checkState, type GhRunner, parsePr } from '@/process/services/folderGit/githubPr';
import { GitNotStarted } from '@/process/services/folderGit/runGit';

const folder = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app';
const ok = (stdout: string) => ({ code: 0, stdout, stderr: '', overflow: false });
const failed = (stderr: string, code = 1) => ({ code, stdout: '', stderr, overflow: false });

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
    expect(await branchPr(folder, gh)).toMatchObject({ state: 'pr', number: 267 });
    expect(gh).toHaveBeenCalledWith(['pr', 'view', '--json', 'number,title,url,state,isDraft,statusCheckRollup'], {
      cwd: folder,
      timeoutMs: expect.any(Number),
    });
  });

  it('says there is none, with the default branch, when the branch has no pull request', async () => {
    const gh = vi.fn<GhRunner>(async (args) =>
      args[0] === 'pr' ? failed('no pull requests found for branch "feat/x"') : ok('main\n')
    );
    expect(await branchPr(folder, gh)).toEqual({ state: 'none', defaultBranch: 'main' });

    const noRepo = vi.fn<GhRunner>(async (args) =>
      args[0] === 'pr' ? failed('no pull requests found for branch "feat/x"') : failed('HTTP 404')
    );
    expect(await branchPr(folder, noRepo)).toEqual({ state: 'none' });
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
