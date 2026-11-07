/**
 * What the work panel reads by a project folder instead of by an app conversation: a native conversation
 * (docs/native-host-ui.md) has no backend conversation or project, only the folder its session works in (`cwd`). Its
 * lessons tab reads mu's experience library by that folder, as the classic tab reads it by the conversation's workspace
 * (common/kyrn/lessons.ts); its files tab lists that folder, one directory at a time. The main process answers both
 * (process/bridge/kyrnBridge.ts), with `KyrnResult` like every mu channel.
 *
 * A folder is a full path; a path inside it is relative, with `/` between names, and never leaves it.
 */
import { bridge } from '../platform/bridge';
import type { KyrnResult } from './errors';
import type { LessonEdit, LessonsView } from './lessons';

/** One name in a listed directory. `path`: relative to the folder, `/` between names. */
export type FolderEntry = { name: string; path: string; kind: 'dir' | 'file' };

/** A directory of the folder: its entries, folders first, each group by name; `more` counts those left out. */
export type FolderListing = { path: string; entries: FolderEntry[]; more: number };

/** The most entries one listing carries; the rest are counted in `more`. */
export const FOLDER_LISTING_LIMIT = 1000;

/** What a folder listing leaves out: git's own folder and macOS's folder notes. */
export const FOLDER_HIDDEN: ReadonlySet<string> = new Set(['.git', '.DS_Store']);

/**
 * A folder's files for quick open (Cmd/Ctrl+P): relative paths, `/` between names. `more`: the folder held more than
 * FOLDER_FIND_LIMIT, or than the walk reads, and the rest were left out.
 */
export type FolderFiles = { paths: string[]; more: boolean };

/** The most files quick open takes from one folder. */
export const FOLDER_FIND_LIMIT = 20000;

/** What runs a folder's package.json scripts: its `packageManager`, else the lockfile it has, else npm. */
export type ScriptRunner = 'npm' | 'pnpm' | 'yarn' | 'bun';

/**
 * The scripts of the package.json at the top of a folder, in its order, those a shell takes by name as they are (a
 * letter, digit, `_` or `.` first, then also `:@/+-`); `more` counts those left out, by their name or past
 * FOLDER_SCRIPTS_LIMIT.
 */
export type FolderScripts = { runner: ScriptRunner; scripts: { name: string; command: string }[]; more: number };

/** The most scripts a folder offers to run. */
export const FOLDER_SCRIPTS_LIMIT = 40;

export const kyrnFolderBridge = {
  /** A folder's lessons: its own and those for everywhere, in any state. */
  lessons: bridge.buildProvider<KyrnResult<LessonsView>, { cwd: string }>('kyrn.folder.lessons'),
  /** A new text or the retirement of one of a folder's lessons, appended as one line; the lessons after it. */
  lessonsChange: bridge.buildProvider<KyrnResult<LessonsView>, LessonEdit & { cwd: string }>(
    'kyrn.folder.lessons.change'
  ),
  /** One directory of a folder: `path` '' for the folder itself. */
  files: bridge.buildProvider<KyrnResult<FolderListing>, { cwd: string; path: string }>('kyrn.folder.files'),
  /** Every file of a folder worth opening by name: git's own list in a repository, else a bounded walk. */
  find: bridge.buildProvider<KyrnResult<FolderFiles>, { cwd: string }>('kyrn.folder.find'),
  /** The scripts of the folder's package.json; null when it has none, or no package.json mu can read. */
  scripts: bridge.buildProvider<KyrnResult<FolderScripts | null>, { cwd: string }>('kyrn.folder.scripts'),
};
