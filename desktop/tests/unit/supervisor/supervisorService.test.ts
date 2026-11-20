/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureSupervisorWorkspaceIn,
  purgeDueDeletedTeamsIn,
  registerSupervisorTeamIn,
  restoreSupervisorTeamIn,
  reuseSupervisorTeamIn,
  setTeamLifecycleIn,
  softDeleteSupervisorTeamIn,
} from '@process/services/team/supervisor';
import { teamsLockFileOf } from '@process/services/team/supervisor/teamsFileLock';
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
  it('refuses ids outside the backend id shape — they would flow into backend URL paths', async () => {
    const { dataDir, teamsFile } = setup();
    for (const bad of ['../x', 'a b', 'a/b']) {
      await expect(
        registerSupervisorTeamIn(
          { dataDir },
          { name: '测试群', positions: ['forwarder'], teamId: bad, leadConversationId: 'c-lead' }
        )
      ).rejects.toThrow(/backend id/);
    }
    await expect(
      registerSupervisorTeamIn(
        { dataDir },
        { name: '测试群', positions: ['forwarder'], teamId: 'ok-team_1', leadConversationId: '../c' }
      )
    ).rejects.toThrow(/backend id/);
    expect(existsSync(teamsFile)).toBe(false);
  });

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

  it('creates a row with the lifecycle the creating surface chose: custom days, or permanent', async () => {
    const { dataDir, teamsFile } = setup();
    const day = 86_400_000;
    const now = 1_800_000_000_000;
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '三天群', positions: ['forwarder'], teamId: 't3', leadConversationId: 'c3', ttlDays: 3 },
      () => now
    );
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '永久群', positions: ['video-lab'], teamId: 'tp', leadConversationId: 'cp', ttlDays: 5, permanent: true },
      () => now
    );
    const byId = new Map(parseTeamsFile(readFileSync(teamsFile, 'utf8')).map((t) => [t.teamId, t]));
    expect(byId.get('t3')).toMatchObject({ ttlDays: 3, permanent: false, expiresAt: now + 3 * day });
    expect(byId.get('tp')).toMatchObject({ ttlDays: 5, permanent: true, expiresAt: now + 5 * day });
  });

  it('refreshes an active row with the team OWN ttlDays, not the default', async () => {
    const { dataDir, teamsFile } = setup();
    const day = 86_400_000;
    const t0 = 1_700_000_000_000;
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '三天群', positions: ['forwarder'], teamId: 't3', leadConversationId: 'c3', ttlDays: 3 },
      () => t0
    );
    const later = t0 + 2 * day;
    // A member-change refresh carries no lifecycle params: the row keeps its 3.
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '三天群', positions: ['forwarder', 'video-lab'], teamId: 't3', leadConversationId: 'c3' },
      () => later
    );
    const rows = parseTeamsFile(readFileSync(teamsFile, 'utf8'));
    expect(rows[0]).toMatchObject({ ttlDays: 3, lastUsedAt: later, expiresAt: later + 3 * day });
  });
});

describe('setTeamLifecycleIn', () => {
  const day = 86_400_000;
  const t0 = 1_700_000_000_000;

  it('restarts a normal row expiry from now with the new day count, clamped into range', async () => {
    const { dataDir, teamsFile } = setup();
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '群', positions: ['forwarder'], teamId: 't1', leadConversationId: 'c1' },
      () => t0
    );
    const later = t0 + day;
    await setTeamLifecycleIn({ dataDir }, { teamId: 't1', ttlDays: 400 }, () => later);
    const rows = parseTeamsFile(readFileSync(teamsFile, 'utf8'));
    expect(rows[0]).toMatchObject({ ttlDays: 365, permanent: false, expiresAt: later + 365 * day });
  });

  it('flags a row permanent: its recorded expiry stays, reconcile never retires it', async () => {
    const { dataDir, teamsFile } = setup();
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '群', positions: ['forwarder'], teamId: 't1', leadConversationId: 'c1' },
      () => t0
    );
    const later = t0 + day;
    await setTeamLifecycleIn({ dataDir }, { teamId: 't1', permanent: true }, () => later);
    const flagged = parseTeamsFile(readFileSync(teamsFile, 'utf8'))[0];
    expect(flagged.permanent).toBe(true);
    // Reconcile far past the recorded expiry: the permanent row survives it.
    await ensureSupervisorWorkspaceIn({ libraryDir: join(dataDir, 'lib-empty-x'), dataDir }, () => later + 400 * day);
    const reconciled = parseTeamsFile(readFileSync(teamsFile, 'utf8'))[0];
    expect(reconciled.permanent).toBe(true);
    expect(reconciled.expiresAt).toBe(flagged.expiresAt);
  });

  it('changes nothing for an unknown team id', async () => {
    const { dataDir, teamsFile } = setup();
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '群', positions: ['forwarder'], teamId: 't1', leadConversationId: 'c1' },
      () => t0
    );
    const before = readFileSync(teamsFile, 'utf8');
    await setTeamLifecycleIn({ dataDir }, { teamId: 'nope', ttlDays: 3 }, () => t0 + day);
    expect(readFileSync(teamsFile, 'utf8')).toBe(before);
  });
});

