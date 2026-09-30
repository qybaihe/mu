import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { KyrnError } from '../../../common/kyrn/errors';
import {
  GIT_AREAS,
  GIT_CHANGE_LIMIT,
  GIT_DIFF_LIMIT,
  type FolderGitDiff,
  type FolderGitStatus,
  type GitArea,
} from '../../../common/kyrn/gitBridge';
import { parseStatus } from './parseStatus';
import { firstLine, GitNotStarted, gitRunner, type GitRunner } from './runGit';

/*
 * The 源码 tab of a native conversation (common/kyrn/gitBridge.ts): the repository of the conversation's folder, read
 * afresh for every answer with the git the app's PATH finds. Nothing is written: no stage, no discard, no commit.
 * A repository nested inside the folder's own is not looked for.
 */

/** A quick answer: finding the repository, the version. */
const QUICK_MS = 5_000;
/** A status or a diff in a large repository. */
const SLOW_MS = 15_000;
/** What is read of a status: far more than GIT_CHANGE_LIMIT changes' worth. */
const STATUS_BYTES = 8 * 1024 * 1024;
const LONGEST_PATH = 4096;

const NOT_A_REPOSITORY = /not a git repository/i;

/** A folder as the screen sends it: a full path, one line, not too long. */
function readFolder(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > LONGEST_PATH ||
    value.includes('\u0000') ||
    /[\r\n]/.test(value) ||
    !isAbsolute(value)
  )
    throw new KyrnError('invalid', 'Invalid folder');
  return value;
}

/** A path in the repository: relative, `/` between names, never above the root. */
function readPath(root: string, value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > LONGEST_PATH ||
    value.includes('\u0000') ||
    /[\r\n]/.test(value) ||
    isAbsolute(value)
  )
    throw new KyrnError('invalid', 'Invalid path');
  const within = relative(root, resolve(root, ...value.split('/').filter(Boolean)));
  if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
    throw new KyrnError('invalid', 'The path leaves the repository');
  return within.split(sep).join('/');
}

/**
 * A diff's text within `limit` bytes. `partial`: git was stopped mid-way, so the last line may be cut; the text then
 * ends at the last whole line, as a text over the limit does.
 */
function cut(text: string, limit: number, partial: boolean): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= limit && !partial) return text;
  const head = bytes.subarray(0, limit).toString('utf8');
  const end = head.lastIndexOf('\n');
  return end < 0 ? '' : head.slice(0, end + 1);
}

const BINARY = /^(Binary files .* differ|GIT binary patch)$/m;

export type FolderGitOptions = {
  run?: GitRunner;
  /** The most changes a status carries (tests make it small). */
  changeLimit?: number;
  /** The most bytes of a diff. */
  diffLimit?: number;
};

export type FolderGit = {
  status: (cwd: unknown) => Promise<FolderGitStatus>;
  diff: (request: { cwd: unknown; path: unknown; area: unknown; from?: unknown }) => Promise<FolderGitDiff>;
};

export function createFolderGit({
  run = gitRunner(),
  changeLimit = GIT_CHANGE_LIMIT,
  diffLimit = GIT_DIFF_LIMIT,
}: FolderGitOptions = {}): FolderGit {
  /** The folder's repository root, or why there is none. A folder that is gone is a failure, not a missing git. */
  async function rootOf(
    folder: string
  ): Promise<{ root: string } | { state: 'no-git'; reason: string } | { state: 'not-repository' }> {
    const exists = await stat(folder).then(
      (info) => info.isDirectory(),
      () => false
    );
    if (!exists) throw new KyrnError('unreadable', 'The folder does not exist', { file: folder });
    let found;
    try {
      found = await run(['rev-parse', '--show-toplevel'], { cwd: folder, timeoutMs: QUICK_MS, maxBytes: 64 * 1024 });
    } catch (error) {
      if (error instanceof GitNotStarted) return { state: 'no-git', reason: error.reason };
      throw error;
    }
    if (found.code === 0 && found.stdout.trim()) return { root: found.stdout.trim() };
    if (NOT_A_REPOSITORY.test(found.stderr)) return { state: 'not-repository' };
    // Something else refused: git itself, if it cannot even say its version (the Xcode stub without its licence).
    const version = await run(['--version'], { cwd: folder, timeoutMs: QUICK_MS, maxBytes: 64 * 1024 });
    if (version.code !== 0)
      return {
        state: 'no-git',
        reason: firstLine(version.stderr) || firstLine(version.stdout) || `exit ${version.code}`,
      };
    throw new KyrnError('unknown', firstLine(found.stderr) || `git rev-parse ended with ${found.code}`);
  }

  // Two windows asking about one folder at once share one read.
  const reading = new Map<string, Promise<FolderGitStatus>>();

  async function readStatus(folder: string): Promise<FolderGitStatus> {
    const found = await rootOf(folder);
    if (!('root' in found)) return found;
    const result = await run(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], {
      cwd: found.root,
      timeoutMs: SLOW_MS,
      maxBytes: STATUS_BYTES,
    });
    if (result.code !== 0)
      throw new KyrnError('unknown', firstLine(result.stderr) || `git status ended with ${result.code}`);
    const { branch, changes } = parseStatus(result.stdout, !result.overflow);
    return {
      state: 'repository',
      root: found.root,
      branch,
      changes: changes.slice(0, changeLimit),
      more: Math.max(0, changes.length - changeLimit),
      truncated: result.overflow,
    };
  }

  return {
    status(cwd) {
      const folder = readFolder(cwd);
      const pending = reading.get(folder);
      if (pending) return pending;
      const next = readStatus(folder).finally(() => reading.delete(folder));
      reading.set(folder, next);
      return next;
    },

    async diff({ cwd, path, area, from }) {
      const folder = readFolder(cwd);
      if (!GIT_AREAS.includes(area as GitArea)) throw new KyrnError('invalid', 'Invalid area');
      const found = await rootOf(folder);
      if (!('root' in found)) throw new KyrnError('invalid', 'The folder is not in a repository git can read');
      const file = readPath(found.root, path);
      const old = from === undefined || from === '' ? undefined : readPath(found.root, from);
      const plain = ['--no-color', '--no-ext-diff', '--no-textconv'];
      const args =
        area === 'staged'
          ? ['diff', '--cached', '-M', ...plain, '--', ...(old ? [old] : []), file]
          : area === 'unstaged'
            ? ['diff', ...plain, '--', file]
            : area === 'conflicted'
              ? ['diff', 'HEAD', ...plain, '--', file]
              : // A new file: all of it added, against nothing.
                ['diff', '--no-index', ...plain, '--', '/dev/null', file];
      const result = await run(args, { cwd: found.root, timeoutMs: SLOW_MS, maxBytes: diffLimit });
      // `--no-index` ends with 1 when the files differ, which a new file always does.
      if (result.code !== 0 && !(area === 'untracked' && result.code === 1))
        throw new KyrnError('unknown', firstLine(result.stderr) || `git diff ended with ${result.code}`);
      if (BINARY.test(result.stdout)) return { patch: '', binary: true, truncated: false };
      const patch = cut(result.stdout, diffLimit, result.overflow);
      return { patch, binary: false, truncated: result.overflow || patch.length < result.stdout.length };
    },
  };
}
