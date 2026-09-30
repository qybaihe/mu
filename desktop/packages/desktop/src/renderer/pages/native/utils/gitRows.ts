import type { GitArea, GitBranch, GitChange } from '@/common/kyrn/gitBridge';
import type { ScmResource } from '@/renderer/pages/conversation/SourceControl/scmModel';

/** The source tab's sections, in order: a merge to resolve first, then the index, the working tree, new files. */
export const SOURCE_SECTIONS: readonly GitArea[] = ['conflicted', 'staged', 'unstaged', 'untracked'];

/** A change's identity on screen: a file can be in two areas at once. */
export const changeKey = (change: GitChange): string => `${change.area}\u0000${change.path}`;

/** The changes of each section that has any, in SOURCE_SECTIONS order, each in git's order. */
export const sectionsOf = (changes: GitChange[]): Array<{ area: GitArea; changes: GitChange[] }> =>
  SOURCE_SECTIONS.map((area) => ({ area, changes: changes.filter((change) => change.area === area) })).filter(
    (section) => section.changes.length > 0
  );

/**
 * A change as the classic source control's row draws it (`ScmResourceRow`): its state gives the letter and colour
 * (A, M, D, R, and ! for a conflict), `staged` its side (none for a conflict, which has no side), `rename_from` the
 * old path of a rename.
 */
export function toResource(change: GitChange): ScmResource {
  const state =
    change.kind === 'untracked' || change.kind === 'added' || change.kind === 'copied'
      ? 'created'
      : change.kind === 'deleted' || change.kind === 'renamed' || change.kind === 'conflicted'
        ? change.kind
        : 'modified';
  return {
    file: { pe_id: change.area, relative_path: change.path },
    repo_relative_path: change.path,
    state,
    ...(change.area === 'conflicted' ? {} : { staged: change.area === 'staged' }),
    ...(change.kind === 'renamed' && change.from ? { rename_from: change.from } : {}),
  };
}

/** Whether the branch has an upstream it is ahead of or behind. */
export const drifted = (branch: GitBranch): boolean =>
  branch.upstream !== undefined && ((branch.ahead ?? 0) > 0 || (branch.behind ?? 0) > 0);
