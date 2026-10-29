import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { KyrnError } from '../../../common/kyrn/errors';
import {
  GIT_AREAS,
  GIT_CHANGE_LIMIT,
  GIT_DIFF_LIMIT,
  GIT_MESSAGE_LIMIT,
  GIT_OUTPUT_LIMIT,
  type FolderGitCommit,
  type FolderGitDiff,
  type FolderGitStatus,
  type GitArea,
} from '../../../common/kyrn/gitBridge';
import { parseStatus } from './parseStatus';
import { firstLine, GitNotStarted, gitRunner, type GitRunner } from './runGit';

/*
 * The 源码 tab of a native conversation (common/kyrn/gitBridge.ts): the repository of the conversation's folder, read
 * afresh for every answer with the git the app's PATH finds. What is written is only what the person asks for in the
 * tab: files staged or taken out of the index, and commits, with the repository's hooks. Nothing is discarded or
 * pushed. A repository nested inside the folder's own is not looked for.
 */

/** A quick answer: finding the repository, the version. */
const QUICK_MS = 5_000;
/** A status or a diff in a large repository. */
const SLOW_MS = 15_000;
/** What is read of a status: far more than GIT_CHANGE_LIMIT changes' worth. */
const STATUS_BYTES = 8 * 1024 * 1024;
const LONGEST_PATH = 4096;
/** A stage or an unstage of many files in a large repository. */
const INDEX_MS = 60_000;
/** A commit, with the hooks it runs (a formatter, a linter, the tests). */
const COMMIT_MS = 5 * 60_000;
/** What a commit and its hooks may write before the rest is dropped. */
const COMMIT_BYTES = 4 * 1024 * 1024;
/** Files per git run when staging or unstaging, so the command line stays short (Windows takes about 32,000 characters). */
const PATHS_PER_RUN = 100;

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

/** A commit message as the screen sends it: text, not empty once trimmed, at most GIT_MESSAGE_LIMIT characters. */
function readMessage(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\u0000') || value.length > GIT_MESSAGE_LIMIT)
    throw new KyrnError('invalid', 'Invalid message');
  const message = value.replace(/\r\n?/g, '\n').trim();
  if (!message) throw new KyrnError('invalid', 'The message is empty');
  return message;
}

/** The end of what git wrote, at most GIT_OUTPUT_LIMIT bytes, from a whole line on. */
function tail(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= GIT_OUTPUT_LIMIT) return text.trim();
  const end = bytes.subarray(bytes.length - GIT_OUTPUT_LIMIT).toString('utf8');
  const start = end.indexOf('\n');
  return (start < 0 ? end : end.slice(start + 1)).trim();
}

/** `items` in runs of `size`. */
const runsOf = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

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
  stage: (request: { cwd: unknown; paths: unknown }) => Promise<void>;
  unstage: (request: { cwd: unknown; paths: unknown }) => Promise<void>;
  commit: (request: { cwd: unknown; message: unknown; all?: unknown }) => Promise<FolderGitCommit>;
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

  /** The repository of a folder the person acts in: there must be one git can read. */
  async function repositoryOf(cwd: unknown): Promise<string> {
    const found = await rootOf(readFolder(cwd));
    if (!('root' in found)) throw new KyrnError('invalid', 'The folder is not in a repository git can read');
    return found.root;
  }

  /** Files named by the screen: at least one, at most GIT_CHANGE_LIMIT, each inside the repository. */
  function readPaths(root: string, value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > changeLimit)
      throw new KyrnError('invalid', 'Invalid paths');
    return [...new Set(value.map((path) => readPath(root, path)))];
  }

  /** `git <args> -- <paths>`, a run per PATHS_PER_RUN files; git's first line when one refuses. */
  async function onIndex(root: string, args: string[], paths: string[]): Promise<void> {
    for (const part of runsOf(paths, PATHS_PER_RUN)) {
      // One after another: each run takes the index's lock.
      // eslint-disable-next-line no-await-in-loop
      const result = await run([...args, '--', ...part], { cwd: root, timeoutMs: INDEX_MS, maxBytes: 1024 * 1024 });
      if (result.code !== 0)
        throw new KyrnError('unknown', firstLine(result.stderr) || `git ${args[0]} ended with ${result.code}`);
    }
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

    async stage({ cwd, paths }) {
      const root = await repositoryOf(cwd);
      // `-A`: a file deleted in the working tree is staged as deleted.
      await onIndex(root, ['add', '-A'], readPaths(root, paths));
    },

    async unstage({ cwd, paths }) {
      const root = await repositoryOf(cwd);
      // `reset`, not `restore --staged`: it also works before the first commit, taking a new file out of the index.
      await onIndex(root, ['reset', '-q'], readPaths(root, paths));
    },

    async commit({ cwd, message, all }) {
      const root = await repositoryOf(cwd);
      const text = readMessage(message);
      if (all === true) {
        const added = await run(['add', '-A'], { cwd: root, timeoutMs: INDEX_MS, maxBytes: 1024 * 1024 });
        if (added.code !== 0)
          throw new KyrnError('unknown', firstLine(added.stderr) || `git add ended with ${added.code}`);
      }
      // As the person's own git: their name, signing and hooks. `--no-edit` never waits for an editor.
      const made = await run(['commit', '--no-edit', '-m', text], {
        cwd: root,
        timeoutMs: COMMIT_MS,
        maxBytes: COMMIT_BYTES,
        asPerson: true,
      });
      if (made.code !== 0) return { committed: false, output: tail(`${made.stdout}\n${made.stderr}`) };
      const head = await run(['log', '-1', '--format=%h%x00%s'], {
        cwd: root,
        timeoutMs: QUICK_MS,
        maxBytes: 64 * 1024,
      });
      const [commit = '', subject = ''] = head.stdout.trim().split('\u0000');
      return { committed: true, commit, subject };
    },
  };
}
