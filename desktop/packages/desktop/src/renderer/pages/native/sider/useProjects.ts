/**
 * What the sidebar's projects need besides the conversations (projects.ts): the folders the person added as projects,
 * and the projects they folded, both choices about this app's list kept in the window's own storage as the pins are
 * (hooks/idSetStore.ts); and the repository each conversation's folder is in, asked of the main process once per
 * folder and window.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createIdSetStore, useIdSet } from '../hooks/idSetStore';
import { useNativeClient } from '../utils/nativeClient';
import { folderKey, type AddedProject } from './projects';

export const PROJECTS_KEY = 'mu.native.projects';
export const FOLDED_KEY = 'mu.native.foldedProjects';

const listeners = new Set<() => void>();

function read(): readonly AddedProject[] {
  try {
    const stored: unknown = JSON.parse(globalThis.localStorage.getItem(PROJECTS_KEY) ?? '[]');
    return Array.isArray(stored)
      ? stored.filter(
          (each): each is AddedProject =>
            typeof each?.folder === 'string' && each.folder !== '' && typeof each.addedAt === 'number'
        )
      : [];
  } catch {
    return [];
  }
}

let added = read();

function write(next: readonly AddedProject[]): void {
  added = next;
  try {
    globalThis.localStorage.setItem(PROJECTS_KEY, JSON.stringify(next));
  } catch {
    // Kept in memory: for as long as the page lives.
  }
  for (const listener of listeners) listener();
}

globalThis.addEventListener?.('storage', (event) => {
  if (event.key !== PROJECTS_KEY) return;
  added = read();
  for (const listener of listeners) listener();
});

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Adds a folder as a project, as of now; one already added is added again, as of now. */
export function addProject(folder: string, now: number = Date.now()): void {
  const key = folderKey(folder);
  write([{ folder, addedAt: now }, ...added.filter((each) => folderKey(each.folder) !== key)]);
}

/** Forgets an added folder: its project shows while a conversation is in it. */
export function forgetProject(folder: string): void {
  const key = folderKey(folder);
  if (added.some((each) => folderKey(each.folder) === key))
    write(added.filter((each) => folderKey(each.folder) !== key));
}

export const useAddedProjects = (): readonly AddedProject[] => useSyncExternalStore(subscribe, () => added);

/** The projects folded in the list, by `folderKey`; a project is open until folded. */
const folded = createIdSetStore(FOLDED_KEY);

/** Forgets every added and folded project (tests start from none). */
export function forgetProjects(): void {
  if (added.length > 0) write([]);
  folded.clear();
}

export function useFoldedProjects(): { folded: ReadonlySet<string>; toggle: (folder: string) => void } {
  return { folded: useIdSet(folded), toggle: (folder) => folded.toggle(folderKey(folder)) };
}

/** The repository of every folder asked, by the folder: undefined for one in none. */
const roots = new Map<string, string | undefined>();

/** Forgets every answer (tests start from none). */
export const forgetRepoRoots = (): void => roots.clear();

/**
 * The repository each of `folders` is in, by the folder, and whether the list can be drawn with them: once every one
 * has been looked up, the first time (so the projects do not move under the person as the answer comes), and from
 * then on at once (a new conversation's folder is placed while it is looked up: projects.ts).
 */
export function useRepoRoots(folders: readonly string[]): { roots: ReadonlyMap<string, string>; ready: boolean } {
  const client = useNativeClient();
  const [answers, setAnswers] = useState(0);
  const asking = [...new Set(folders)].filter((folder) => !roots.has(folder)).join('\n');
  useEffect(() => {
    if (!asking) return undefined;
    let disposed = false;
    const wanted = asking.split('\n');
    const found = (answer: Readonly<Record<string, string>>) => {
      for (const folder of wanted) roots.set(folder, Object.hasOwn(answer, folder) ? answer[folder] : undefined);
      if (!disposed) setAnswers((count) => count + 1);
    };
    // One that cannot be looked up is in no repository, as far as this window knows.
    client.repoRoots(wanted).then(found, () => found({}));
    return () => {
      disposed = true;
    };
  }, [asking, client]);
  return useMemo(
    () => ({
      roots: new Map(
        folders.flatMap((folder) => {
          const root = roots.get(folder);
          return root ? [[folder, root] as const] : [];
        })
      ),
      ready: answers > 0 || folders.every((folder) => roots.has(folder)),
    }),
    // `answers` counts the answers that came: each one may change what `roots` holds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [folders, answers]
  );
}
