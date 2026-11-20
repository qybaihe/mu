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
  buildSupervisorOverrideContent,
  buildTeamsFile,
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

/** How long a fresh registration stays active: the same 7 days as teams.cjs. */
const TEAM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The next `N` past every name an active row already uses, so `send --team <name>` stays unambiguous. */
const uniqueNameAmong = (name: string, teams: readonly SupervisorTeam[], now: number): string => {
  const taken = new Set(teams.filter((team) => team.expiresAt > now).map((team) => team.name));
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
};

/**
 * Upserts one team row in the shared index (by team id): a manually created
 * group chat's registration, or the refresh a member change writes. A new row
 * starts its 7-day lifecycle; an existing active row's touch refreshes it,
 * while a retired row only takes the new positions — a membership edit must
 * not resurrect a team past its TTL. The clock is injectable for tests.
 */
export async function registerSupervisorTeamIn(
  options: { dataDir: string },
  params: { name: string; positions: string[]; teamId: string; leadConversationId: string },
  now: () => number = Date.now
): Promise<SupervisorTeam[]> {
  const at = now();
  const teams = await readTeamsIn(options.dataDir);
  const existing = teams.find((team) => team.teamId === params.teamId);
  let next: SupervisorTeam;
  if (existing) {
    const active = existing.expiresAt > at;
    next = {
      ...existing,
      name: active ? uniqueNameAmong(params.name, teams, at) : existing.name,
      positions: params.positions,
      ...(active ? { lastUsedAt: at, expiresAt: at + TEAM_TTL_MS } : {}),
    };
  } else {
    next = {
      name: uniqueNameAmong(params.name, teams, at),
      positions: params.positions,
      createdAt: at,
      lastUsedAt: at,
      expiresAt: at + TEAM_TTL_MS,
      teamId: params.teamId,
      leadConversationId: params.leadConversationId,
    };
  }
  const rows = teams.filter((team) => team.teamId !== params.teamId).concat(next);
  await mkdir(join(options.dataDir, 'positions', SHARED_TEAMS_FOLDER), { recursive: true });
  await writeFile(teamsFileOf(options.dataDir), `${buildTeamsFile(rows, at)}\n`, 'utf8');
  return rows;
}

/** Registers one team in the shared index under the app data dir. */
export const registerSupervisorTeam = (params: {
  name: string;
  positions: string[];
  teamId: string;
  leadConversationId: string;
}): Promise<SupervisorTeam[]> =>
  registerSupervisorTeamIn({ dataDir: getPlatformServices().paths.getDataDir() }, params);

/**
 * The shared index as it stands on disk: every team the supervisor flow
 * recorded, active and retired, with its TTL. Read per call — the file is
 * small and teams.cjs rewrites it between calls, so no cache would stay
 * honest. A missing or marker-less file is an empty index, not an error.
 */
export const listSupervisorTeams = async (): Promise<SupervisorTeam[]> =>
  readTeamsIn(getPlatformServices().paths.getDataDir());
