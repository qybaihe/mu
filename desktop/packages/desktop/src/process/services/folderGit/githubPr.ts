import { execFile } from 'node:child_process';
import type { FolderGitPr, GitCheck, GitCheckState } from '../../../common/kyrn/gitBridge';
import { readFolder } from '../../agent/kyrn/folderFiles';
import { firstLine, GitNotStarted, type GitRun, type GitRunner, gitRunner } from './runGit';

/*
 * The pull request of the branch a native conversation's folder is on, and its checks, for the source tab: GitHub's
 * own CLI (`gh`) answers, signed in as the person, the way they would ask it in a terminal. It only reads: nothing is
 * pushed or opened here. Without gh, signed out, or in a repository GitHub does not hold, there is nothing to show.
 */

/** Runs `gh <args>` in a folder: no prompt, no colour, no pager, no update notice, within a time. */
export type GhRunner = (args: string[], options: { cwd: string; timeoutMs: number }) => Promise<GitRun>;

const GH_MS = 15_000;
const GH_BYTES = 1024 * 1024;
const GIT_MS = 10_000;
const GIT_BYTES = 64 * 1024;
const PR_FIELDS = 'number,title,url,state,isDraft,statusCheckRollup';

/** The `gh` the app's PATH finds, the environment read at each run (as `gitRunner` does: PATH is fixed after start). */
export function ghRunner({ command = 'gh', env }: { command?: string; env?: NodeJS.ProcessEnv } = {}): GhRunner {
  return (args, { cwd, timeoutMs }) =>
    new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        {
          cwd,
          env: {
            ...(env ?? process.env),
            GH_PROMPT_DISABLED: '1',
            GH_NO_UPDATE_NOTIFIER: '1',
            GH_PAGER: 'cat',
            NO_COLOR: '1',
          },
          timeout: timeoutMs,
          maxBuffer: GH_BYTES,
          encoding: 'utf8',
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const failure = error as (Error & { code?: number | string; killed?: boolean }) | null;
          if (!failure) return resolve({ code: 0, stdout, stderr, overflow: false });
          if (typeof failure.code === 'string' && failure.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
            return reject(new GitNotStarted(failure.message));
          resolve({ code: typeof failure.code === 'number' ? failure.code : 1, stdout, stderr, overflow: false });
        }
      );
    });
}

type RollupItem = {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
};

/** A check run (`status`, `conclusion`) or a commit status (`state`) as one of four states. */
export function checkState(item: RollupItem): GitCheckState {
  if (item.__typename === 'StatusContext' || (item.state && !item.status)) {
    const state = (item.state ?? '').toUpperCase();
    if (state === 'SUCCESS') return 'pass';
    if (state === 'FAILURE' || state === 'ERROR') return 'fail';
    return 'pending';
  }
  if ((item.status ?? '').toUpperCase() !== 'COMPLETED') return 'pending';
  const conclusion = (item.conclusion ?? '').toUpperCase();
  if (conclusion === 'SUCCESS') return 'pass';
  if (conclusion === 'NEUTRAL' || conclusion === 'SKIPPED') return 'skipped';
  return 'fail';
}

const httpsUrl = (value: unknown): string | undefined =>
  typeof value === 'string' && value.startsWith('https://') ? value : undefined;

/** `gh pr view --json` as the tab shows it; null for what is not one. */
export function parsePr(stdout: string): FolderGitPr | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const pr = raw as { number?: unknown; title?: unknown; url?: unknown; state?: unknown; isDraft?: unknown };
  const url = httpsUrl(pr.url);
  if (typeof pr.number !== 'number' || typeof pr.title !== 'string' || !url) return null;
  const state = String(pr.state ?? '').toUpperCase();
  const rollup = (raw as { statusCheckRollup?: unknown }).statusCheckRollup;
  const checks: GitCheck[] = (Array.isArray(rollup) ? (rollup as RollupItem[]) : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const check: GitCheck = { name: String(item.name || item.context || '?'), state: checkState(item) };
      const page = httpsUrl(item.detailsUrl ?? item.targetUrl);
      if (page) check.url = page;
      return check;
    });
  return {
    state: 'pr',
    number: pr.number,
    title: pr.title,
    url,
    status: state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : pr.isDraft === true ? 'draft' : 'open',
    checks,
  };
}

