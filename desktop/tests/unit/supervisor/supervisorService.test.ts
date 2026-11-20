/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSupervisorWorkspaceIn, registerSupervisorTeamIn } from '@process/services/team/supervisor';
import { TEAM_DISPATCH_RULES_VERSION } from '@/common/chat/team/teamDispatch/dispatchRules';
import {
  SHARED_TEAMS_FOLDER,
  SUPERVISOR_FOLDER,
  POSITIONS_SCRIPT_NAME,
  TEAMS_FILE_NAME,
  parseTeamsFile,
} from '@/common/chat/team/supervisor/supervisorCore';

/**
 * The supervisor workspace service (process/services/team/supervisor/): the
 * app-owned files it ships (rules, the two scripts, index), when it rewrites
 * them, and the reconciliation that retires expired teams. Real files in a
 * temp tree; the clock is injected.
 */

const dirs: string[] = [];
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mu-supervisor-')));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const positionFile = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n正文：${name} 说明书。`;

const setup = (teamsFile?: string): { library: string; dataDir: string; workspace: string; teamsFile: string } => {
  const library = join(temp(), 'library');
  mkdirSync(library, { recursive: true });
  writeFileSync(join(library, 'a-forwarder.md'), positionFile('forwarder', '货代岗'), 'utf8');
  writeFileSync(join(library, 'b-video.md'), positionFile('video-lab', '视频岗'), 'utf8');
  const dataDir = join(temp(), 'data');
  const workspace = join(dataDir, 'positions', SUPERVISOR_FOLDER);
  // The shared index — the pre-shared layout wrote it in the supervisor workspace.
  const sharedFile = join(dataDir, 'positions', SHARED_TEAMS_FOLDER, TEAMS_FILE_NAME);
  if (teamsFile !== undefined) {
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, TEAMS_FILE_NAME), teamsFile, 'utf8');
  }
  return { library, dataDir, workspace, teamsFile: sharedFile };
};

