import type { Dirent, Stats } from 'node:fs';
import { open, readdir, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { JsonObject } from '../../../../common/utils/nativeHost/records.ts';
import type { SessionFolders } from './folders.ts';
import { addEntry, clip, parseEntry, readHeader, titleOf, type SessionSummary } from './summary.ts';

/**
 * The conversation list from pi's session files (docs/native-host.md, M2), the command line's sessions included,
 * without pi: no host starts for it. A file is read in part, and its summary kept by its size and time:
 *
 * - a small file whole;
 * - a larger one from its start until its first user message (the system prompt comes first and can be large), and
 *   its last TAIL_BYTES for the latest name and message time;
 * - a file that only grew since (pi appends) from where the last read stopped.
 *
 * A name given in the middle of a large file, far from both ends, is not seen until the file is read again from
 * scratch (it then shows the older name, or the first message). pi's own list reads every file whole.
 */

/** A session as the list shows it. */
export type StoredSession = {
  id: string;
  cwd: string;
  file: string;
  /** The session's name, else the start of its first user message, else ''. */
  title: string;
  /** The session's name (`session_info`), when it has one. */
  name?: string;
  /** The start of its first user message, when it has one. */
  firstText?: string;
  createdAt: number;
  /**
   * The latest user or assistant message's time, as pi's list takes it; without one, the session's start, or the
   * file's modification time when only the file's ends were read.
   */
  updatedAt: number;
  parentSession?: string;
  /** How many `message` entries the file holds; left out when its middle was not read. */
  messageCount?: number;
};

/** A file this size or smaller is read whole. */
const WHOLE_BYTES = 256 * 1024;
/** The start of a larger file is read in chunks of this size, until its first user message... */
const HEAD_CHUNK = 64 * 1024;
/** ...but no further than this. */
const HEAD_LIMIT = 1024 * 1024;
/** How much of a larger file's end is read. */
const TAIL_BYTES = 256 * 1024;
/** A file that grew by more than this is read afresh (start and end) instead of from where the last read stopped. */
const GROWTH_LIMIT = 4 * 1024 * 1024;
/** How many files are read at once. */
const CONCURRENCY = 16;
const NEWLINE = 0x0a;

type Scan = {
  mtimeMs: number;
  size: number;
  /** Where the next unread line starts: the byte before it is a newline (or it is 0). */
  scannedTo: number;
  /** Every line before `scannedTo` was read: nothing in the middle was skipped. */
  contiguous: boolean;
  summary: SessionSummary;
  /** The latest message time among the file's last lines read. */
  recentActivity?: number;
};

async function readRange(handle: FileHandle, start: number, end: number): Promise<Buffer> {
  const buffer = Buffer.alloc(Math.max(0, end - start));
  let filled = 0;
  while (filled < buffer.length) {
    // oxlint-disable-next-line no-await-in-loop -- a read returns what it has; the rest is asked for after it
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled === buffer.length ? buffer : buffer.subarray(0, filled);
}

/** The complete lines of `buffer` from `from` on, with where each ends (after its newline). */
function* linesOf(buffer: Buffer, from: number): Generator<{ text: string; end: number }> {
  let start = from;
  for (;;) {
    const newline = buffer.indexOf(NEWLINE, start);
    if (newline < 0) return;
    yield { text: buffer.toString('utf8', start, newline), end: newline + 1 };
    start = newline + 1;
  }
}

const later = (current: number | undefined, time: number | undefined): number | undefined =>
  time === undefined ? current : Math.max(current ?? time, time);

/** Folds an entry into `scan`'s summary; its message time counts as recent when `recent`. */
function take(scan: Scan, entry: JsonObject, recent: boolean): void {
  const time = addEntry(scan.summary, entry, { firstMessage: scan.contiguous });
  if (recent) scan.recentActivity = later(scan.recentActivity, time);
}

/** A file read from scratch: whole when small, else its start and its end. Undefined when it is no session. */
async function scanFresh(handle: FileHandle, stats: Stats): Promise<Scan | undefined> {
  const size = stats.size;
  const whole = size <= WHOLE_BYTES;
  const limit = whole ? size : Math.min(size, HEAD_LIMIT);
  let scan: Scan | undefined;
  let pending: Buffer = Buffer.alloc(0);
  let pendingAt = 0;
  let offset = 0;
  let consumed = 0;
  let found = false;
  while (!found && offset < limit) {
    // oxlint-disable-next-line no-await-in-loop -- the start of a file, chunk after chunk, until its first message
    const chunk = await readRange(handle, offset, Math.min(limit, offset + (whole ? limit : HEAD_CHUNK)));
    if (chunk.length === 0) break;
    offset += chunk.length;
    const buffer = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    for (const line of linesOf(buffer, 0)) {
      start = line.end;
      consumed = pendingAt + line.end;
      const entry = parseEntry(line.text);
      if (!scan) {
        const header = readHeader(entry);
        if (!header) return undefined;
        scan = { mtimeMs: stats.mtimeMs, size, scannedTo: 0, contiguous: true, summary: { header } };
        continue;
      }
      if (entry) take(scan, entry, whole);
      if (!whole && scan.summary.firstMessage !== undefined) {
        found = true;
        break;
      }
    }
    pending = buffer.subarray(start);
    pendingAt += start;
  }
  if (!scan) return undefined;
  scan.scannedTo = consumed;
  if (whole) return scan;
  // The end: the latest name and message time.
  const tailStart = Math.max(consumed, size - TAIL_BYTES);
  scan.contiguous = tailStart === consumed;
  // With the byte before it: a newline there means the tail starts a line.
  const base = scan.contiguous ? tailStart : tailStart - 1;
  const buffer = await readRange(handle, base, size);
  let from = 0;
  if (!scan.contiguous) {
    const newline = buffer.indexOf(NEWLINE);
    if (newline < 0) return scan;
    from = newline + 1;
  }
  // Without a complete line after the skipped middle, the next read goes on from the end of the start.
  for (const line of linesOf(buffer, from)) {
    scan.scannedTo = base + line.end;
    const entry = parseEntry(line.text);
    if (entry) take(scan, entry, true);
  }
  return scan;
}

/** The lines a file gained since `cached` was read, or undefined when it has to be read afresh. */
async function scanGrown(handle: FileHandle, stats: Stats, cached: Scan): Promise<Scan | undefined> {
  if (stats.size <= cached.size || stats.size - cached.scannedTo > GROWTH_LIMIT) return undefined;
  const base = Math.max(0, cached.scannedTo - 1);
  const buffer = await readRange(handle, base, stats.size);
  // The byte before where the last read stopped is a newline, unless the file was written anew since.
  if (cached.scannedTo > 0 && buffer[0] !== NEWLINE) return undefined;
  const scan: Scan = { ...cached, mtimeMs: stats.mtimeMs, size: stats.size, summary: { ...cached.summary } };
  for (const line of linesOf(buffer, cached.scannedTo > 0 ? 1 : 0)) {
    scan.scannedTo = base + line.end;
    const entry = parseEntry(line.text);
    if (entry) take(scan, entry, true);
  }
  return scan;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      // oxlint-disable-next-line no-await-in-loop -- a pool of `limit` workers, each one item at a time
      results[index] = await map(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const jsonl = (name: string): boolean => name.endsWith('.jsonl');

export class SessionStore {
  private readonly folders: () => SessionFolders;
  private readonly scans = new Map<string, Scan>();
  private byId = new Map<string, StoredSession>();
  private listing: Promise<StoredSession[]> | undefined;

  /** `folders` is asked at every list: a changed session folder setting takes effect at the next one. */
  constructor(folders: () => SessionFolders) {
    this.folders = folders;
  }

  /** Every session, newest first. Two lists asked at once share one reading. */
  list(): Promise<StoredSession[]> {
    this.listing ??= this.readAll().finally(() => {
      this.listing = undefined;
    });
    return this.listing;
  }

  /** The session with this id, from the last list, else from a new one. */
  async find(id: string): Promise<StoredSession | undefined> {
    const known = this.byId.get(id);
    if (known) {
      const fresh = await this.describe(known.file);
      if (fresh?.id === id) return fresh;
    }
    await this.list();
    return this.byId.get(id);
  }

  /** One session file as the list shows it, or undefined when it is gone or no session. */
  async describe(file: string): Promise<StoredSession | undefined> {
    try {
      return await this.read(file);
    } catch {
      return undefined;
    }
  }

  private async readAll(): Promise<StoredSession[]> {
    const files = await this.files(this.folders());
    const sessions = (await mapLimit(files, CONCURRENCY, (file) => this.describe(file))).filter(
      (session): session is StoredSession => session !== undefined
    );
    const listed = new Set(files);
    for (const file of this.scans.keys()) if (!listed.has(file)) this.scans.delete(file);
    // The same id twice (a copied file): the newer one.
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    const byId = new Map<string, StoredSession>();
    for (const session of sessions) if (!byId.has(session.id)) byId.set(session.id, session);
    this.byId = byId;
    return sessions;
  }

  /** The session files: one folder per project in the sessions folder, and a configured folder's files. */
  private async files(folders: SessionFolders): Promise<string[]> {
    const projects = await readdir(folders.sessionsDir, { withFileTypes: true }).catch((): Dirent[] => []);
    const nested = await mapLimit(
      projects.filter((each) => each.isDirectory()),
      CONCURRENCY,
      async (project) => {
        const dir = path.join(folders.sessionsDir, project.name);
        const names = await readdir(dir).catch((): string[] => []);
        return names.filter(jsonl).map((name) => path.join(dir, name));
      }
    );
    const custom = folders.customDir
      ? (await readdir(folders.customDir).catch((): string[] => []))
          .filter(jsonl)
          .map((name) => path.join(folders.customDir as string, name))
      : [];
    return [...new Set([...nested.flat(), ...custom])];
  }

  private async read(file: string): Promise<StoredSession | undefined> {
    const stats = await stat(file);
    if (!stats.isFile()) return undefined;
    let scan = this.scans.get(file);
    if (!scan || scan.mtimeMs !== stats.mtimeMs || scan.size !== stats.size) {
      const handle = await open(file, 'r');
      try {
        scan = (scan && (await scanGrown(handle, stats, scan))) ?? (await scanFresh(handle, stats));
      } finally {
        await handle.close();
      }
      if (!scan) {
        this.scans.delete(file);
        return undefined;
      }
      this.scans.set(file, scan);
    }
    const { header, name, firstMessage } = scan.summary;
    const firstText = clip(firstMessage ?? '');
    const createdAt = Number.isFinite(header.timestamp) ? header.timestamp : stats.birthtimeMs || stats.mtimeMs;
    return {
      id: header.id,
      cwd: header.cwd,
      file,
      title: titleOf(scan.summary),
      ...(name !== undefined ? { name } : {}),
      ...(firstText ? { firstText } : {}),
      createdAt,
      // No message read: when the whole file was read, it has none, and it was last active when it began (pi's rule);
      // when its end had none, it was written last when it was changed.
      updatedAt:
        scan.recentActivity ??
        (scan.contiguous && Number.isFinite(header.timestamp) ? header.timestamp : stats.mtimeMs),
      ...(header.parentSession ? { parentSession: header.parentSession } : {}),
      // Every line was read: the count is the file's. Otherwise the middle's messages are not known.
      ...(scan.contiguous ? { messageCount: scan.summary.messageCount ?? 0 } : {}),
    };
  }
}
