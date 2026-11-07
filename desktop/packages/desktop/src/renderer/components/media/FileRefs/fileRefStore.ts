/**
 * What the window knows of the files replies name: the main process's answers (common/chat/fileRefs/fileRefBridge.ts),
 * kept by folder and reference so a conversation's replies ask once. Asking is batched: the references every reply on
 * screen wants within a moment go in one call per folder. A reply never waits on it: it draws plain code first, and
 * the links when the answers come.
 *
 * An answer that a file is missing is asked again after a few seconds, when a reply wants it (the model may write the
 * file after naming it); one that found a file after a minute. Opening a file that has gone since marks it missing.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  FILE_REF_BATCH_LIMIT,
  fileRefBridge,
  type FileRefAnswer,
  type FileRefOpened,
} from '@/common/chat/fileRefs/fileRefBridge';
import type { KyrnResult } from '@/common/kyrn/errors';
import { isElectronDesktop, isMacOS, isWindows } from '@/renderer/utils/platform';

const MISSING_FOR_MS = 5_000;
const FOUND_FOR_MS = 60_000;
const BATCH_DELAY_MS = 30;
const MOST_KEPT = 5_000;

type Kept = { answer: FileRefAnswer; at: number };

const kept = new Map<string, Kept>();
const asking = new Set<string>();
const queued = new Map<string, Set<string>>();
let timer: ReturnType<typeof setTimeout> | undefined;
let version = 0;
const listeners = new Set<() => void>();

const keyOf = (cwd: string, ref: string): string => `${cwd}\u0000${ref}`;

const changed = (): void => {
  version += 1;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const fresh = (entry: Kept | undefined, now: number): boolean =>
  entry !== undefined && now - entry.at < (entry.answer.state === 'found' ? FOUND_FOR_MS : MISSING_FOR_MS);

function keep(key: string, answer: FileRefAnswer, at: number): void {
  kept.delete(key);
  kept.set(key, { answer, at });
  // The oldest go first (a Map keeps the order things were set in).
  while (kept.size > MOST_KEPT) kept.delete(kept.keys().next().value as string);
}

async function ask(cwd: string, refs: string[]): Promise<void> {
  for (let start = 0; start < refs.length; start += FILE_REF_BATCH_LIMIT) {
    const batch = refs.slice(start, start + FILE_REF_BATCH_LIMIT);
    let answers: FileRefAnswer[] | undefined;
    try {
      // One batch at a time: the main process answers each in order.
      // eslint-disable-next-line no-await-in-loop
      const result = await fileRefBridge.resolve.invoke(cwd ? { cwd, refs: batch } : { refs: batch });
      if (result.ok) answers = result.data;
    } catch {
      // No answer: the references stay plain code, and are asked again the next time a reply wants them.
    }
    const at = Date.now();
    batch.forEach((ref, index) => {
      const key = keyOf(cwd, ref);
      asking.delete(key);
      const answer = answers?.[index];
      if (answer) keep(key, answer, at);
    });
    if (answers) changed();
  }
}

function flush(): void {
  timer = undefined;
  const batches = [...queued];
  queued.clear();
  for (const [cwd, refs] of batches) void ask(cwd, [...refs]);
}

/** Asks the main process about the references it has no fresh answer for. `cwd` '' when the folder is not known. */
export function requestFileRefs(cwd: string, refs: readonly string[], now: number = Date.now()): void {
  if (!isElectronDesktop()) return;
  for (const ref of refs) {
    const key = keyOf(cwd, ref);
    if (asking.has(key) || fresh(kept.get(key), now)) continue;
    asking.add(key);
    const folder = queued.get(cwd) ?? new Set<string>();
    folder.add(ref);
    queued.set(cwd, folder);
  }
  if (queued.size > 0 && timer === undefined) timer = setTimeout(flush, BATCH_DELAY_MS);
}

/** What is known of a reference: the main process's answer, or nothing yet. */
export function fileRefAnswer(cwd: string, ref: string): FileRefAnswer | undefined {
  return kept.get(keyOf(cwd, ref))?.answer;
}

/**
 * The answers for a reply's references, asked for when missing or stale. The map is the same object until one of
 * this reply's answers changes, so an answer for another reply draws nothing again here.
 */
export function useFileRefAnswers(cwd: string, refs: readonly string[]): ReadonlyMap<string, FileRefAnswer> {
  const current = useSyncExternalStore(subscribe, () => version);
  const asked = refs.join('\u0000');
  useEffect(() => {
    requestFileRefs(cwd, asked ? asked.split('\u0000') : []);
  }, [asked, cwd]);
  const answered = useMemo(() => {
    void current;
    const pairs: Array<[string, FileRefAnswer]> = [];
    for (const ref of asked ? asked.split('\u0000') : []) {
      const answer = fileRefAnswer(cwd, ref);
      if (answer) pairs.push([ref, answer]);
    }
    return JSON.stringify(pairs);
  }, [asked, current, cwd]);
  return useMemo(() => new Map(JSON.parse(answered) as Array<[string, FileRefAnswer]>), [answered]);
}

/** A file named in replies is gone: every reference that found it reads missing until it is asked again. */
export function forgetFile(path: string): void {
  const at = Date.now();
  let any = false;
  for (const [key, entry] of kept) {
    if (entry.answer.state === 'found' && entry.answer.path === path) {
      kept.set(key, { answer: { state: 'missing' }, at });
      any = true;
    }
  }
  if (any) changed();
}

/** Opens a file in its default app (a program is shown in its folder); a file that has gone is forgotten. */
export async function openFileRef(path: string): Promise<KyrnResult<FileRefOpened>> {
  const result = await fileRefBridge.open.invoke({ path });
  if (result.ok === false && result.code === 'notFound') forgetFile(path);
  return result;
}

/** Shows a file in Finder, File Explorer or the file manager; a file that has gone is forgotten. */
export async function revealFileRef(path: string): Promise<KyrnResult<void>> {
  const result = await fileRefBridge.reveal.invoke({ path });
  if (result.ok === false && result.code === 'notFound') forgetFile(path);
  return result;
}

/** Which file manager "Show in …" names. */
export type RevealPlatform = 'mac' | 'windows' | 'linux';

export const revealPlatform = (): RevealPlatform => (isMacOS() ? 'mac' : isWindows() ? 'windows' : 'linux');

/** Test hook: forget every answer and every pending question. */
export function resetFileRefsForTest(): void {
  kept.clear();
  asking.clear();
  queued.clear();
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  changed();
}
