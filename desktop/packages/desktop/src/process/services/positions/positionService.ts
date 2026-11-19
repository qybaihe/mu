/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The position roster on the main-process side: reading the user's position
 * library (`~/.mu/agent/agents`, read-only — never written) and preparing each
 * position's dedicated workspace under the app's data dir. The workspace's
 * AGENTS.override.md is the injection seam the harness reads at a session's
 * start (the highest-priority context file of the working directory), so it is
 * regenerated from the library whenever it changed and rewritten before a
 * position conversation opens.
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getPlatformServices } from '@/common/platform';
import { shippedTeamsScript } from '@process/services/supervisor/teamScripts';
import {
  buildPositionOverrideContent,
  parsePositionDocument,
  type PositionInfo,
} from '@/common/chat/positions/positionLibraryCore';

/** The user's position library. Read-only: the library is the user's, not ours. */
export const POSITION_LIBRARY_DIR = join(homedir(), '.mu', 'agent', 'agents');

/** The injected gate file: pi's first-priority context file of the workspace. */
const GATE_FILE_NAME = 'AGENTS.override.md';

/** The team maintenance script the position's gate rules reference (on-demand team forming). */
const TEAMS_SCRIPT_NAME = 'teams.cjs';

/** Folder names stay filesystem-safe even for a position name with odd characters. */
export const safeFolderName = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, '-');

/** Cache of the last scan of one library directory, reused until its mtime moves. */
const cacheByDir = new Map<string, { dirMtimeMs: number; positions: PositionInfo[] }>();

/**
 * The roster as one library directory defines it: every position file, in name
 * order. Empty when the directory does not exist; a read that fails skips that
 * file for this scan (the next scan retries). Repeated scans of an unchanged
 * directory are free.
 */
export async function scanPositionLibrary(libraryDir: string): Promise<PositionInfo[]> {
  let dirStat;
  try {
    dirStat = await stat(libraryDir);
  } catch {
    return [];
  }
  if (!dirStat.isDirectory()) return [];

  const dirMtimeMs = dirStat.mtimeMs;
  const cached = cacheByDir.get(libraryDir);
  if (cached && cached.dirMtimeMs === dirMtimeMs) return cached.positions;

  const files = (await readdir(libraryDir)).filter((name) => name.toLowerCase().endsWith('.md')).sort();
  const positions: PositionInfo[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(join(libraryDir, file), 'utf8');
    } catch {
      continue;
    }
    const position = parsePositionDocument(file, content);
    if (position) positions.push(position);
  }
  cacheByDir.set(libraryDir, { dirMtimeMs, positions });
  return positions;
}

/**
 * Prepares a position's workspace: the folder, the injected gate file
 * (rewritten when the library changed it) and the `teams.cjs` team
 * maintenance script (rewritten when the app ships a new one) — the
 * position's on-demand team-forming tool, sharing one TEAMS.md index with
 * the supervisor (positions/_shared/). Throws when the name is not in the
 * library.
 */
export async function ensurePositionWorkspaceIn(
  name: string,
  options: { libraryDir: string; dataDir: string }
): Promise<{ workspace: string; changed: boolean }> {
  const positions = await scanPositionLibrary(options.libraryDir);
  const position = positions.find((candidate) => candidate.name === name);
  if (!position) throw new Error(`position not in library: ${name}`);

  const workspace = join(options.dataDir, 'positions', safeFolderName(name));
  await mkdir(workspace, { recursive: true });

  let changed = false;
  const file = join(workspace, GATE_FILE_NAME);
  const next = `${buildPositionOverrideContent(position, positions)}\n`;
  let existing: string | undefined;
  try {
    existing = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing !== next) {
    await writeFile(file, next, 'utf8');
    changed = true;
  }

  const scriptFile = join(workspace, TEAMS_SCRIPT_NAME);
  let scriptExisting: string | undefined;
  try {
    scriptExisting = await readFile(scriptFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (scriptExisting !== shippedTeamsScript) {
    await writeFile(scriptFile, shippedTeamsScript, 'utf8');
    changed = true;
  }
  return { workspace, changed };
}

/** The user's roster, from the user's position library. */
export const listPositions = (): Promise<PositionInfo[]> => scanPositionLibrary(POSITION_LIBRARY_DIR);

/** Prepares a position's workspace under the app data dir, from the user's library. */
export const ensurePositionWorkspace = (name: string): Promise<{ workspace: string; changed: boolean }> =>
  ensurePositionWorkspaceIn(name, {
    libraryDir: POSITION_LIBRARY_DIR,
    dataDir: getPlatformServices().paths.getDataDir(),
  });
