/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The supervisor workspace on the main-process side. The supervisor is the
 * built-in position that opens temporary teams: not a file of the user's
 * library, so the desktop ships its workspace whole — the injected rules
 * (`AGENTS.override.md`, the seam the harness reads at a session's start)
 * and the `teams.cjs` maintenance script the supervisor agent runs. The
 * TEAMS.md index that script maintains lives in the shared folder
 * (`positions/_shared/`) — one global index the supervisor and every library
 * position's copy of the script read and write. Ensuring the workspace is
 * also the lifecycle reconciliation point: the canonical rewrite retires
 * teams whose TTL passed while nobody looked.
 */
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getPlatformServices } from '@/common/platform';
import positionsScriptSource from '@/common/chat/team/supervisor/positions.cjs?raw';
import { shippedTeamsScript } from './teamScripts';
import {
  POSITIONS_SCRIPT_NAME,
  SHARED_TEAMS_FOLDER,
  SUPERVISOR_FOLDER,
  TEAMS_FILE_NAME,
  TEAMS_SCRIPT_NAME,
  TEAM_TTL_DEFAULT_DAYS,
  buildSupervisorOverrideContent,
  buildTeamsFile,
  clampTeamTtlDays,
  expiryAfterTtl,
  isTeamActive,
  parseTeamsFile,
  type SupervisorTeam,
} from '@/common/chat/team/supervisor/supervisorCore';
import { POSITION_LIBRARY_DIR, scanPositionLibrary } from '@process/services/team/positions/positionService';

/** The injected rules file: pi's first-priority context file of the workspace. */
const RULES_FILE_NAME = 'AGENTS.override.md';

/** Writes `content` unless the file already holds it; whether the file changed. */
async function writeIfChanged(file: string, content: string): Promise<boolean> {
  let existing: string | undefined;
  try {
    existing = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing === content) return false;
  await writeFile(file, content, 'utf8');
  return true;
}

/**
 * Prepares the supervisor workspace: the folder plus its app-owned files —
 * rules (rebuilt from the library so the roster stays current), the two
 * scripts (rewritten when the app ships new ones: the team maintenance CLI
 * and the read-only roster listing), and the teams index (created as an empty
 * index, or rewritten into its canonical form, which retires expired teams).
 * The clock is injectable for tests.
 */
export async function ensureSupervisorWorkspaceIn(
  options: { libraryDir: string; dataDir: string },
  now: () => number = Date.now
): Promise<{ workspace: string; changed: boolean }> {
  const roster = await scanPositionLibrary(options.libraryDir);
  const workspace = join(options.dataDir, 'positions', SUPERVISOR_FOLDER);
  await mkdir(workspace, { recursive: true });

  let content;
  let changed = false;
  content = `${buildSupervisorOverrideContent(roster)}\n`;
  changed = (await writeIfChanged(join(workspace, RULES_FILE_NAME), content)) || changed;
  changed = (await writeIfChanged(join(workspace, TEAMS_SCRIPT_NAME), shippedTeamsScript)) || changed;
  changed = (await writeIfChanged(join(workspace, POSITIONS_SCRIPT_NAME), positionsScriptSource)) || changed;

  // The index lives in the shared folder, where every position's teams.cjs
  // also finds it. A pre-shared index in the supervisor workspace moves there
  // once (the file itself, then the canonical rewrite retires as usual).
  const sharedDir = join(options.dataDir, 'positions', SHARED_TEAMS_FOLDER);
  const teamsFile = join(sharedDir, TEAMS_FILE_NAME);
  const legacyTeamsFile = join(workspace, TEAMS_FILE_NAME);
  await mkdir(sharedDir, { recursive: true });
  const readOptional = async (file: string): Promise<string | undefined> => {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return undefined;
    }
  };
  let existing = await readOptional(teamsFile);
  const legacy = await readOptional(legacyTeamsFile);
  if (existing === undefined && legacy !== undefined) {
    existing = legacy;
    changed = true;
  }
  const next = `${buildTeamsFile(parseTeamsFile(existing ?? ''), now())}\n`;
  changed = (await writeIfChanged(teamsFile, next)) || changed;
  if (legacy !== undefined) {
    // The moved file is app-owned (marker-managed); the shared copy replaces it.
    await rm(legacyTeamsFile, { force: true });
  }
  return { workspace, changed };
}

/** Prepares the supervisor workspace under the app data dir, from the user's library. */
export const ensureSupervisorWorkspace = (): Promise<{ workspace: string; changed: boolean }> =>
  ensureSupervisorWorkspaceIn({
    libraryDir: POSITION_LIBRARY_DIR,
    dataDir: getPlatformServices().paths.getDataDir(),
  });

/** The index file's path under a data dir. */
const teamsFileOf = (dataDir: string): string => join(dataDir, 'positions', SHARED_TEAMS_FOLDER, TEAMS_FILE_NAME);

