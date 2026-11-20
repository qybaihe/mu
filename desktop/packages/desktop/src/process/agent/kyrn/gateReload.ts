/**
 * Hot refresh of a conversation's gate file: the workspace's `AGENTS.override.md`, the context
 * file the app injects into every position workspace (the harness's first-priority context file
 * of its working directory). The adapter watches it for each live session and asks mu to
 * `reload` — pi re-reads the file and patches the changed prompt sections into the next request —
 * so new rules reach an open conversation without reopening it, without a visible message, and
 * without restarting the process. App writes (the workspace ensure) and hand edits both arrive
 * as the same directory event.
 */
import { watch } from 'node:fs';

/** The gate file whose changes a live conversation re-reads (see positionService.ts). */
export const GATE_FILE_NAME = 'AGENTS.override.md';

/** Watch events settle before a reload: an editor's or the app's save fires several. */
export const GATE_SETTLE_MS = 500;

/** Reads the gate file, or undefined when it is gone or cannot be read. */
export type GateReader = (file: string) => Promise<string | undefined>;

/** Asks the session's mu to re-read its resources (pi's `reload` RPC command). */
export type GateReloadFn = () => void;

/** The watch of one session's working directory: notice gate changes, reload once per change. */
export interface GateReload {
  /** A directory event named the gate file; a check follows once the burst settles. */
  changed(): void;
  /** Runs the settled check now: reload when the file no longer says what it last said. */
  settle(): Promise<void>;
  /** Stops watching and forgets the pending check. */
  close(): void;
}

/**
 * Watches `dir` for changes of the gate file and calls `reload` once per content change. The
 * caller hands in what the file said when the session started (`initial`, read synchronously at
 * spawn time — an async first read loses the race to the very change it should notice). Only a
 * content difference from the last seen text (an edit, the file appearing, or the file going
 * away) reloads — a rewrite with the same words, such as an ensure that found nothing changed,
 * does not. All reads and the watcher itself are best-effort: a directory that cannot be watched
 * simply has no hot refresh, and a session opened afterwards reads the file as it is.
 */
export function watchGate(
  dir: string,
  read: GateReader,
  reload: GateReloadFn,
  initial: string | undefined,
  settleMs: number = GATE_SETTLE_MS
): GateReload {
  let closed = false;
  let last = initial;
  let timer: NodeJS.Timeout | undefined;
  let settling: Promise<void> = Promise.resolve();
  const file = `${dir}/${GATE_FILE_NAME}`;
  /** One check after the burst of events settles; later bursts wait for it. */
  const schedule = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      settling = settling.then(() => gate.settle());
    }, settleMs);
  };
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(dir, (_event, filename) => {
      if (closed || !filename || filename.toLowerCase() !== GATE_FILE_NAME.toLowerCase()) return;
      schedule();
    });
  } catch {
    // The directory cannot be watched (gone, or a network path that refuses): no hot refresh.
  }
  const gate: GateReload = {
    changed: schedule,
    settle: async () => {
      if (closed) return;
      const content = await read(file);
      if (closed || content === last) return;
      last = content;
      reload();
    },
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher?.close();
    },
  };
  return gate;
}
