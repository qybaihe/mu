/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSeedableTeamWorkspace, seedDispatchRulesIn, seedTeamApprovalIn } from '@process/services/team/teamDispatch';
import { TEAM_DISPATCH_RULES_VERSION } from '@/common/chat/team/teamDispatch/dispatchRules';

/**
 * The main process's seeding service (process/services/team/teamDispatch/): the
 * merge rules themselves are covered in dispatchRules.test.ts; this is the fs
 * side — the file it writes, ENOENT as empty, the second call being free, and
 * the workspace gate that keeps a renderer-supplied path inside the app's own
 * team folders.
 */

const dirs: string[] = [];
/** A fresh data dir; a valid seeded workspace is a child of its `teams/` root. */
const dataDir = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mu-team-dispatch-')));
  dirs.push(dir);
  return dir;
};
/** A team workspace folder under `dataDir`'s teams root, created like `teams.cjs add` would. */
const teamWorkspaceIn = (root: string, folder = 'test-team'): string => {
  const workspace = join(root, 'teams', folder);
  mkdirSync(workspace, { recursive: true });
  return workspace;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('isSeedableTeamWorkspace', () => {
  it('accepts the teams/ root teams.cjs builds and the backend temp folders under aionui/conversations/', () => {
    const dir = dataDir();
    expect(isSeedableTeamWorkspace(join(dir, 'teams', 'CNS-查重队-mwmaz8gl'), dir)).toBe(true);
    expect(
      isSeedableTeamWorkspace(
        join(dir, 'aionui', 'conversations', 'users', 'u1', '2026', '11', '19', 'acp-temp-aedf82ea'),
        dir
      )
    ).toBe(true);
  });

  it('rejects a path escape outside the data dir, and the data dir itself', () => {
    const dir = dataDir();
    expect(isSeedableTeamWorkspace('E:/Temp/evil', dir)).toBe(false);
    expect(isSeedableTeamWorkspace(join(dir, 'teams', '..', '..', 'elsewhere'), dir)).toBe(false);
    expect(isSeedableTeamWorkspace(join(dir, 'teams'), dir)).toBe(false);
    expect(isSeedableTeamWorkspace(dir, dir)).toBe(false);
  });

  it('rejects a sibling that merely shares a prefix with a team root', () => {
    const dir = dataDir();
    expect(isSeedableTeamWorkspace(join(dir, 'teams2', 'evil'), dir)).toBe(false);
    expect(isSeedableTeamWorkspace(join(dir, 'aionui', 'conversations-backup', 'evil'), dir)).toBe(false);
  });

  it('rejects the shapes fileRefs bars a renderer path on: relative, empty, control characters, overlong', () => {
    const dir = dataDir();
    expect(isSeedableTeamWorkspace(join('teams', 'x'), dir)).toBe(false);
    expect(isSeedableTeamWorkspace('', dir)).toBe(false);
    expect(
      isSeedableTeamWorkspace(
        `${join(dir, 'teams', 'x')}
`,
        dir
      )
    ).toBe(false);
    expect(isSeedableTeamWorkspace('x'.repeat(4097), dir)).toBe(false);
  });
});

describe('seedDispatchRulesIn', () => {
  it('creates AGENTS.md with a trailing newline in a workspace that has none', async () => {
    const dir = dataDir();
    const workspace = teamWorkspaceIn(dir);
    await expect(seedDispatchRulesIn(workspace, { dataDir: dir })).resolves.toBe(true);
    const content = readFileSync(join(workspace, 'AGENTS.md'), 'utf8');
    expect(content).toContain(`<!-- mu-team-dispatch v${TEAM_DISPATCH_RULES_VERSION} -->`);
    expect(content.endsWith('<!-- /mu-team-dispatch -->\n')).toBe(true);
  });

  it('appends the block to a user-written AGENTS.md and keeps the user text first', async () => {
    const dir = dataDir();
    const workspace = teamWorkspaceIn(dir);
    writeFileSync(join(workspace, 'AGENTS.md'), '# 用户自己写的\n', 'utf8');
    await expect(seedDispatchRulesIn(workspace, { dataDir: dir })).resolves.toBe(true);
    const content = readFileSync(join(workspace, 'AGENTS.md'), 'utf8');
    expect(content.indexOf('# 用户自己写的')).toBeLessThan(
      content.indexOf(`<!-- mu-team-dispatch v${TEAM_DISPATCH_RULES_VERSION} -->`)
    );
  });

  it('does not rewrite a file that already holds the current block', async () => {
    const dir = dataDir();
    const workspace = teamWorkspaceIn(dir);
    await seedDispatchRulesIn(workspace, { dataDir: dir });
    const file = join(workspace, 'AGENTS.md');
    const first = readFileSync(file, 'utf8');
    await expect(seedDispatchRulesIn(workspace, { dataDir: dir })).resolves.toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(first);
  });

  it('leaves a user CLAUDE.md untouched: mu reads AGENTS.md, so both coexist', async () => {
    const dir = dataDir();
    const workspace = teamWorkspaceIn(dir);
    writeFileSync(join(workspace, 'CLAUDE.md'), '# Claude Code 时代的旧规矩\n', 'utf8');
    await expect(seedDispatchRulesIn(workspace, { dataDir: dir })).resolves.toBe(true);
    expect(readFileSync(join(workspace, 'CLAUDE.md'), 'utf8')).toBe('# Claude Code 时代的旧规矩\n');
    expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf8')).toContain(
      `<!-- mu-team-dispatch v${TEAM_DISPATCH_RULES_VERSION} -->`
    );
  });

  it('refuses a workspace outside the app data dir instead of writing it', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'mu-team-dispatch-evil-')));
    dirs.push(outside);
    const file = join(outside, 'AGENTS.md');
    await expect(seedDispatchRulesIn(outside, { dataDir: dataDir() })).rejects.toMatchObject({ code: 'invalid' });
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });

  it('refuses a `..` escape that resolves outside the teams root', async () => {
    const dir = dataDir();
    const escape = join(dir, 'teams', '..', 'positions', '_supervisor');
    await expect(seedDispatchRulesIn(escape, { dataDir: dir })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('seedTeamApprovalIn (batch L ③)', () => {
  it('seeds the approval block beside the dispatch rules in the same AGENTS.md', async () => {
    const dir = dataDir();
    const workspace = teamWorkspaceIn(dir);
    await seedDispatchRulesIn(workspace, { dataDir: dir });
    await expect(seedTeamApprovalIn(workspace, 'risk-only', { dataDir: dir })).resolves.toBe(true);
    const content = readFileSync(join(workspace, 'AGENTS.md'), 'utf8');
    expect(content).toContain('<!-- mu-team-dispatch v');
    expect(content).toContain('<!-- mu-team-approval v1 -->');
    expect(content).toContain('本群审批模式：risk-only');
    // Same mode again is free; a mode switch rewrites in place.
    await expect(seedTeamApprovalIn(workspace, 'risk-only', { dataDir: dir })).resolves.toBe(false);
    await expect(seedTeamApprovalIn(workspace, 'none', { dataDir: dir })).resolves.toBe(true);
    const switched = readFileSync(join(workspace, 'AGENTS.md'), 'utf8');
    expect(switched).toContain('本群审批模式：none');
    expect(switched).not.toContain('本群审批模式：risk-only');
    expect(switched).toContain('<!-- mu-team-dispatch v'); // the sibling block survived
  });

  it('refuses a workspace outside the app data dir like the dispatch seed', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'mu-team-approval-evil-')));
    dirs.push(outside);
    await expect(seedTeamApprovalIn(outside, 'all', { dataDir: dataDir() })).rejects.toMatchObject({ code: 'invalid' });
  });
});
