/**
 * Source control by a project folder, for the 源码 tab beside a native conversation (docs/native-host-ui.md). Such a
 * conversation has no backend project, so the classic source control (the backend's, by project entry, over the
 * `scm` lane) has nothing to read. The main process runs git itself in the conversation's folder instead
 * (process/services/folderGit/), with `KyrnResult` like every mu channel. It reads, and writes only what the person
 * asks for there: staging a file, taking it out of the index, a commit. Nothing is discarded, and nothing is pushed.
 *
 * A folder is a full path. A file is named by its path in the repository: relative to the repository's root, `/`
 * between names, never leaving it.
 */
import { bridge } from '../platform/bridge';
import type { KyrnResult } from './errors';

/** Where a change sits: in the index, in the working tree, new to git, or in a merge that is not resolved. */
export type GitArea = 'staged' | 'unstaged' | 'untracked' | 'conflicted';

export const GIT_AREAS: readonly GitArea[] = ['staged', 'unstaged', 'untracked', 'conflicted'];

/** What happened to a file on that side (git's letters M, A, D, R, C, T; U for a conflict; ? for a new file). */
export type GitChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'conflicted'
  | 'untracked';

/**
 * One changed file. A file changed both in the index and after it is two changes, one per area. `from`: the path a
 * renamed or copied file had.
 */
export type GitChange = { path: string; area: GitArea; kind: GitChangeKind; from?: string };

/** HEAD: its branch (none when detached), its commit (none before the first commit), and its upstream if any. */
export type GitBranch = {
  name?: string;
  /** The commit, abbreviated. */
  commit?: string;
  upstream?: string;
  /** Commits ahead of and behind the upstream, when there is one git can compare with. */
  ahead?: number;
  behind?: number;
};

/**
 * What the tab shows:
 * - `no-git`: git cannot run (not found, or it fails before doing anything, as the Xcode stub does until its licence
 *   is accepted); `reason` is git's own first line, or what the system said.
 * - `not-repository`: the folder is in no repository.
 * - `repository`: the changes, at most GIT_CHANGE_LIMIT; `more` counts those left out, `truncated` says git wrote more
 *   than was read (so `more` is not all of them).
 */
export type FolderGitStatus =
  | { state: 'no-git'; reason: string }
  | { state: 'not-repository' }
  | {
      state: 'repository';
      root: string;
      branch: GitBranch;
      changes: GitChange[];
      more: number;
      truncated: boolean;
    };

/**
 * One file's diff as git writes it (unified), or `binary` with no patch; `truncated` when GIT_DIFF_LIMIT cut it.
 * `hunks`: each of its hunks can be staged (an unstaged diff) or unstaged (a staged one) by itself (`hunk`): a change
 * to a file's content, shown whole, that is not a new or deleted file, a rename or a change of mode.
 */
export type FolderGitDiff = { patch: string; binary: boolean; truncated: boolean; hunks?: boolean };

/**
 * How a commit ended. `committed`: its commit (abbreviated) and the first line of its message. Otherwise git refused
 * (a hook said no, there is no name to commit as, nothing was staged): `output` is what git and its hooks wrote,
 * at most GIT_OUTPUT_LIMIT bytes from the end.
 */
export type FolderGitCommit =
  | { committed: true; commit: string; subject: string }
  | { committed: false; output: string };

/** A pull request check: passed, failed (cancelled and timed out too), still to finish, or skipped (neutral too). */
export type GitCheckState = 'pass' | 'fail' | 'pending' | 'skipped';

/** One check of a pull request (a CI job, a commit status), with the page that says more when there is one. */
export type GitCheck = { name: string; state: GitCheckState; url?: string };

/**
 * The pull request of the folder's branch, read with GitHub's CLI (process/services/folderGit/githubPr.ts):
 * - `no-gh`: gh is not installed (not on the app's PATH);
 * - `unavailable`: gh cannot say (signed out, a repository GitHub does not hold, no branch); `reason` is gh's words;
 * - `none`: the branch has no pull request; `defaultBranch` is the repository's, which gets none of its own;
 * - `pr`: its number, title, page, where it stands, and its checks.
 */
export type FolderGitPr =
  | { state: 'no-gh' }
  | { state: 'unavailable'; reason: string }
  | { state: 'none'; defaultBranch?: string }
  | {
      state: 'pr';
      number: number;
      title: string;
      url: string;
      status: 'open' | 'draft' | 'merged' | 'closed';
      checks: GitCheck[];
    };

/** The longest commit message, in characters. */
export const GIT_MESSAGE_LIMIT = 20_000;

/** The most bytes of what a failed commit wrote that the screen gets: the end of it, where hooks say why. */
export const GIT_OUTPUT_LIMIT = 8 * 1024;

/** The most changes one status carries. */
export const GIT_CHANGE_LIMIT = 1000;

/** The most bytes of one diff; a longer one is cut at a line's end. */
export const GIT_DIFF_LIMIT = 256 * 1024;

export const kyrnGitBridge = {
  /** The folder's repository: its branch and changes, or why there are none to show. */
  status: bridge.buildProvider<KyrnResult<FolderGitStatus>, { cwd: string }>('kyrn.folder.git.status'),
  /** One changed file's diff, for the area its row is in (`from`: a rename's old path). */
  diff: bridge.buildProvider<KyrnResult<FolderGitDiff>, { cwd: string; path: string; area: GitArea; from?: string }>(
    'kyrn.folder.git.diff'
  ),
  /**
   * The repository each folder is in, by the folder: the nearest folder up from it, itself included, that holds a
   * `.git` (process/services/folderGit/repoRoots.ts). A folder in none is left out. For the sidebar, which groups a
   * project's conversations under its repository.
   */
  roots: bridge.buildProvider<KyrnResult<Record<string, string>>, { folders: string[] }>('kyrn.folder.git.roots'),
  /** Stages files as they are in the working tree, deletions included (`git add -A -- <paths>`). */
  stage: bridge.buildProvider<KyrnResult<void>, { cwd: string; paths: string[] }>('kyrn.folder.git.stage'),
  /** Takes files out of the index, back to HEAD's (or out of it, before the first commit); the working tree stays. */
  unstage: bridge.buildProvider<KyrnResult<void>, { cwd: string; paths: string[] }>('kyrn.folder.git.unstage'),
  /**
   * Commits what is staged, with the repository's hooks and the person's git settings. `all`: every change is staged
   * first, new files included (`git add -A`), for a commit of everything when nothing was staged.
   */
  commit: bridge.buildProvider<KyrnResult<FolderGitCommit>, { cwd: string; message: string; all?: boolean }>(
    'kyrn.folder.git.commit'
  ),
  /**
   * Stages one hunk of a file's unstaged diff, or unstages one of its staged diff (`git apply --cached`, the working
   * tree untouched); `hunk` is its text as the diff showed it, from its `@@` line. The diff is read again first and the
   * hunk must still be in it, or nothing changes (`stale`). Answers the file's diff for the same area, as it is now.
   */
  hunk: bridge.buildProvider<KyrnResult<FolderGitDiff>, { cwd: string; path: string; area: GitArea; hunk: string }>(
    'kyrn.folder.git.hunk'
  ),
  /** The pull request of the folder's branch and its checks, read with gh; nothing is pushed or opened. */
  pr: bridge.buildProvider<KyrnResult<FolderGitPr>, { cwd: string }>('kyrn.folder.git.pr'),
};