/** What gh said when it could not answer, for a person to read; the first line, or its exit code. */
const said = (run: GitRun): string => firstLine(run.stderr) || firstLine(run.stdout) || `gh ended with ${run.code}`;

/** `[host/]owner/repo` of a remote's URL (https, ssh or scp-like), or null for what is not one. */
export function remoteRepo(url: string): { repo: string; owner: string } | null {
  const match =
    /^(?:https:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/:]+@)([^/:]+)(?::\d+)?[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
      url.trim()
    );
  if (!match) return null;
  const [, host, owner, name] = match;
  const where = host.toLowerCase() === 'github.com' ? '' : `${host}/`;
  return { repo: `${where}${owner}/${name}`, owner };
}

/**
 * The branch checked out and the repository it is pushed to: the branch's push remote, else its upstream's, else
 * origin. null on a detached HEAD, or when that remote is not a repository gh could name.
 */
async function pushedTo(
  folder: string,
  git: GitRunner
): Promise<{ branch: string; repo: string; owner: string } | null> {
  const options = { cwd: folder, timeoutMs: GIT_MS, maxBytes: GIT_BYTES };
  const head = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], options);
  const branch = head.code === 0 ? head.stdout.trim() : '';
  if (!branch) return null;
  const remotes = await git(
    ['for-each-ref', '--format=%(push:remotename)%00%(upstream:remotename)', `refs/heads/${branch}`],
    options
  );
  const [push = '', upstream = ''] = remotes.code === 0 ? remotes.stdout.trim().split('\0') : [];
  const remote = push || upstream || 'origin';
  const url = await git(['remote', 'get-url', '--push', remote], options);
  const named = url.code === 0 ? remoteRepo(url.stdout) : null;
  return named ? { branch, ...named } : null;
}

/**
 * The pull request of the folder's branch, read with gh. gh looks in the repository it takes as the folder's (the one
 * set with `gh repo set-default`, else a remote named upstream, then origin); in a fork with an upstream remote that is
 * the repository it came from, so a pull request opened in the fork itself is not found there, and the repository the
 * branch is pushed to is asked next, for a pull request from that branch of that owner. `none` also names the default
 * branch of the repository asked last, which has no pull request of its own to open.
 */
export async function branchPr(
  cwd: unknown,
  gh: GhRunner = ghRunner(),
  git: GitRunner = gitRunner()
): Promise<FolderGitPr> {
  const folder = readFolder(cwd);
  let viewed: GitRun;
  try {
    viewed = await gh(['pr', 'view', '--json', PR_FIELDS], { cwd: folder, timeoutMs: GH_MS });
  } catch (error) {
    if (error instanceof GitNotStarted) return { state: 'no-gh' };
    throw error;
  }
  if (viewed.code === 0) return parsePr(viewed.stdout) ?? { state: 'unavailable', reason: said(viewed) };
  if (!/no pull requests? found/i.test(viewed.stderr)) return { state: 'unavailable', reason: said(viewed) };

  const pushed = await pushedTo(folder, git).catch((): null => null);
  if (pushed) {
    const there = await gh(
      ['pr', 'view', pushed.branch, '--repo', pushed.repo, '--json', `${PR_FIELDS},headRepositoryOwner`],
      {
        cwd: folder,
        timeoutMs: GH_MS,
      }
    ).catch((): undefined => undefined);
    if (there?.code === 0 && headOwner(there.stdout)?.toLowerCase() === pushed.owner.toLowerCase()) {
      const pr = parsePr(there.stdout);
      if (pr) return pr;
    }
  }
  const repo = await gh(
    ['repo', 'view', ...(pushed ? [pushed.repo] : []), '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
    { cwd: folder, timeoutMs: GH_MS }
  ).catch((): undefined => undefined);
  const defaultBranch = repo?.code === 0 ? repo.stdout.trim() : '';
  return { state: 'none', ...(defaultBranch ? { defaultBranch } : {}) };
}

/** The login of the owner of the pull request's branch, in `gh pr view --json headRepositoryOwner`. */
function headOwner(stdout: string): string | undefined {
  try {
    const login = (JSON.parse(stdout) as { headRepositoryOwner?: { login?: unknown } }).headRepositoryOwner?.login;
    return typeof login === 'string' ? login : undefined;
  } catch {
    return undefined;
  }
}