/** The shared index's rows, an empty index when the file is missing. */
async function readTeamsIn(dataDir: string): Promise<SupervisorTeam[]> {
  try {
    return parseTeamsFile(await readFile(teamsFileOf(dataDir), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [];
  }
}

/** The lifecycle a registration carries: the creating surface's choice (the
 *  modal's or popover's ttlDays/permanent), absent when a refresh re-registers
 *  an existing team — then the row keeps the lifecycle it already has. */
export type RegisterTeamLifecycle = { ttlDays?: number; permanent?: boolean };

/** The next `N` past every name an active row already uses, so `send --team <name>` stays unambiguous. */
const uniqueNameAmong = (name: string, teams: readonly SupervisorTeam[], now: number): string => {
  const taken = new Set(teams.filter((team) => isTeamActive(team, now)).map((team) => team.name));
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
};

/** Writes the index's canonical form: the shared reconcile every mutation ends with. */
async function writeTeamsIn(dataDir: string, teams: readonly SupervisorTeam[], at: number): Promise<void> {
  await mkdir(join(dataDir, 'positions', SHARED_TEAMS_FOLDER), { recursive: true });
  await writeFile(teamsFileOf(dataDir), `${buildTeamsFile(teams, at)}\n`, 'utf8');
}

/**
 * Upserts one team row in the shared index (by team id): a manually created
 * group chat's registration, or the refresh a member change writes. A new row
 * starts its lifecycle at the creating surface's choice (default 7 days); an
 * existing active row's touch refreshes it with the team's OWN ttlDays — a
 * membership edit must not stretch or shorten the lifecycle — while a retired
 * row only takes the new positions: a membership edit must not resurrect a
 * team past its TTL. The clock is injectable for tests.
 */
export async function registerSupervisorTeamIn(
  options: { dataDir: string },
  params: { name: string; positions: string[]; teamId: string; leadConversationId: string } & RegisterTeamLifecycle,
  now: () => number = Date.now
): Promise<SupervisorTeam[]> {
  const at = now();
  const teams = await readTeamsIn(options.dataDir);
  const existing = teams.find((team) => team.teamId === params.teamId);
  let next: SupervisorTeam;
  if (existing) {
    // A retired row only takes the new positions: a membership edit must not
    // resurrect a team past its TTL, whatever lifecycle params came along.
    if (!isTeamActive(existing, at)) {
      next = { ...existing, positions: params.positions };
    } else {
      const ttlDays = params.ttlDays !== undefined ? clampTeamTtlDays(params.ttlDays) : existing.ttlDays;
      const permanent = params.permanent ?? existing.permanent;
      next = {
        ...existing,
        name: uniqueNameAmong(params.name, teams, at),
        positions: params.positions,
        ttlDays,
        permanent,
        // A permanent row's recorded expiry is informational; a normal row's
        // touch extends to `now + ttlDays`.
        expiresAt: permanent ? existing.expiresAt : expiryAfterTtl(ttlDays, at),
        lastUsedAt: at,
      };
    }
  } else {
    const ttlDays = clampTeamTtlDays(params.ttlDays ?? TEAM_TTL_DEFAULT_DAYS);
    const permanent = params.permanent ?? false;
    next = {
      name: uniqueNameAmong(params.name, teams, at),
      positions: params.positions,
      createdAt: at,
      lastUsedAt: at,
      expiresAt: expiryAfterTtl(ttlDays, at),
      ttlDays,
      permanent,
      teamId: params.teamId,
      leadConversationId: params.leadConversationId,
    };
  }
  const rows = teams.filter((team) => team.teamId !== params.teamId).concat(next);
  await writeTeamsIn(options.dataDir, rows, at);
  return rows;
}

/** Registers one team in the shared index under the app data dir. */
export const registerSupervisorTeam = (
  params: {
    name: string;
    positions: string[];
    teamId: string;
    leadConversationId: string;
  } & RegisterTeamLifecycle
): Promise<SupervisorTeam[]> => registerSupervisorTeamIn({ dataDir: getPlatformServices().paths.getDataDir() }, params);

/**
 * Sets one team's lifecycle from the monitor card's popover: the day count
 * (clamped 1-365) and/or the permanent flag, applied to the row it finds. A
 * non-permanent row's expiry restarts from `now` with the new ttlDays; a
 * permanent row's recorded expiry stays as it was. An unknown team id changes
 * nothing. The clock is injectable for tests.
 */
export async function setTeamLifecycleIn(
  options: { dataDir: string },
  params: { teamId: string } & RegisterTeamLifecycle,
  now: () => number = Date.now
): Promise<SupervisorTeam[]> {
  const at = now();
  const teams = await readTeamsIn(options.dataDir);
  const rows: SupervisorTeam[] = [];
  for (const team of teams) {
    if (team.teamId !== params.teamId) {
      rows.push(team);
      continue;
    }
    const ttlDays = params.ttlDays !== undefined ? clampTeamTtlDays(params.ttlDays) : team.ttlDays;
    const permanent = params.permanent ?? team.permanent;
    rows.push({ ...team, ttlDays, permanent, expiresAt: permanent ? team.expiresAt : expiryAfterTtl(ttlDays, at) });
  }
  await writeTeamsIn(options.dataDir, rows, at);
  return rows;
}

/** Sets one team's lifecycle under the app data dir. */
export const setTeamLifecycle = (
  params: {
    teamId: string;
  } & RegisterTeamLifecycle
): Promise<SupervisorTeam[]> => setTeamLifecycleIn({ dataDir: getPlatformServices().paths.getDataDir() }, params);

/**
 * The shared index as it stands on disk: every team the supervisor flow
 * recorded, active and retired, with its TTL. Read per call — the file is
 * small and teams.cjs rewrites it between calls, so no cache would stay
 * honest. A missing or marker-less file is an empty index, not an error.
 */
export const listSupervisorTeams = async (): Promise<SupervisorTeam[]> =>
  readTeamsIn(getPlatformServices().paths.getDataDir());
