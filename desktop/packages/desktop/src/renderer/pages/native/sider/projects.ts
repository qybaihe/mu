/**
 * How the sidebar groups mu's conversations into projects (NativeSiderGroup.tsx). A project is a folder, and a
 * conversation belongs to the deepest folder that holds its own, among the folders the person added and the
 * repositories the conversations' folders are in; a folder in no repository and under no added folder is a project of
 * its own. So a conversation in a folder no project has makes one as it appears, and the conversations made before
 * there were projects fall into theirs: nothing is kept for them. (A folder's own repository is the deepest one that
 * holds it, so the others change nothing for it; they place a folder not looked up yet, in a package of a repository
 * the list knows, where the answer will put it.)
 */
import type { NativeConversation } from '@/common/kyrn/nativeBridge';

/** A folder the person added as a project, and when. */
export type AddedProject = { folder: string; addedAt: number };

export type Project = {
  /** Its folder: as the person picked it, as the main process found the repository, or a conversation's own. */
  folder: string;
  /** Its conversations, newest first. */
  conversations: NativeConversation[];
  /** Its newest conversation's last change, or when it was added if that is later: the projects' order. */
  time: number;
};

/**
 * A folder's path as two paths of one folder compare: without a separator at its end, and a Windows path in one case
 * with `/` between its names.
 */
export function folderKey(folder: string): string {
  const windows = /^[A-Za-z]:([\\/]|$)|^\\\\/.test(folder);
  const key = windows ? folder.replace(/\\/g, '/').toLowerCase() : folder;
  // A root keeps its separator: `/`, `c:/`.
  return /^(\/|[a-z]:\/)$/.test(key) ? key : key.replace(/\/+$/, '');
}

/** Whether `folder` is `parent` or inside it. */
export function within(folder: string, parent: string): boolean {
  const key = folderKey(folder);
  const top = folderKey(parent);
  return key === top || key.startsWith(top.endsWith('/') ? top : `${top}/`);
}

/** The project a conversation's folder belongs to: the deepest of `folders` that holds it, else the folder itself. */
export function projectFolder(cwd: string, folders: readonly string[]): string {
  let best: string | undefined;
  for (const folder of folders) {
    if (within(cwd, folder) && (!best || folderKey(folder).length > folderKey(best).length)) best = folder;
  }
  return best ?? cwd;
}

/**
 * The projects, the one changed last first: every added one (an empty one too), and every one a conversation is in.
 * `conversations` come newest first and keep that order in their project. `roots`: the repository of each folder in
 * one, by the folder (NativeClient.repoRoots).
 */
export function groupProjects(
  conversations: readonly NativeConversation[],
  added: readonly AddedProject[],
  roots: ReadonlyMap<string, string>
): Project[] {
  const projects = new Map<string, Project>();
  const projectAt = (folder: string, time: number): Project => {
    const key = folderKey(folder);
    const found = projects.get(key);
    if (found) {
      found.time = Math.max(found.time, time);
      return found;
    }
    const made: Project = { folder, conversations: [], time };
    projects.set(key, made);
    return made;
  };
  for (const each of added) projectAt(each.folder, each.addedAt);
  const folders = [...added.map((each) => each.folder), ...new Set(roots.values())];
  for (const conversation of conversations) {
    projectAt(projectFolder(conversation.cwd, folders), conversation.updatedAt).conversations.push(conversation);
  }
  return [...projects.values()].toSorted((a, b) => b.time - a.time);
}
