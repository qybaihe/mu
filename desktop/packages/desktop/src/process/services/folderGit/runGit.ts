import { execFile } from 'node:child_process';

/**
 * Runs git for the source tab of a native conversation: `execFile` with an argument array (never a shell), a timeout,
 * a cap on what is read, no optional locks (a status never takes the index lock the model's own git commands need),
 * no prompts, messages in English (they are matched, and shown only as a detail), and paths written as they are.
 */

/** How one run ended. `overflow`: git wrote more than `maxBytes`; it was stopped and `stdout` holds what came first. */
export type GitRun = { code: number; stdout: string; stderr: string; overflow: boolean };

/**
 * `asPerson`: git runs as it would in the person's terminal, for a commit and the hooks it runs: only the variables
 * that point at another repository are taken away, and prompts stay off. Their language, optional locks and pathspecs
 * are the person's, so a hook works as it does for them.
 */
export type GitRunOptions = {
  cwd: string;
  timeoutMs: number;
  maxBytes: number;
  asPerson?: boolean;
  /** What git reads on its standard input (a patch for `git apply -`); nothing when absent. */
  input?: string;
};

/** Runs `git <args>` with the options every call here takes. */
export type GitRunner = (args: string[], options: GitRunOptions) => Promise<GitRun>;

/** git could not be started at all (not found, not executable); `reason` is what the system said. */
export class GitNotStarted extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`git could not start: ${reason}`);
    this.reason = reason;
  }
}

/** git ran past its time. */
export class GitTimeout extends Error {}

/** Settings every run gets: paths as they are, and no file-system monitor a repository's config might start. */
const FIXED_CONFIG = ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false'];

/** The variables that would point git at another repository, index or object store. */
const ELSEWHERE = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
]);

/**
 * The environment git runs with: the app's, without the variables that would point git at another repository or
 * index (GIT_DIR, GIT_WORK_TREE, ...), plus no optional locks, no prompt, English, and pathspecs taken literally.
 * `asPerson` (a commit): the app's with only those that point elsewhere taken away, and no prompt.
 */
export function gitEnv(env: NodeJS.ProcessEnv, asPerson = false): NodeJS.ProcessEnv {
  if (asPerson) {
    const theirs = Object.fromEntries(Object.entries(env).filter(([name]) => !ELSEWHERE.has(name.toUpperCase())));
    return { ...theirs, GIT_TERMINAL_PROMPT: '0' };
  }
  const kept = Object.fromEntries(Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
  return {
    ...kept,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LITERAL_PATHSPECS: '1',
    LC_ALL: 'C',
    LANGUAGE: 'C',
  };
}

type ExecError = Error & { code?: number | string; killed?: boolean; signal?: string | null };

/**
 * The runner over `command` (the git on PATH by default) and `env` (the app's by default). A non-zero exit is an
 * answer, not a failure: the caller reads it.
 *
 * The app's environment is read at each run, not when the runner is made: the bridges are made while the main
 * process's modules load (process/utils/initBridge.ts), before `fixPath()` gives it the login shell's PATH, and git
 * is looked up on the PATH of the environment passed. A copy taken then would find the git of the PATH the app was
 * launched with (a Finder launch's is /usr/bin:/bin:..., where macOS has the Xcode stub).
 */
export function gitRunner({ command = 'git', env }: { command?: string; env?: NodeJS.ProcessEnv } = {}): GitRunner {
  return (args, { cwd, timeoutMs, maxBytes, asPerson, input }) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        command,
        [...FIXED_CONFIG, ...args],
        {
          cwd,
          env: gitEnv(env ?? process.env, asPerson),
          timeout: timeoutMs,
          maxBuffer: maxBytes,
          encoding: 'utf8',
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const failure = error as ExecError | null;
          if (!failure) return resolve({ code: 0, stdout, stderr, overflow: false });
          if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
            return resolve({ code: 0, stdout, stderr, overflow: true });
          if (typeof failure.code === 'string') return reject(new GitNotStarted(failure.message));
          if (failure.killed && failure.signal)
            return reject(new GitTimeout(`git ${args[0]} took longer than ${Math.round(timeoutMs / 1000)} s`));
          resolve({ code: typeof failure.code === 'number' ? failure.code : 1, stdout, stderr, overflow: false });
        }
      );
      // git reads to the end of its input: it gets what it is given, or nothing, so it never waits for more.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input ?? '');
    });
}

/** The first line of what git said, for a person to read. */
export const firstLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? '';
