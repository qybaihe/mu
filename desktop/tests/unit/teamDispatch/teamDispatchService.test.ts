/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedDispatchRules } from '@process/services/teamDispatch';
import { TEAM_DISPATCH_RULES_VERSION } from '@/common/chat/teamDispatch/dispatchRules';

/**
 * The main process's seeding service (process/services/teamDispatch/): the
 * merge rules themselves are covered in dispatchRules.test.ts; this is the fs
 * side — the file it writes, ENOENT as empty, and the second call being free.
 */

const dirs: string[] = [];
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mu-team-dispatch-')));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('seedDispatchRules', () => {
  it('creates AGENTS.md with a trailing newline in a workspace that has none', async () => {
    const workspace = temp();
    await expect(seedDispatchRules(workspace)).resolves.toBe(true);
    const content = readFileSync(join(workspace, 'AGENTS.md'), 'utf8');
    expect(content).toContain(`<!-- mu-team-dispatch v${TEAM_DISPATCH_RULES_VERSION} -->`);
    expect(content.endsWith('<!-- /mu-team-dispatch -->\n')).toBe(true);
  });

  it('appends the block to a user-written AGENTS.md and keeps the user text first', async () => {
    const workspace = temp();
    writeFileSync(join(workspace, 'AGENTS.md'), '# 用户自己写的\n', 'utf8');
    await expect(seedDispatchRules(workspace)).resolves.toBe(true);
    const content = readFileSync(join(workspace, 'AGENTS.md'), 'utf8');
    expect(content.indexOf('# 用户自己写的')).toBeLessThan(
      content.indexOf(`<!-- mu-team-dispatch v${TEAM_DISPATCH_RULES_VERSION} -->`)
    );
  });

  it('does not rewrite a file that already holds the current block', async () => {
    const workspace = temp();
    await seedDispatchRules(workspace);
    const file = join(workspace, 'AGENTS.md');
    const first = readFileSync(file, 'utf8');
    await expect(seedDispatchRules(workspace)).resolves.toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(first);
  });

  it('leaves a user CLAUDE.md untouched: mu reads AGENTS.md, so both coexist', async () => {
    const workspace = temp();
    writeFileSync(join(workspace, 'CLAUDE.md'), '# Claude Code 时代的旧规矩\n', 'utf8');
    await expect(seedDispatchRules(workspace)).resolves.toBe(true);
    expect(readFileSync(join(workspace, 'CLAUDE.md'), 'utf8')).toBe('# Claude Code 时代的旧规矩\n');
    expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf8')).toContain(
      `<!-- mu-team-dispatch v${TEAM_DISPATCH_RULES_VERSION} -->`
    );
  });
});
