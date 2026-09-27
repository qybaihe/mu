/**
 * A project inside WSL runs mu inside WSL. On Windows, a conversation whose folder Windows shows as
 * `\\wsl.localhost\<distribution>\...` (or the older `\\wsl$\...`) gets its harness started in that distribution, next
 * to its files and its Linux tools, instead of the Windows mu reaching into them over the network share.
 *
 * - mu has to be installed in the distribution (`npm i -g mu-agent` there). The start script looks for it on the login
 *   PATH, then where nvm and npm put it, and says what to install when it is missing.
 * - It shares the Windows side's agent folder (`MU_AGENT_DIR`): one sign-in, one judgment configuration and one set
 *   of settings for both. The session file stays where the app keeps it. WSL translates both paths itself: WSLENV
 *   carries them with the `/p` flag.
 * - Keys the harness reads from its `.env` come from the distribution's own `~/.mu/.env`.
 * - The app's local judge and browser bridge listen on Windows' loopback, which WSL reaches in mirrored networking
 *   mode only.
 */

/** Where a Windows path points inside WSL, when it does. */
export function wslLocation(path: string): { distro: string; path: string } | undefined {
  const match = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(\\.*)?$/i.exec(path.replace(/\//g, '\\'));
  if (!match) return undefined;
  return { distro: match[1], path: (match[2] || '\\').replace(/\\/g, '/') };
}

/**
 * Runs inside the distribution with bash as a login shell. Finds mu (a non-interactive shell skips the part of
 * ~/.bashrc where nvm usually sets itself up), then replaces itself with it.
 */
export const WSL_START = [
  'mu_bin=$(command -v mu 2>/dev/null)',
  'if [ -z "$mu_bin" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; mu_bin=$(command -v mu 2>/dev/null); fi',
  'if [ -z "$mu_bin" ]; then for candidate in "$HOME"/.nvm/versions/node/*/bin/mu "$HOME/.npm-global/bin/mu" /usr/local/bin/mu; do if [ -x "$candidate" ]; then mu_bin=$candidate; break; fi; done; fi',
  'if [ -z "$mu_bin" ]; then echo "mu is not installed in this WSL distribution. Install it there: npm i -g mu-agent" >&2; exit 127; fi',
  // The folder of mu's own Node goes first, so the launcher's `#!/usr/bin/env node` finds the Node mu was installed with.
  'PATH="$(dirname "$mu_bin"):$PATH"; export PATH',
  'exec "$mu_bin" --mode rpc ${MU_ACP_SESSION:+--session "$MU_ACP_SESSION"}',
].join('\n');

/** A WSLENV entry's variable name, without its flags. */
const entryName = (entry: string): string => entry.split('/')[0];

/** WSLENV with these entries, keeping what the user already shares; ours win for a name in both (a path needs /p). */
export function withWslenv(current: string | undefined, entries: string[]): string {
  const ours = new Set(entries.map(entryName));
  const kept = (current ?? '').split(':').filter((entry) => entry && !ours.has(entryName(entry)));
  return [...kept, ...entries].join(':');
}

/**
 * How a harness for this WSL location starts: `wsl.exe` in the distribution and folder, running WSL_START, with the
 * app's variables carried across.
 *
 * @param env what the adapter adds for this session (plain values: session id, language, permission mode)
 * @param agentDir the Windows side's agent folder, shared with the harness in WSL
 * @param session the session file, a Windows path
 * @param home a Windows folder to start wsl.exe in (a network share cannot be a process's working directory)
 */
export function wslLaunch(input: {
  location: { distro: string; path: string };
  session: string | undefined;
  env: Readonly<Record<string, string>>;
  agentDir: string;
  inherited: string | undefined;
  home: string;
}): { command: string; args: string[]; cwd: string; env: Record<string, string> } {
  const { location, session, env, agentDir, inherited, home } = input;
  const carried = [...Object.keys(env), 'MU_AGENT_DIR/p', ...(session ? ['MU_ACP_SESSION/p'] : [])];
  return {
    command: 'wsl.exe',
    args: ['--distribution', location.distro, '--cd', location.path, '--exec', 'bash', '-lc', WSL_START],
    cwd: home,
    env: {
      ...env,
      MU_AGENT_DIR: agentDir,
      ...(session ? { MU_ACP_SESSION: session } : {}),
      WSLENV: withWslenv(inherited, carried),
    },
  };
}
