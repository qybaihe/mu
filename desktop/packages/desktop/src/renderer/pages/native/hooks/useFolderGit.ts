import { useCallback, useEffect, useRef, useState } from 'react';
import { unwrap } from '@/common/kyrn/bridge';
import { kyrnGitBridge, type FolderGitStatus } from '@/common/kyrn/gitBridge';

/** Reads the page starts on its own (the tab shown, a run's end, the window's focus) are at least this far apart. */
export const FOLDER_GIT_GAP_MS = 2000;

/** The last answer, or why there is none; `reading` while git is asked again (the last answer stays on screen). */
export type FolderGitReading = { status?: FolderGitStatus; error?: string; reading: boolean };

/**
 * The last answer for each folder. The tab is drawn afresh each time it comes into view, so it starts from this and
 * shows what it showed at once, while git is asked again.
 */
const lastAnswers = new Map<string, FolderGitStatus>();

/** Forgets every kept answer (tests start from none). */
export const forgetFolderGit = (): void => lastAnswers.clear();

/**
 * The repository of a native conversation's folder, read through the main process (common/kyrn/gitBridge.ts) while the
 * source tab is in view: when it comes into view, after each run of the conversation (`refresh` changes), when the
 * window gets the focus back (an editor elsewhere may have changed a file), and when asked (`read`). Never polled.
 * One read at a time: a read asked for meanwhile runs once after it. The answer of an earlier read of the folder is
 * on screen until the new one comes. It is for one folder: a page shown another folder makes it again (`key`).
 */
export function useFolderGit(
  cwd: string,
  { visible, refresh }: { visible: boolean; refresh: string }
): FolderGitReading & { read: () => void } {
  const [state, setState] = useState<FolderGitReading>(() => ({ status: lastAnswers.get(cwd), reading: false }));
  const busy = useRef(false);
  const again = useRef(false);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);

  const read: () => Promise<void> = useCallback(async () => {
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    last.current = Date.now();
    setState((old) => ({ ...old, reading: true }));
    let next: FolderGitReading;
    try {
      const status = unwrap(await kyrnGitBridge.status.invoke({ cwd }));
      lastAnswers.set(cwd, status);
      next = { status, reading: false };
    } catch (error) {
      next = { error: error instanceof Error ? error.message : String(error), reading: false };
    }
    busy.current = false;
    if (!mounted.current) return;
    setState(next);
    if (again.current) {
      again.current = false;
      await read();
    }
  }, [cwd]);

  // A read the page starts itself waits until FOLDER_GIT_GAP_MS after the last one began.
  const soon = useCallback(() => {
    clearTimeout(timer.current);
    const wait = last.current + FOLDER_GIT_GAP_MS - Date.now();
    if (wait <= 0) void read();
    else timer.current = setTimeout(() => void read(), wait);
  }, [read]);

  useEffect(() => {
    if (visible) soon();
  }, [soon, visible, refresh]);

  useEffect(() => {
    if (!visible) return undefined;
    window.addEventListener('focus', soon);
    return () => window.removeEventListener('focus', soon);
  }, [soon, visible]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const readNow = useCallback((): void => {
    void read();
  }, [read]);
  return { ...state, read: readNow };
}