describe('softDeleteSupervisorTeamIn / restoreSupervisorTeamIn', () => {
  const day = 86_400_000;
  const t0 = 1_800_000_000_000;

  it('stamps the delete and nothing else: the row stays, the index files it under the deleted heading', async () => {
    const { dataDir, teamsFile } = setup();
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '删队', positions: ['forwarder'], teamId: 't1', leadConversationId: 'c1' },
      () => t0
    );
    const rows = await softDeleteSupervisorTeamIn({ dataDir }, { teamId: 't1' }, () => t0 + 1);
    expect(rows[0]).toMatchObject({ teamId: 't1', deletedAt: t0 + 1, expiresAt: t0 + 7 * day });
    const file = readFileSync(teamsFile, 'utf8');
    expect(file).toContain('已删除');
    expect(parseTeamsFile(file)[0]?.deletedAt).toBe(t0 + 1);
  });

  it('stamping a deleted team changes nothing, and an unknown id changes nothing', async () => {
    const { dataDir, teamsFile } = setup();
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '队', positions: ['forwarder'], teamId: 't1', leadConversationId: 'c1' },
      () => t0
    );
    await softDeleteSupervisorTeamIn({ dataDir }, { teamId: 't1' }, () => t0 + 1);
    const once = readFileSync(teamsFile, 'utf8');
    await softDeleteSupervisorTeamIn({ dataDir }, { teamId: 't1' }, () => t0 + 2);
    await softDeleteSupervisorTeamIn({ dataDir }, { teamId: 'ghost' }, () => t0 + 2);
    expect(parseTeamsFile(readFileSync(teamsFile, 'utf8'))[0]?.deletedAt).toBe(t0 + 1);
    expect(once).toContain(`${new Date(t0 + 1).toISOString()}`);
  });

  it('restores with a fresh lease: the stamp leaves, the expiry restarts, a permanent row stays permanent', async () => {
    const { dataDir, teamsFile } = setup();
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '甲', positions: ['forwarder'], teamId: 't1', leadConversationId: 'c1' },
      () => t0
    );
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '乙', positions: ['video-lab'], teamId: 't2', leadConversationId: 'c2', permanent: true },
      () => t0
    );
    await softDeleteSupervisorTeamIn({ dataDir }, { teamId: 't1' }, () => t0 + 1);
    await softDeleteSupervisorTeamIn({ dataDir }, { teamId: 't2' }, () => t0 + 1);
    // Far past every recorded expiry: a restore must not land in the retired fold.
    const later = t0 + 30 * day;
    const rows = await restoreSupervisorTeamIn({ dataDir }, { teamId: 't1' }, () => later);
    await restoreSupervisorTeamIn({ dataDir }, { teamId: 't2' }, () => later);
    const restored = parseTeamsFile(readFileSync(teamsFile, 'utf8'));
    expect(rows.find((t) => t.teamId === 't1')).toMatchObject({ deletedAt: undefined, expiresAt: later + 7 * day });
    expect(restored.find((t) => t.teamId === 't1')).toMatchObject({ deletedAt: undefined, expiresAt: later + 7 * day });
    expect(restored.find((t) => t.teamId === 't2')?.permanent).toBe(true);
    expect(readFileSync(teamsFile, 'utf8')).not.toContain('已删除');
  });
});