describe('ensureSupervisorWorkspaceIn', () => {
  it('ships the rules, the scripts and an empty teams index on first open', async () => {
    const { library, dataDir, workspace, teamsFile } = setup();
    const answer = await ensureSupervisorWorkspaceIn({ libraryDir: library, dataDir });
    expect(answer.workspace).toBe(workspace);
    expect(answer.changed).toBe(true);

    const rules = readFileSync(join(workspace, 'AGENTS.override.md'), 'utf8');
    expect(rules).toContain('主管（Supervisor）');
    expect(rules).toContain('- forwarder — 货代岗');
    expect(rules).toContain('- video-lab — 视频岗');

    const script = readFileSync(join(workspace, 'teams.cjs'), 'utf8');
    expect(script).toContain('cmdAdd');
    expect(script).toContain('/api/teams');
    expect(script).toContain(`<!-- mu-team-dispatch v${TEAM_DISPATCH_RULES_VERSION} -->`);
    expect(script).toContain('收尾落账（全体成员，硬规则）');
    // The shipped script resolves the shared index, not its own folder.
    expect(script).toContain("path.resolve(__dirname, '..', '_shared', 'TEAMS.md')");

    const rosterScript = readFileSync(join(workspace, POSITIONS_SCRIPT_NAME), 'utf8');
    expect(rosterScript).toContain('cmdList');
    expect(rosterScript).toContain('MU_POSITION_LIBRARY');
    expect(rosterScript).toContain('项目根');

    expect(parseTeamsFile(readFileSync(teamsFile, 'utf8'))).toEqual([]);
  });

  it('is a no-op when nothing changed', async () => {
    const { library, dataDir } = setup();
    await ensureSupervisorWorkspaceIn({ libraryDir: library, dataDir });
    const again = await ensureSupervisorWorkspaceIn({ libraryDir: library, dataDir });
    expect(again.changed).toBe(false);
  });

  it('rewrites the rules when the roster changes', async () => {
    const { library, dataDir, workspace } = setup();
    await ensureSupervisorWorkspaceIn({ libraryDir: library, dataDir });
    writeFileSync(join(library, 'c-worker.md'), positionFile('worker', '执行岗'), 'utf8');
    const { changed } = await ensureSupervisorWorkspaceIn({ libraryDir: library, dataDir });
    expect(changed).toBe(true);
    expect(readFileSync(join(workspace, 'AGENTS.override.md'), 'utf8')).toContain('- worker — 执行岗');
  });

  it('keeps the scripts and the index when only the rules change', async () => {
    const { library, dataDir, workspace } = setup();
    await ensureSupervisorWorkspaceIn({ libraryDir: library, dataDir });
    const before = readFileSync(join(workspace, 'teams.cjs'), 'utf8');
    const rosterBefore = readFileSync(join(workspace, POSITIONS_SCRIPT_NAME), 'utf8');
    writeFileSync(join(library, 'c-worker.md'), positionFile('worker', '执行岗'), 'utf8');
    await ensureSupervisorWorkspaceIn({ libraryDir: library, dataDir });
    expect(readFileSync(join(workspace, 'teams.cjs'), 'utf8')).toBe(before);
    expect(readFileSync(join(workspace, POSITIONS_SCRIPT_NAME), 'utf8')).toBe(rosterBefore);
  });

  it('retires an expired team at the next ensure, keeping its row in the file', async () => {
    const now = 1_700_000_000_000;
    const teamsFile = [
      '<!-- mu-supervisor-teams v1 -->',
      '| 队名 | 岗位成员 | 创建时间 | 最后复用 | 到期时间 | team_id | lead会话 |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      `| 活队 | forwarder | ${new Date(now - 1000).toISOString()} | ${new Date(now - 1000).toISOString()} | ${new Date(
        now + 86_400_000
      ).toISOString()} | t-live | c-live |`,
      `| 死队 | video-lab | ${new Date(now - 800_000_000).toISOString()} | ${new Date(
        now - 700_000_000
      ).toISOString()} | ${new Date(now - 1).toISOString()} | t-dead | c-dead |`,
    ].join('\n');
    const { library, dataDir, workspace, teamsFile: sharedTeamsFile } = setup(teamsFile);
    const { changed } = await ensureSupervisorWorkspaceIn({ libraryDir: library, dataDir }, () => now);
    expect(changed).toBe(true);
    const next = readFileSync(sharedTeamsFile, 'utf8');
    expect(next.indexOf('死队')).toBeGreaterThan(next.indexOf('已退役'));
    expect(next.indexOf('活队')).toBeGreaterThan(-1);
    expect(next.indexOf('活队')).toBeLessThan(next.indexOf('已退役'));
    // The retired row keeps its history — parse still sees both teams.
    expect(parseTeamsFile(next).map((t) => t.name)).toEqual(['活队', '死队']);
    // The pre-shared file in the workspace is gone: the shared copy replaced it.
    expect(existsSync(join(workspace, TEAMS_FILE_NAME))).toBe(false);
  });

  it('migrates a pre-shared index from the supervisor workspace to the shared folder', async () => {
    const now = 1_700_000_000_000;
    const teamsFile = [
      '<!-- mu-supervisor-teams v1 -->',
      '| 队名 | 岗位成员 | 创建时间 | 最后复用 | 到期时间 | team_id | lead会话 |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      `| 老队 | forwarder | ${new Date(now - 1000).toISOString()} | ${new Date(now - 1000).toISOString()} | ${new Date(
        now + 86_400_000
      ).toISOString()} | t-old | c-old |`,
    ].join('\n');
    const { library, dataDir, workspace, teamsFile: sharedFile } = setup(teamsFile);
    await ensureSupervisorWorkspaceIn({ libraryDir: library, dataDir }, () => now);
    const moved = parseTeamsFile(readFileSync(sharedFile, 'utf8'));
    expect(moved.map((t) => t.name)).toEqual(['老队']);
    expect(existsSync(join(workspace, TEAMS_FILE_NAME))).toBe(false);
  });

  it('leaves an already-canonical index untouched', async () => {
    const { library, dataDir } = setup();
    await ensureSupervisorWorkspaceIn({ libraryDir: library, dataDir });
    const first = readFileSync(join(dataDir, 'positions', SHARED_TEAMS_FOLDER, TEAMS_FILE_NAME), 'utf8');
    const { changed } = await ensureSupervisorWorkspaceIn({ libraryDir: library, dataDir });
    expect(changed).toBe(false);
    expect(readFileSync(join(dataDir, 'positions', SHARED_TEAMS_FOLDER, TEAMS_FILE_NAME), 'utf8')).toBe(first);
    expect(existsSync(join(dataDir, 'positions', SUPERVISOR_FOLDER, 'AGENTS.override.md'))).toBe(true);
  });
});

describe('registerSupervisorTeamIn', () => {
  it('writes a fresh row with the 7-day lifecycle for a new team', async () => {
    const { dataDir, teamsFile } = setup();
    const now = 1_800_000_000_000;
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '测试群', positions: ['forwarder', 'video-lab'], teamId: 't1', leadConversationId: 'c-lead' },
      () => now
    );
    const rows = parseTeamsFile(readFileSync(teamsFile, 'utf8'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: '测试群',
      positions: ['forwarder', 'video-lab'],
      teamId: 't1',
      leadConversationId: 'c-lead',
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + 7 * 24 * 60 * 60 * 1000,
    });
  });

  it('refreshes an active row and takes its new positions; a retired row keeps its retirement', async () => {
    const { dataDir, teamsFile } = setup();
    const day = 86_400_000;
    const t0 = 1_700_000_000_000;
    // An active row and a retired one (its TTL ran out long before `later`).
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '现役群', positions: ['forwarder'], teamId: 'live', leadConversationId: 'c-live' },
      () => t0
    );
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '退役群', positions: ['forwarder'], teamId: 'old', leadConversationId: 'c-old' },
      () => t0 - 30 * day
    );
    const later = t0 + 3 * day;
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '现役群', positions: ['forwarder', 'video-lab'], teamId: 'live', leadConversationId: 'c-live' },
      () => later
    );
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '退役群', positions: ['video-lab'], teamId: 'old', leadConversationId: 'c-old' },
      () => later
    );
    const byId = new Map(parseTeamsFile(readFileSync(teamsFile, 'utf8')).map((t) => [t.teamId, t]));
    expect(byId.get('live')).toMatchObject({
      positions: ['forwarder', 'video-lab'],
      lastUsedAt: later,
      expiresAt: later + 7 * day,
    });
    // The retired row takes the new positions but is NOT resurrected.
    expect(byId.get('old')).toMatchObject({
      positions: ['video-lab'],
      lastUsedAt: t0 - 30 * day,
      expiresAt: t0 - 23 * day,
    });
  });

  it('suffixes a name another active team already holds, so send --team stays unambiguous', async () => {
    const { dataDir } = setup();
    const now = 1_800_000_000_000;
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '测试群', positions: ['forwarder'], teamId: 't1', leadConversationId: 'c1' },
      () => now
    );
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '测试群', positions: ['video-lab'], teamId: 't2', leadConversationId: 'c2' },
      () => now
    );
    const { teamsFile } = { teamsFile: join(dataDir, 'positions', SHARED_TEAMS_FOLDER, TEAMS_FILE_NAME) };
    const names = parseTeamsFile(readFileSync(teamsFile, 'utf8'))
      .map((t) => t.name)
      .toSorted();
    expect(names).toEqual(['测试群', '测试群 2']);
  });
});
