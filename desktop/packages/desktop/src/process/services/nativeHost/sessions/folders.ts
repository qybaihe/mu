import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { muEnv, muHome } from '../../../agent/kyrn/naming.ts';

/**
 * Where this computer's mu keeps its sessions, worked out without starting anything: no launcher import, no
 * `prepareLaunch` (which can start the local judge). The rules are the launcher's (`agentDirFor` and `muHome` in the
 * harness's kyrn/bin/mu.mjs) and pi's (its session folder in main.ts and session-manager.ts):
 *
 * - the agent folder is MU_AGENT_DIR, else MU_CODING_AGENT_DIR (either with the old KYRN_ spelling), else
 *   `<mu home>/agent`, where the mu home is `~/.mu` (or `~/.kyrn` on a machine not moved yet);
 * - pi keeps a session in `<agent folder>/sessions/--<project path>--/<time>_<id>.jsonl`, unless
 *   MU_CODING_AGENT_SESSION_DIR or the agent folder's settings (`sessionDir`) name a folder of their own, which then
 *   holds every project's sessions side by side.
 *
 * A project's own settings (`<project>/.mu/settings.json`) can name a session folder too; that folder is not known
 * before a project is, so its sessions are not listed.
 */
export type SessionFolders = {
  agentDir: string;
  /** `<agent folder>/sessions`: one folder per project inside. */
  sessionsDir: string;
  /** The session folder the configuration names, when it names one: sessions side by side inside. */
  customDir?: string;
};

/** `~` and `~/…` as the home, anything else as an absolute path (as pi's normalizePath does). */
function expand(dir: string, home: string): string {
  if (dir === '~') return home;
  if (dir.startsWith('~/') || dir.startsWith('~\\')) return path.join(home, dir.slice(2));
  return path.resolve(dir);
}

function settingsSessionDir(agentDir: string, readFile: (file: string) => string): string | undefined {
  try {
    const settings: unknown = JSON.parse(readFile(path.join(agentDir, 'settings.json')));
    const dir = (settings as { sessionDir?: unknown } | null)?.sessionDir;
    return typeof dir === 'string' && dir.trim() ? dir.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function sessionFolders(
  options: { env?: NodeJS.ProcessEnv; home?: string; readFile?: (file: string) => string } = {}
): SessionFolders {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const agentDir = path.resolve(
    muEnv('AGENT_DIR', env) || muEnv('CODING_AGENT_DIR', env) || path.join(muHome(home), 'agent')
  );
  const custom =
    env.MU_CODING_AGENT_SESSION_DIR ||
    settingsSessionDir(agentDir, options.readFile ?? ((file) => readFileSync(file, 'utf8')));
  return {
    agentDir,
    sessionsDir: path.join(agentDir, 'sessions'),
    ...(custom ? { customDir: expand(custom, home) } : {}),
  };
}

/** The real path of a folder, or the path as given when it cannot be resolved (it does not exist). */
function real(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

/**
 * Whether `file` is a session file (`.jsonl`) inside one of `folders`' session folders, symbolic links in the way
 * resolved: the only files a removal may touch.
 */
export function insideSessionFolders(folders: SessionFolders, file: string): boolean {
  if (path.extname(file) !== '.jsonl') return false;
  const resolved = path.join(real(path.dirname(file)), path.basename(file));
  return [folders.sessionsDir, folders.customDir]
    .filter((dir): dir is string => Boolean(dir))
    .some((dir) => {
      const relative = path.relative(real(dir), resolved);
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
}
