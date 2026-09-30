import { realpathSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * The pi session files AionCore's mu conversations already use (docs/native-host.md, M3), so the native list does not
 * show them a second time. The ACP adapter keeps a record per conversation, `<mu home>/acp-sessions/<ACP session
 * id>.json` = `{ cwd, file, permissions }` (KyrnAgent.ts), and an imported chat has one in
 * `acp-sessions/imports/<conversation>.json` (importChats.ts). Nothing is changed: a record that goes away brings its
 * session back into the native list. A record is read again only when its size or time changed.
 */

/** The adapter's records are named by its session ids (KyrnAgent.path). */
const RECORD = /^[a-f\d-]{36}\.json$/;
/** The import records by the backend's conversation ids (importChats.ts). */
const IMPORT_RECORD = /^[a-zA-Z0-9-]{1,80}\.json$/;

type Kept = { mtimeMs: number; size: number; files: string[] };

/** A path with the links on its way resolved, or as given when it cannot be (it does not exist). */
function real(file: string): string {
  try {
    return realpathSync.native(file);
  } catch {
    return file;
  }
}

/** A record's session file, as written and with its links resolved, so either spelling of a listed file matches. */
function spellings(file: unknown): string[] {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return [];
  const given = path.resolve(file);
  const resolved = real(given);
  return resolved === given ? [given] : [given, resolved];
}

export class AcpBindings {
  private readonly store: () => string | undefined;
  private readonly kept = new Map<string, Kept>();

  /** `store`: the adapter's record folder (`<mu home>/acp-sessions`), asked at each use. */
  constructor(store: () => string | undefined) {
    this.store = store;
  }

  /** The session files the records name. */
  async files(): Promise<Set<string>> {
    const bound = new Set<string>();
    const store = this.store();
    if (!store) return bound;
    const seen = new Set<string>();
    const folders: Array<[string, RegExp]> = [
      [store, RECORD],
      [path.join(store, 'imports'), IMPORT_RECORD],
    ];
    await Promise.all(
      folders.map(async ([folder, pattern]) => {
        const names = await readdir(folder).catch((): string[] => []);
        await Promise.all(
          names
            .filter((name) => pattern.test(name))
            .map(async (name) => {
              const record = path.join(folder, name);
              seen.add(record);
              for (const file of await this.read(record)) bound.add(file);
            })
        );
      })
    );
    for (const record of this.kept.keys()) if (!seen.has(record)) this.kept.delete(record);
    return bound;
  }

  private async read(record: string): Promise<string[]> {
    const stats = await stat(record).catch((): undefined => undefined);
    if (!stats?.isFile()) return [];
    const kept = this.kept.get(record);
    if (kept && kept.mtimeMs === stats.mtimeMs && kept.size === stats.size) return kept.files;
    let files: string[] = [];
    try {
      files = spellings((JSON.parse(await readFile(record, 'utf8')) as { file?: unknown } | null)?.file);
    } catch {
      // Not a record, or one being written: it binds nothing (its rename brings it back with a new time).
    }
    this.kept.set(record, { mtimeMs: stats.mtimeMs, size: stats.size, files });
    return files;
  }
}

/**
 * Whether a listed session file is one of `bound`: by its path as listed, or with the links of its folder resolved
 * (one look per folder).
 */
export function boundFile(bound: ReadonlySet<string>): (file: string) => boolean {
  if (bound.size === 0) return () => false;
  const folders = new Map<string, string>();
  return (file) => {
    const given = path.resolve(file);
    if (bound.has(given)) return true;
    const folder = path.dirname(given);
    let resolved = folders.get(folder);
    if (resolved === undefined) {
      resolved = real(folder);
      folders.set(folder, resolved);
    }
    return bound.has(path.join(resolved, path.basename(given)));
  };
}