describe('purgeDueDeletedTeamsIn', () => {
  const day = 86_400_000;
  const t0 = 1_800_000_000_000;

  it('deletes for real past the grace — backend DELETE first, then the row — and keeps the restorable ones', async () => {
    const { dataDir, teamsFile } = setup();
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '旧删', positions: ['forwarder'], teamId: 'due', leadConversationId: 'c1' },
      () => t0
    );
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '新删', positions: ['video-lab'], teamId: 'fresh', leadConversationId: 'c2' },
      () => t0
    );
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '现役', positions: ['forwarder'], teamId: 'live', leadConversationId: 'c3' },
      () => t0
    );
    await softDeleteSupervisorTeamIn({ dataDir }, { teamId: 'due' }, () => t0);
    await softDeleteSupervisorTeamIn({ dataDir }, { teamId: 'fresh' }, () => t0 + 6 * day);
    const deleted: string[] = [];
    const answer = await purgeDueDeletedTeamsIn(
      { dataDir },
      {
        deleteTeam: async (teamId) => {
          deleted.push(teamId);
        },
      },
      () => t0 + 8 * day
    );
    expect(deleted).toEqual(['due']);
    expect(answer.purged.map((t) => t.teamId)).toEqual(['due']);
    const onDisk = parseTeamsFile(readFileSync(teamsFile, 'utf8'));
    expect(onDisk.map((t) => t.teamId).toSorted()).toEqual(['fresh', 'live']);
    expect(onDisk.find((t) => t.teamId === 'fresh')?.deletedAt).toBe(t0 + 6 * day);
  });

  it('keeps a row whose backend DELETE failed or was already gone (404), so the pass retries', async () => {
    const { dataDir, teamsFile } = setup();
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '拒删', positions: ['forwarder'], teamId: 'refused', leadConversationId: 'c1' },
      () => t0
    );
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '已无', positions: ['video-lab'], teamId: 'gone', leadConversationId: 'c2' },
      () => t0
    );
    await softDeleteSupervisorTeamIn({ dataDir }, { teamId: 'refused' }, () => t0);
    await softDeleteSupervisorTeamIn({ dataDir }, { teamId: 'gone' }, () => t0);
    const answer = await purgeDueDeletedTeamsIn(
      { dataDir },
      {
        deleteTeam: async (teamId) => {
          if (teamId === 'refused') throw new Error('backend down');
        },
      },
      () => t0 + 8 * day
    );
    expect(answer.purged.map((t) => t.teamId)).toEqual(['gone']);
    expect(answer.kept.map((t) => t.teamId)).toEqual(['refused']);
    const onDisk = parseTeamsFile(readFileSync(teamsFile, 'utf8'));
    expect(onDisk.map((t) => t.teamId)).toEqual(['refused']);
    expect(onDisk[0]?.deletedAt).toBe(t0);
  });

  it('is a fast no-op when nothing is due: no delete call, no rewrite', async () => {
    const { dataDir, teamsFile } = setup();
    await registerSupervisorTeamIn(
      { dataDir },
      { name: '队', positions: ['forwarder'], teamId: 't1', leadConversationId: 'c1' },
      () => t0
    );
    const before = readFileSync(teamsFile, 'utf8');
    let called = 0;
    const answer = await purgeDueDeletedTeamsIn(
      { dataDir },
      {
        deleteTeam: async () => {
          called += 1;
        },
      },
      () => t0
    );
    expect(called).toBe(0);
    expect(answer.purged).toEqual([]);
    expect(readFileSync(teamsFile, 'utf8')).toBe(before);
  });
});

describe('the TEAMS.md write lock (every mutation under withTeamsIndexLock)', () => {
  /** Registers one team with a distinct id, the parallel-mutation unit. */
  const register = (dataDir: string, teamId: string) =>
    registerSupervisorTeamIn(
      { dataDir },
      { name: `队${teamId}`, positions: ['forwarder'], teamId, leadConversationId: `c-${teamId}` }
    );

  it('loses no row when registrations race: eight parallel writes, eight rows on disk', async () => {
    const { dataDir, teamsFile } = setup();
    await Promise.all(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'].map((id) => register(dataDir, id)));
    const onDisk = parseTeamsFile(readFileSync(teamsFile, 'utf8'));
    expect(onDisk.map((row) => row.teamId).sort()).toEqual(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']);
    // The lock is gone when the last writer leaves.
    expect(existsSync(teamsLockFileOf(dataDir))).toBe(false);
  });

  it('also serializes mixed mutations racing one another', async () => {
    const { dataDir, teamsFile } = setup();
    await register(dataDir, 't1');
    await Promise.all([
      register(dataDir, 't2'),
      softDeleteSupervisorTeamIn({ dataDir }, { teamId: 't1' }),
      setTeamLifecycleIn({ dataDir }, { teamId: 't1', ttlDays: 3 }),
      reuseSupervisorTeamIn({ dataDir }, { teamId: 't1', at: 9_999 }),
    ]);
    const ids = parseTeamsFile(readFileSync(teamsFile, 'utf8'))
      .map((row) => row.teamId)
      .sort();
    expect(ids).toEqual(['t1', 't2']);
    expect(existsSync(teamsLockFileOf(dataDir))).toBe(false);
  });

  it('takes over a stale lock (a dead holder) instead of waiting forever', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { dataDir, teamsFile } = setup();
      mkdirSync(join(dataDir, 'positions', SHARED_TEAMS_FOLDER), { recursive: true });
      writeFileSync(teamsLockFileOf(dataDir), '', 'utf8'); // the dead holder's leftover
      // Ten seconds pass (only Date is faked; the fs above stays real).
      vi.setSystemTime(Date.now() + 10_000);
      const started = Date.now();
      await register(dataDir, 't1');
      // Far under the 5s stale span + poll: the takeover was immediate.
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(parseTeamsFile(readFileSync(teamsFile, 'utf8')).map((row) => row.teamId)).toEqual(['t1']);
      expect(existsSync(teamsLockFileOf(dataDir))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
