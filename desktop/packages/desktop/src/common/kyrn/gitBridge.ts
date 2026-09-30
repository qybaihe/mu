/**
 * Source control by a project folder, for the 源码 tab beside a native conversation (docs/native-host-ui.md). Such a
 * conversation has no AionCore project, so the classic source control (the backend's, by project entry, over the
 * `scm` lane) has nothing to read. The main process runs git itself in the conversation's folder instead
 * (process/services/folderGit/), read only, with `KyrnResult` like every mu channel.
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

/** One file's diff as git writes it (unified), or `binary` with no patch; `truncated` when GIT_DIFF_LIMIT cut it. */
export type FolderGitDiff = { patch: string; binary: boolean; truncated: boolean };

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
};
