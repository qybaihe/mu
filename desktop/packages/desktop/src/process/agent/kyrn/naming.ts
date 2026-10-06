import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The project was called KYRN until 2026-09-21. The same three rules as the harness
 * (`packages/kyrn-judge/src/naming.ts` in the KYRN repository), so both sides agree on where things are.
 *
 * Module, channel, i18n-key and stored event names (`kyrn.*`) were not renamed: they are not shown to anyone,
 * and the event names are already written in session and activity files.
 */

/** `MU_<name>`, or the `KYRN_<name>` spelling when the new one is unset or empty. */
export function muEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`MU_${name}`] || env[`KYRN_${name}`] || undefined;
}

/**
 * `~/.mu`, or `~/.kyrn` on a machine whose home has not been moved yet. Nothing here creates `~/.mu` beside an
 * existing `~/.kyrn`: that would split the login, the session list and the desktop's session mappings in two.
 */
export function muHome(home: string = homedir()): string {
  const current = join(home, '.mu');
  const legacy = join(home, '.kyrn');
  return existsSync(current) || !existsSync(legacy) ? current : legacy;
}

/**
 * mu's agent folder, decided as mu's launcher decides it (`agentDirFor` in `kyrn/bin/mu.mjs`), so the app reads the
 * files the mu it runs reads: `MU_AGENT_DIR`, else pi's own `MU_CODING_AGENT_DIR`, else `agent` in mu's home.
 */
export function muAgentDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return muEnv('AGENT_DIR', env) || muEnv('CODING_AGENT_DIR', env) || join(muHome(home), 'agent');
}

/**
 * The judgment configuration of an agent directory: `mu.json`, or `kyrn.json` while that is the only one there.
 * Saving goes to the file that was read, so there is never a second file shadowing the first.
 */
export function configPath(agentDir: string): string {
  const current = join(agentDir, 'mu.json');
  const legacy = join(agentDir, 'kyrn.json');
  return existsSync(current) || !existsSync(legacy) ? current : legacy;
}
