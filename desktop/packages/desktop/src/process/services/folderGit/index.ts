import { kyrnFailure, type KyrnResult } from '../../../common/kyrn/errors';
import { kyrnGitBridge } from '../../../common/kyrn/gitBridge';
import { createFolderGit, type FolderGit } from './folderGit';
import { branchPr } from './githubPr';
import { repoRoots } from './repoRoots';

export { createFolderGit, type FolderGit } from './folderGit';

// Always answer, failures included: the generic bridge only logs a provider's exception, and the tab would wait.
async function result<T>(work: () => Promise<T>): Promise<KyrnResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    return kyrnFailure(error);
  }
}

/** Answers `kyrn.folder.git.*` (common/kyrn/gitBridge.ts) with the git the app's PATH finds. */
export function initFolderGitBridge(git: FolderGit = createFolderGit()): void {
  kyrnGitBridge.status.provider(({ cwd }) => result(() => git.status(cwd)));
  kyrnGitBridge.diff.provider((request) => result(() => git.diff(request)));
  kyrnGitBridge.roots.provider((request) => result(() => repoRoots(request?.folders)));
  kyrnGitBridge.stage.provider((request) => result(() => git.stage(request)));
  kyrnGitBridge.unstage.provider((request) => result(() => git.unstage(request)));
  kyrnGitBridge.commit.provider((request) => result(() => git.commit(request)));
  kyrnGitBridge.pr.provider(({ cwd }) => result(() => branchPr(cwd)));
}
