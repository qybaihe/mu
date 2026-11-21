/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Writes the dispatch rules block into a workspace's AGENTS.md. All fs work
 * for team-dispatch seeding lives here; what lands in the file is decided by
 * the pure merge in common/chat/teamDispatch/dispatchRules.ts. A CLAUDE.md a
 * user keeps in the workspace is not read by a mu lead (pi reads one context
 * file per directory, AGENTS.md first) and is left alone.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { KyrnError } from '@/common/kyrn/errors';
import { hasControlCharacter } from '@/common/chat/fileRefs/pathLike';
import { planDispatchSeed } from '@/common/chat/team/teamDispatch/dispatchRules';
import { planTeamApprovalSeed, type TeamApprovalMode } from '@/common/chat/team/teamDispatch/approvalCore';

/**
 * The project-memory file the lead runtime reads (a mu lead reads AGENTS.md,
 * first of pi's candidates; validated live against both a Claude Code lead in
 * CLAUDE.md and an all-mu team lead in AGENTS.md).
 */
const RULES_FILE_NAME = 'AGENTS.md';

/** The same length bar fileRefs holds a renderer-supplied path to. */
const LONGEST_WORKSPACE = 4096;

/**
 * The app-owned roots a seeded team workspace lives under, relative to the
 * data dir: `teams/` (a workspace `teams.cjs add` picked) and the backend's
 * per-team temp folders under `aionui/conversations/` (a team created over
 * the UI, whose workspace the backend assigns). Anything else — the
 * `E:/Temp/...` an explicit-backend-API caller may have registered — is not
 * ours to write.
 */
const WORKSPACE_ROOTS = ['teams', join('aionui', 'conversations')] as const;

/** Windows compares paths case-insensitively; a prefix test must too, or `e:/` slips past `E:/`. */
const fold = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path);
/** Whether `below` sits strictly inside `root` (never the root itself): `resolve` folds `..` in first. */
const isInside = (root: string, below: string): boolean => {
  const rel = relative(fold(root), fold(below));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/**
 * Whether the window's `workspace` is a team workspace this app owns: one
 * line, not absurdly long, absolute, and resolving strictly inside one of the
 * app data dir's team roots. This is the wire-input bar of `team-dispatch.seed`
 * — the window only ever relays a workspace the backend reported, so a value
 * that fails this is either a corrupt answer or a compromised renderer aiming
 * the append at an arbitrary path (#442's shape).
 */
export function isSeedableTeamWorkspace(workspace: string, dataDir: string): boolean {
  if (workspace === '' || workspace.length > LONGEST_WORKSPACE) return false;
  if (hasControlCharacter(workspace) || !isAbsolute(workspace)) return false;
  const resolved = resolve(workspace);
  const root = resolve(dataDir);
  return WORKSPACE_ROOTS.some((name) => isInside(join(root, name), resolved));
}

/**
 * Seeds `workspace`'s rules file and reports whether it changed. A missing
 * file is an empty one; any other read or write failure propagates. The
 * workspace must be one of the app's own team folders under `dataDir`
 * (`isSeedableTeamWorkspace`): a renderer-supplied path outside them is
 * refused, not written.
 */
export async function seedDispatchRulesIn(workspace: string, options: { dataDir: string }): Promise<boolean> {
  if (!isSeedableTeamWorkspace(workspace, options.dataDir))
    throw new KyrnError('invalid', 'The workspace is not a team workspace of this app', { workspace });
  const file = join(workspace, RULES_FILE_NAME);
  let existing: string | undefined;
  try {
    existing = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const plan = planDispatchSeed(existing);
  if (!plan.changed) return false;
  await mkdir(workspace, { recursive: true });
  await writeFile(file, `${plan.next}\n`, 'utf8');
  return true;
}

/**
 * Seeds the workspace's approval block — the group's risk-approval tier as
 * its own managed block in the same AGENTS.md (the dispatch rules' sibling;
 * a mode switch replaces the block in place, see approvalCore). Same
 * workspace bar as {@link seedDispatchRulesIn}.
 */
export async function seedTeamApprovalIn(
  workspace: string,
  mode: TeamApprovalMode,
  options: { dataDir: string }
): Promise<boolean> {
  if (!isSeedableTeamWorkspace(workspace, options.dataDir))
    throw new KyrnError('invalid', 'The workspace is not a team workspace of this app', { workspace });
  const file = join(workspace, RULES_FILE_NAME);
  let existing: string | undefined;
  try {
    existing = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const plan = planTeamApprovalSeed(existing, mode);
  if (!plan.changed) return false;
  await mkdir(workspace, { recursive: true });
  await writeFile(file, `${plan.next}\n`, 'utf8');
  return true;
}
