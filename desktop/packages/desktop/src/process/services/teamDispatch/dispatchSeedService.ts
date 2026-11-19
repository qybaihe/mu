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
import { join } from 'node:path';
import { planDispatchSeed } from '@/common/chat/teamDispatch/dispatchRules';

/**
 * The project-memory file the lead runtime reads (a mu lead reads AGENTS.md,
 * first of pi's candidates; validated live against both a Claude Code lead in
 * CLAUDE.md and an all-mu team lead in AGENTS.md).
 */
const RULES_FILE_NAME = 'AGENTS.md';

/**
 * Seeds `workspace`'s rules file and reports whether it changed. A missing
 * file is an empty one; any other read or write failure propagates.
 */
export async function seedDispatchRules(workspace: string): Promise<boolean> {
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
