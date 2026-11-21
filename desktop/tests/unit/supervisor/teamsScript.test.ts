/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseTeamsFile, TEAMS_FILE_NAME, TEAM_TTL_MS } from '@/common/chat/team/supervisor/supervisorCore';
import { TEAM_DISPATCH_RULES_BLOCK, TEAM_DISPATCH_RULES_VERSION } from '@/common/chat/team/teamDispatch/dispatchRules';

/**
 * The supervisor workspace's maintenance script (common/chat/team/supervisor/
 * teams.cjs), run for real: node spawns the script against a stub backend on
 * the loopback, in an isolated tree shaped like the app data dir. The TEAMS.md
 * the script writes must parse with the core's parser — the file format is
 * the contract between the script and the desktop.
 */

const SCRIPT_SRC = fileURLToPath(
  new URL('../../../packages/desktop/src/common/chat/team/supervisor/teams.cjs', import.meta.url)
);

type Captured = { method: string; path: string; body: unknown };
let server: Server;
let baseUrl = '';
const captured: Captured[] = [];

/** The teams the stub has created; each add returns the next one. */
let createdTeams = 0;

/** What GET /api/conversations/<id>/config-options answers, and the status PUT answers; tests shape these. */
let configOptionsAnswer: unknown = undefined;
let configOptionsGetStatus = 200;
let configPutStatus = 200;
const configPuts: Array<{ path: string; body: unknown }> = [];
/** While true, the team config-options GET answers the backend's not-ready 409; the session warmup POST clears it. */
let memberNotReady = false;

const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'mu-teams-script-')));
const script = join(dataDir, 'positions', '_supervisor', 'teams.cjs');
// The index is shared: the script resolves ../_shared/TEAMS.md from any
// workspace it ships into — supervisor or position.
const teamsFile = join(dataDir, 'positions', '_shared', TEAMS_FILE_NAME);
// A controlled, empty-by-default position library: without it the script would
// read the real user library and slot names would depend on the machine.
const emptyLibrary = join(dataDir, 'library-empty');

beforeAll(async () => {
  mkdirSync(join(dataDir, 'positions', '_supervisor'), { recursive: true });
  mkdirSync(emptyLibrary, { recursive: true });
  copyFileSync(SCRIPT_SRC, script);

  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      captured.push({ method: request.method ?? '', path: request.url ?? '', body });
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/assistants') {
        response.end(
          JSON.stringify({
            data: [
              { id: 'bare:agent-mu', name: 'mu', team_selectable: true, agent_id: 'agent-mu' },
              { id: 'word-creator', name: 'Word Creator', team_selectable: false },
            ],
          })
        );
        return;
      }
      if (request.url === '/api/teams' && request.method === 'POST') {
        createdTeams += 1;
        response.end(
          JSON.stringify({
            data: {
              id: `team-${createdTeams}`,
              agents: [
                { role: 'lead', conversation_id: `conv-lead-${createdTeams}` },
                { role: 'teammate', conversation_id: `conv-mate-${createdTeams}` },
              ],
            },
          })
        );
        return;
      }
      if (/^\/api\/teams\/team-\d+$/.test(request.url ?? '') && request.method === 'GET') {
        const id = (request.url ?? '').split('/').pop();
        response.end(
          JSON.stringify({
            data: {
              id,
              agents: [
                { role: 'lead', assistant_name: '货代', conversation_id: `conv-lead-${createdTeams}` },
                { role: 'teammate', assistant_name: '货代 2', conversation_id: `conv-mate-${createdTeams}` },
              ],
            },
          })
        );
        return;
      }
      if (
        /^\/api\/teams\/team-\d+\/conversations\/[^/]+\/config-options$/.test(request.url ?? '') &&
        request.method === 'GET'
      ) {
        if (memberNotReady) {
          response.statusCode = 409;
          response.end(JSON.stringify({ error: 'Team agent runtime is not ready for conversation: x' }));
          return;
        }
        response.statusCode = configOptionsGetStatus;
        response.end(JSON.stringify(configOptionsAnswer ?? { data: {} }));
        return;
      }
      if (/^\/api\/teams\/team-\d+\/session$/.test(request.url ?? '') && request.method === 'POST') {
        memberNotReady = false; // the warmup the retry path performs
        response.end(JSON.stringify({ data: {} }));
        return;
      }
      if (
        /^\/api\/teams\/team-\d+\/conversations\/[^/]+\/config-options\/[^/]+$/.test(request.url ?? '') &&
        request.method === 'PUT'
      ) {
        configPuts.push({ path: request.url ?? '', body });
        response.statusCode = configPutStatus;
        response.end(JSON.stringify({ data: {} }));
        return;
      }
      if (request.url?.startsWith('/api/teams/') && request.url.endsWith('/messages') && request.method === 'POST') {
        response.end(JSON.stringify({ data: { ok: true } }));
        return;
      }
      if (request.url?.startsWith('/api/conversations/') && request.method === 'PATCH') {
        response.end(JSON.stringify({ data: true }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not found' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub server has no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const execFileAsync = promisify(execFile);

/** Runs the script against the stub. Async on purpose: a sync spawn would block this process's event loop — the stub server's — and deadlock the script's own HTTP call. */
const run = (args: string[], scriptPath = script) => runAt(scriptPath, args);
const runAt = async (scriptPath: string, args: string[], env: Record<string, string> = {}) => {
  try {
    const answer = await execFileAsync(process.execPath, [scriptPath, ...args], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, AIONUI_BASE_URL: baseUrl, MU_POSITION_LIBRARY: emptyLibrary, ...env },
    });
    return { status: 0, out: `${answer.stdout}`.trim(), err: `${answer.stderr}`.trim() };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { status: failure.code ?? 1, out: `${failure.stdout ?? ''}`.trim(), err: `${failure.stderr ?? ''}`.trim() };
  }
};

const teamsNow = () => parseTeamsFile(readFileSync(teamsFile, 'utf8'));
const isoOf = (ms: number): string => new Date(ms).toISOString();
const writeTeamsRaw = (content: string) => {
  mkdirSync(join(dataDir, 'positions', '_shared'), { recursive: true });
  writeFileSync(teamsFile, content, 'utf8');
};

describe('teams.cjs against a stub backend', () => {
  it('answers NONE when there is no team yet', async () => {
    const answer = await run(['match', '--positions', 'forwarder,worker']);
    expect(answer.status).toBe(0);
    expect(answer.out).toBe('NONE');
  });

  it('adds a team: mu slots named by the positions, workspace under the data dir, row in TEAMS.md', async () => {
    const answer = await run(['add', '--name', 'CNS 查重队', '--positions', 'forwarder,worker']);
    expect(answer.status).toBe(0);
    expect(answer.out).toContain('TEAM_ADDED name=CNS 查重队');
    expect(answer.out).toContain('team_id=team-1');
    expect(answer.out).toContain('lead_conversation=conv-lead-1');

    const create = captured.findLast((entry) => entry.path === '/api/teams');
    if (!create) throw new Error('no POST /api/teams was captured');
    const body = create.body as { name: string; workspace: string; agents: Array<Record<string, unknown>> };
    expect(body).toMatchObject({ name: 'CNS 查重队' });
    expect(body.agents.map((a) => [a.role, a.name])).toEqual([
      ['lead', 'forwarder'],
      ['teammate', 'worker'],
    ]);
    for (const agent of body.agents) expect(agent.assistant_id).toBe('bare:agent-mu');
    expect(body.workspace.startsWith(join(dataDir, 'teams'))).toBe(true);

    const teams = teamsNow();
    expect(teams).toHaveLength(1);
    expect(teams[0]).toMatchObject({ name: 'CNS 查重队', positions: ['forwarder', 'worker'], teamId: 'team-1' });
    expect(teams[0].expiresAt - teams[0].createdAt).toBe(TEAM_TTL_MS);
    // The script's file is the core's format: the desktop can parse it.
    expect(teams[0].leadConversationId).toBe('conv-lead-1');
    // The source checkout carries no injected block, so a fresh workspace gets no AGENTS.md.
    expect(existsSync(join(body.workspace, 'AGENTS.md'))).toBe(false);
  });

  it('as the app ships it (block injected): add seeds the fresh workspace AGENTS.md at creation', async () => {
    const shipped = join(dataDir, 'positions', '_supervisor', 'teams.shipped.cjs');
    writeFileSync(
      shipped,
      readFileSync(SCRIPT_SRC, 'utf8').replace(
        '/* mu-dispatch-rules-block */ null',
        JSON.stringify(TEAM_DISPATCH_RULES_BLOCK)
      ),
      'utf8'
    );
    const answer = await runAt(shipped, ['add', '--name', '播种队', '--positions', 'solo']);
    expect(answer.status).toBe(0);
    expect(answer.out).toContain('TEAM_ADDED name=播种队');
    const workspace = /workspace=(\S+)/.exec(answer.out)?.[1];
    if (!workspace) throw new Error(`no workspace in TEAM_ADDED: ${answer.out}`);
    const seeded = readFileSync(join(workspace, 'AGENTS.md'), 'utf8');
    expect(seeded).toContain(`<!-- mu-team-dispatch v${TEAM_DISPATCH_RULES_VERSION} -->`);
    expect(seeded).toContain('收尾落账（全体成员，硬规则）');
    expect(seeded.endsWith('<!-- /mu-team-dispatch -->\n')).toBe(true);
  });

  it('matches a covering need and refuses a partial one', async () => {
    expect((await run(['match', '--positions', 'forwarder'])).out).toBe('MATCH CNS 查重队');
    expect((await run(['match', '--positions', 'forwarder,worker'])).out).toBe('MATCH CNS 查重队');
    expect((await run(['match', '--positions', 'forwarder,video-lab'])).out).toBe('NONE');
  });

  it('sends the task text verbatim and refreshes the 7-day lifecycle', async () => {
    const before = teamsNow()[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
    const taskFile = join(dataDir, 'positions', '_supervisor', 'task.txt');
    writeFileSync(taskFile, '查 CNS 客户，整理成表', 'utf8');
    const answer = await run(['send', '--team', 'CNS 查重队', '--file', taskFile]);
    expect(answer.status).toBe(0);
    expect(answer.out).toContain('SENT team=CNS 查重队');
    expect(answer.out).toContain('to_conversation=conv-lead-1');

    const send = captured.find((entry) => entry.path === '/api/teams/team-1/messages');
    expect(send?.body).toMatchObject({ content: '查 CNS 客户，整理成表', files: [] });

    const after = teamsNow()[0];
    expect(after.lastUsedAt).toBeGreaterThan(before.lastUsedAt);
    expect(after.expiresAt - after.lastUsedAt).toBe(TEAM_TTL_MS);
  });

  it('doubles a single position into lead plus a second slot of its own', async () => {
    const answer = await run(['add', '--name', '单岗队', '--positions', 'forwarder']);
    expect(answer.status).toBe(0);
    const create = captured.findLast((entry) => entry.path === '/api/teams');
    if (!create) throw new Error('no POST /api/teams was captured');
    const agents = (create.body as { agents: Array<Record<string, unknown>> }).agents;
    expect(agents.map((a) => [a.role, a.name])).toEqual([
      ['lead', 'forwarder'],
      ['teammate', 'forwarder 2'],
    ]);
  });

  it('writes a hostile name as one row and reads it back: `|` escaped, newline folded', async () => {
    const answer = await run(['add', '--name', '毒|队', '--positions', 'forwarder,worker']);
    expect(answer.status).toBe(0);
    const raw = readFileSync(teamsFile, 'utf8');
    expect(raw).toContain('| 毒\\|队 |');
    expect(raw).not.toContain('| 毒|队 |');
    // the index a fresh run reads back carries the original name
    expect((await run(['list'])).out).toContain('TEAM 毒|队');
  });

  it('refuses a duplicate active name, keeping the index unchanged', async () => {
    const before = readFileSync(teamsFile, 'utf8');
    const answer = await run(['add', '--name', 'CNS 查重队', '--positions', 'forwarder']);
    expect(answer.status).toBe(1);
    expect(answer.err).toContain('ERROR');
    expect(readFileSync(teamsFile, 'utf8')).toBe(before);
  });

  it('refuses a name that would escape the teams root: `..` never becomes a workspace folder', async () => {
    const answer = await run(['add', '--name', '..', '--positions', 'forwarder']);
    expect(answer.status).toBe(1);
    expect(answer.err).toContain('safe workspace folder');
    expect(existsSync(join(dataDir, 'AGENTS.md'))).toBe(false);
  });

  it('drops rows whose team id is not a backend id shape, exactly like the app parser', async () => {
    const at = Date.now();
    const iso = new Date(at).toISOString();
    const future = new Date(at + 86_400_000).toISOString();
    const row = (teamId: string) => `| 队 | forwarder | ${iso} | ${iso} | ${future} | ${teamId} | conv-x |`;
    writeTeamsRaw(
      [
        '<!-- mu-supervisor-teams v1 -->',
        '| 队名 | 岗位成员 | 创建时间 | 最后复用 | 到期时间 | team_id | lead会话 | TTL天数 | 永久 | 删除时间 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        row('../x'),
        row('ok-team_1'),
        row('a/b'),
      ].join('\n')
    );
    const teams = teamsNow();
    // The app-side parser already refuses these rows; the script must agree.
    expect(teams.map((team) => team.teamId)).toEqual(['ok-team_1']);
    const answer = await run(['list', '--positions', 'forwarder']);
    expect(answer.status).toBe(0);
    expect(answer.out).toContain('ok-team_1');
    expect(answer.out).not.toContain('../x');
    expect(answer.out).not.toContain('a/b');
  });

  it('never matches an expired team', async () => {
    const expiredAt = Date.now() - 1;
    const iso = new Date(expiredAt).toISOString();
    writeTeamsRaw(
      [
        '<!-- mu-supervisor-teams v1 -->',
        '| 队名 | 岗位成员 | 创建时间 | 最后复用 | 到期时间 | team_id | lead会话 |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        `| 老队 | forwarder, worker | ${iso} | ${iso} | ${iso} | t-old | c-old |`,
      ].join('\n')
    );
    expect((await run(['match', '--positions', 'forwarder'])).out).toBe('NONE');
    const listing = await run(['list']);
    expect(listing.out).toContain('RETIRED');
  });

  it('a soft-deleted team is invisible to match and list, and send refuses it — but its row survives rewrites', async () => {
    const now = Date.now();
    writeTeamsRaw(
      [
        '<!-- mu-supervisor-teams v1 -->',
        '| 队名 | 岗位成员 | 创建时间 | 最后复用 | 到期时间 | team_id | lead会话 | TTL天数 | 永久 | 删除时间 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| 已删队 | forwarder | ${isoOf(now - 86_400_000)} | ${isoOf(now - 86_400_000)} | ${isoOf(
          now + TEAM_TTL_MS
        )} | t-del | c-del | 7 |  | ${isoOf(now - 86_400_000)} |`,
        `| 现役队 | forwarder | ${isoOf(now)} | ${isoOf(now)} | ${isoOf(now + TEAM_TTL_MS)} | t-live | c-live | 7 |  |  |`,
      ].join('\n')
    );
    // match picks the live team, never the deleted one — even though the
    // deleted team alone would be the smaller superset candidate were it alive.
    expect((await run(['match', '--positions', 'forwarder'])).out).toBe('MATCH 现役队');
    const listing = await run(['list']);
    expect(listing.out).toContain('TEAM 现役队');
    expect(listing.out).not.toContain('已删队');
    expect(listing.out).toContain('RETIRED 0');
    const send = await run(['send', '--team', '已删队', '--message', '任务']);
    expect(send.status).toBe(1);
    expect(send.err).toContain('no team named "已删队"');
    // A later successful send rewrites the index canonically — the deleted
    // row survives that rewrite, filed under the deleted heading.
    expect((await run(['send', '--team', '现役队', '--message', '任务'])).status).toBe(0);
    const rows = teamsNow();
    expect(rows.map((t) => t.name)).toContain('已删队');
    expect(rows.find((t) => t.name === '已删队')?.deletedAt).toBe(now - 86_400_000);
    expect(readFileSync(teamsFile, 'utf8')).toContain('已删除');
  });

  it('lists active teams with their positions and expiry', async () => {
    writeTeamsRaw(
      [
        '<!-- mu-supervisor-teams v1 -->',
        '| 队名 | 岗位成员 | 创建时间 | 最后复用 | 到期时间 | team_id | lead会话 |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        `| 队A | forwarder | ${new Date().toISOString()} | ${new Date().toISOString()} | ${new Date(
          Date.now() + TEAM_TTL_MS
        ).toISOString()} | t-a | c-a |`,
      ].join('\n')
    );
    const listing = await run(['list']);
    expect(listing.out).toContain('TEAM 队A');
    expect(listing.out).toContain('positions=forwarder');
    expect(listing.out).toContain('RETIRED 0');
  });

  it('settles every spelling of a position — id, display name, display name(id) — on the id', async () => {
    // A library whose forwarder carries a display name: the roster shows 货代,
    // a model may pass any of the three spellings to --positions, and TEAMS.md
    // plus the backend slots still key on the id.
    const library = join(dataDir, 'library');
    mkdirSync(library, { recursive: true });
    writeFileSync(
      join(library, 'forwarder.md'),
      '---\nname: forwarder\ndisplay_name: 货代\ndescription: 货代岗\n---\n\n正文。'
    );
    writeFileSync(join(library, 'video-lab.md'), '---\nname: video-lab\ndescription: 视频岗\n---\n\n正文。');

    const add = await runAt(script, ['add', '--name', '别名队', '--positions', '货代,货代'], {
      MU_POSITION_LIBRARY: library,
    });
    expect(add.status).toBe(0);
    expect(teamsNow().find((team) => team.name === '别名队')?.positions).toEqual(['forwarder']);
    // The slot carries the display name (货代), the index keys on the id.
    const create = captured.findLast((entry) => entry.path === '/api/teams');
    if (!create) throw new Error('no POST /api/teams was captured');
    const agents = (create.body as { agents: Array<Record<string, unknown>> }).agents;
    expect(agents.map((a) => [a.role, a.name])).toEqual([
      ['lead', '货代'],
      ['teammate', '货代 2'],
    ]);

    const match = await runAt(script, ['match', '--positions', '货代'], { MU_POSITION_LIBRARY: library });
    expect(match.out).toContain('MATCH 别名队');

    const byId = await runAt(script, ['match', '--positions', 'forwarder'], { MU_POSITION_LIBRARY: library });
    expect(byId.out).toContain('MATCH 别名队');
  });

  it('names the conversations for the sidebar: lead = the group chat, teammates say whose thread', async () => {
    const library = join(dataDir, 'library-rename');
    mkdirSync(library, { recursive: true });
    writeFileSync(
      join(library, 'forwarder.md'),
      '---\nname: forwarder\ndisplay_name: 货代\ndescription: 货代岗\n---\n\n正文。'
    );
    const answer = await runAt(script, ['add', '--name', '改名队', '--positions', 'forwarder,worker'], {
      MU_POSITION_LIBRARY: library,
    });
    expect(answer.status).toBe(0);

    const renames = captured.filter(
      (entry) =>
        entry.method === 'PATCH' && entry.path.startsWith('/api/conversations/') && 'name' in (entry.body as object)
    );
    const named = renames.map((entry) => (entry.body as { name: string }).name);
    expect(named).toContain('改名队（群聊）');
    const teammateRename = named.find((value) => value.endsWith('（改名队）'));
    expect(teammateRename).toBeDefined();
    const leadEntry = renames.find((entry) => (entry.body as { name: string }).name === '改名队（群聊）');
    expect(leadEntry?.body).toMatchObject({ name_source: 'user' });
  });

  it('respects a permanent row past its recorded expiry: match still finds it, send never retires it', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    writeTeamsRaw(
      [
        '<!-- mu-supervisor-teams v1 -->',
        '| 队名 | 岗位成员 | 创建时间 | 最后复用 | 到期时间 | team_id | lead会话 | TTL天数 | 永久 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| 永久队 | forwarder | ${past} | ${past} | ${past} | t-forever | c-forever | 7 | 是 |`,
      ].join('\n')
    );
    expect((await run(['match', '--positions', 'forwarder'])).out).toBe('MATCH 永久队');
    const listing = await run(['list']);
    expect(listing.out).toContain('TEAM 永久队');
    expect(listing.out).toContain('expires=permanent');
    expect(listing.out).toContain('RETIRED 0');

    const taskFile = join(dataDir, 'positions', '_supervisor', 'task-forever.txt');
    writeFileSync(taskFile, '再干一票', 'utf8');
    const before = teamsNow()[0];
    const send = await run(['send', '--team', '永久队', '--file', taskFile]);
    expect(send.status).toBe(0);
    expect(send.out).toContain('refreshed_until=permanent');
    const after = teamsNow()[0];
    expect(after.permanent).toBe(true);
    expect(after.expiresAt).toBe(before.expiresAt);
    expect(after.lastUsedAt).toBeGreaterThan(before.lastUsedAt);
  });

  it('send refreshes a custom lifecycle with the team own ttlDays, not the default', async () => {
    const now = Date.now();
    writeTeamsRaw(
      [
        '<!-- mu-supervisor-teams v1 -->',
        '| 队名 | 岗位成员 | 创建时间 | 最后复用 | 到期时间 | team_id | lead会话 | TTL天数 | 永久 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| 三天队 | forwarder | ${new Date(now).toISOString()} | ${new Date(now).toISOString()} | ${new Date(
          now + 3 * 86_400_000
        ).toISOString()} | t-3d | c-3d | 3 |  |`,
      ].join('\n')
    );
    const taskFile = join(dataDir, 'positions', '_supervisor', 'task-3d.txt');
    writeFileSync(taskFile, '干活', 'utf8');
    const send = await run(['send', '--team', '三天队', '--file', taskFile]);
    expect(send.status).toBe(0);
    const after = teamsNow()[0];
    expect(after.ttlDays).toBe(3);
    expect(after.permanent).toBe(false);
    expect(after.expiresAt - after.lastUsedAt).toBe(3 * 86_400_000);
  });

  it('upgrades a legacy seven-cell index in place: send rewrites the row with the default lifecycle cells', async () => {
    const now = Date.now();
    writeTeamsRaw(
      [
        '<!-- mu-supervisor-teams v1 -->',
        '| 队名 | 岗位成员 | 创建时间 | 最后复用 | 到期时间 | team_id | lead会话 |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        `| 老队 | forwarder | ${new Date(now).toISOString()} | ${new Date(now).toISOString()} | ${new Date(
          now + 86_400_000
        ).toISOString()} | t-legacy | c-legacy |`,
      ].join('\n')
    );
    const taskFile = join(dataDir, 'positions', '_supervisor', 'task-legacy.txt');
    writeFileSync(taskFile, '继续', 'utf8');
    const send = await run(['send', '--team', '老队', '--file', taskFile]);
    expect(send.status).toBe(0);
    const after = teamsNow()[0];
    expect(after).toMatchObject({ ttlDays: 7, permanent: false });
    expect(readFileSync(teamsFile, 'utf8')).toContain('| TTL天数 | 永久 |');
  });

  it('a position workspace copy maintains the same shared index as the supervisor copy', async () => {
    // The script ships into every position workspace too; all copies resolve
    // one TEAMS.md — a team one copy adds, the other copy matches.
    const forwarderWorkspace = join(dataDir, 'positions', 'forwarder');
    mkdirSync(forwarderWorkspace, { recursive: true });
    copyFileSync(SCRIPT_SRC, join(forwarderWorkspace, 'teams.cjs'));
    const add = await runAt(join(forwarderWorkspace, 'teams.cjs'), [
      'add',
      '--name',
      '岗位建的队',
      '--positions',
      'forwarder,worker',
    ]);
    expect(add.status).toBe(0);
    expect((await run(['match', '--positions', 'forwarder,worker'])).out).toBe('MATCH 岗位建的队');
  });
});

describe('teams.cjs lesson: the shared lessons ledger', () => {
  const lessonsFile = join(dataDir, 'positions', '_shared', 'LESSONS.md');
  const lessonLock = `${lessonsFile}.lock`;

  it('creates the ledger on the first lesson and appends: marker, heading, one line per lesson', async () => {
    const first = await run(['lesson', '--position', 'forwarder', '--text', '别再手写 npm install，会改写 lockfile']);
    expect(first.status).toBe(0);
    expect(first.out).toContain('LESSON_ADDED');
    let ledger = readFileSync(lessonsFile, 'utf8');
    expect(ledger).toContain('<!-- mu-desktop lessons v1 -->');
    expect(ledger).toContain('# 岗位教训总账');
    expect(ledger).toMatch(/\d{4}-\d{2}-\d{2} \| forwarder \| 别再手写 npm install，会改写 lockfile/);
    await run(['lesson', '--position', 'worker', '--text', '第二条']);
    ledger = readFileSync(lessonsFile, 'utf8');
    expect(ledger.indexOf('别再手写 npm install')).toBeLessThan(ledger.indexOf('第二条'));
    expect(ledger.split('\n').filter((line) => line.includes(' | '))).toHaveLength(2);
  });

  it('folds a multiline lesson to one line and caps it at 500 characters', async () => {
    const noisy = `第一行\n第二行\t缩进 ${'长'.repeat(600)}`;
    const answer = await run(['lesson', '--position', 'forwarder', '--text', noisy]);
    expect(answer.status).toBe(0);
    const last = readFileSync(lessonsFile, 'utf8')
      .split('\n')
      .filter((line) => line.includes(' | '))
      .at(-1)!;
    expect(last.includes('\n')).toBe(false);
    expect(last).toContain('第一行 第二行 缩进');
    expect(last.split(' | ')[2]).toHaveLength(500); // the text cell carries the cap, not a byte more
  });

  it('settles any roster spelling on the id: a display name lands as the id', async () => {
    const library = join(dataDir, 'library-alias');
    mkdirSync(library, { recursive: true });
    writeFileSync(
      join(library, 'forwarder.md'),
      '---\nname: forwarder\ndisplay_name: 货代\ndescription: 货代岗\n---\n\n正文',
      'utf8'
    );
    const answer = await runAt(script, ['lesson', '--position', '货代', '--text', '显示名也要能落数'], {
      MU_POSITION_LIBRARY: library,
    });
    expect(answer.status).toBe(0);
    expect(answer.out).toContain('position=forwarder');
    expect(readFileSync(lessonsFile, 'utf8')).toContain('| forwarder | 显示名也要能落数');
  });

  it('refuses a lesson without text, leaving the ledger untouched', async () => {
    const before = existsSync(lessonsFile) ? readFileSync(lessonsFile, 'utf8') : '';
    const answer = await run(['lesson', '--position', 'forwarder']);
    expect(answer.status).toBe(1);
    expect(answer.err).toContain('ERROR');
    expect(existsSync(lessonsFile) ? readFileSync(lessonsFile, 'utf8') : '').toBe(before);
  });

  it('waits for a live ledger lock instead of barging in, and releases it after', async () => {
    mkdirSync(join(dataDir, 'positions', '_shared'), { recursive: true });
    writeFileSync(lessonLock, '', 'utf8'); // a live holder
    const pending = run(['lesson', '--position', 'forwarder', '--text', '排队也要落账']);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(existsSync(lessonsFile) ? readFileSync(lessonsFile, 'utf8') : '').not.toContain('排队也要落账');
    rmSync(lessonLock, { force: true }); // the holder leaves
    const answer = await pending;
    expect(answer.status).toBe(0);
    expect(readFileSync(lessonsFile, 'utf8')).toContain('| forwarder | 排队也要落账');
    expect(existsSync(lessonLock)).toBe(false);
  });
});

describe('teams.cjs under the TEAMS.md write lock', () => {
  const lockFile = `${teamsFile}.lock`;

  it('takes over a stale lock: a dead holder never blocks the script', async () => {
    mkdirSync(join(dataDir, 'positions', '_shared'), { recursive: true });
    writeFileSync(lockFile, '', 'utf8');
    const deadFor = new Date(Date.now() - 10_000); // Date, not ms: raw numbers read as seconds
    utimesSync(lockFile, deadFor, deadFor);
    const answer = await run(['add', '--name', '锁死队', '--positions', 'forwarder']);
    expect(answer.status).toBe(0);
    expect(teamsNow().map((team) => team.name)).toContain('锁死队');
    expect(existsSync(lockFile)).toBe(false);
  });

  it('waits for a live holder instead of barging in', async () => {
    mkdirSync(join(dataDir, 'positions', '_shared'), { recursive: true });
    writeFileSync(lockFile, '', 'utf8'); // the live holder's lock
    const pending = run(['add', '--name', '排队队', '--positions', 'forwarder']);
    // Give the script time to reach the lock and sit on it.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(teamsNow().map((team) => team.name)).not.toContain('排队队'); // not written past the held lock
    rmSync(lockFile, { force: true }); // the holder leaves
    const answer = await pending;
    expect(answer.status).toBe(0);
    expect(teamsNow().map((team) => team.name)).toContain('排队队');
    expect(existsSync(lockFile)).toBe(false);
  });
});

/** The thinking levels a stub conversation offers, as the kyrn adapter reports them. */
const thinkingOptions = (levels: string[]): unknown => ({
  data: {
    config_options: [
      {
        id: 'thinking',
        category: 'thought_level',
        type: 'select',
        currentValue: levels[levels.length - 1],
        options: levels.map((level) => ({ value: level, name: level })),
      },
    ],
  },
});

/** The model select a stub conversation offers, as the kyrn adapter reports it (`provider/model` values). */
const modelOptions = (values: string[], current: string): unknown => ({
  data: {
    config_options: [
      {
        id: 'model',
        category: 'model',
        type: 'select',
        currentValue: current,
        options: values.map((value) => ({ value, name: value })),
      },
    ],
  },
});

describe('teams.cjs model — the cross-model review duty', () => {
  beforeEach(async () => {
    configOptionsAnswer = modelOptions(
      ['anthropic/claude-sonnet', 'openai/gpt-5', 'deepseek/deepseek-chat'],
      'anthropic/claude-sonnet'
    );
    configOptionsGetStatus = 200;
    configPutStatus = 200;
    configPuts.length = 0;
    await run(['add', '--name', '模型队', '--positions', 'forwarder,worker']);
  });

  it('sets a named member slot to the asked model', async () => {
    const answer = await run(['model', '--team', '模型队', '--agent', '货代 2', '--model', 'openai/gpt-5']);
    expect(answer.status).toBe(0);
    expect(answer.out).toContain('MODEL_SET agent=货代 2 model=openai/gpt-5');
    expect(configPuts.findLast((entry) => entry.path.includes('config-options/model'))?.body).toEqual({
      value: 'openai/gpt-5',
    });
  });

  it('--diff-from lead picks the first offered model the lead is not running, and says which', async () => {
    const answer = await run(['model', '--team', '模型队', '--agent', '货代 2', '--diff-from', 'lead']);
    expect(answer.status).toBe(0);
    expect(answer.out).toContain('MODEL_SET agent=货代 2 model=openai/gpt-5 (differs-from=anthropic/claude-sonnet)');
    expect(configPuts.findLast((entry) => entry.path.includes('config-options/model'))?.body).toEqual({
      value: 'openai/gpt-5',
    });
  });

  it('--diff-from with a single configured model answers the degradation the supervisor must say out loud', async () => {
    configOptionsAnswer = modelOptions(['anthropic/claude-sonnet'], 'anthropic/claude-sonnet');
    const answer = await run(['model', '--team', '模型队', '--agent', '货代 2', '--diff-from', 'lead']);
    expect(answer.status).toBe(0); // non-fatal by contract
    expect(answer.err).toContain('MODEL_FAILED');
    expect(answer.err).toContain('only-one-model');
    expect(configPuts).toHaveLength(0);
  });

  it('a model the select does not offer stays a warn line, never a failed dispatch', async () => {
    const answer = await run(['model', '--team', '模型队', '--agent', '货代 2', '--model', 'ghost/model-x']);
    expect(answer.status).toBe(0);
    expect(answer.err).toContain('MODEL_FAILED');
    expect(answer.err).toContain('model-not-offered');
  });

  it('refuses both or neither of --model / --diff-from', async () => {
    const neither = await run(['model', '--team', '模型队', '--agent', '货代 2']);
    expect(neither.status).toBe(1);
    expect(neither.err).toContain('exactly one of');
    const both = await run([
      'model',
      '--team',
      '模型队',
      '--agent',
      '货代 2',
      '--model',
      'openai/gpt-5',
      '--diff-from',
      'lead',
    ]);
    expect(both.status).toBe(1);
    expect(both.err).toContain('exactly one of');
  });
});

describe("teams.cjs think — the lead's level duty (escaped quotes: esbuild rejects raw ones)", () => {
  beforeEach(async () => {
    configOptionsAnswer = thinkingOptions(['off', 'low', 'medium', 'high']);
    configOptionsGetStatus = 200;
    configPutStatus = 200;
    configPuts.length = 0;
    await run(['add', '--name', '档位队', '--positions', 'forwarder,worker']);
  });

  it('sets a named member slot to the asked level', async () => {
    const answer = await run(['think', '--team', '档位队', '--agent', '货代 2', '--level', 'low']);
    expect(answer.status).toBe(0);
    expect(answer.out).toContain('THINK_SET agent=货代 2 level=low');
    const put = configPuts.findLast((entry) => entry.path.includes('config-options/thinking'));
    expect(put?.body).toEqual({ value: 'low' });
    expect(put?.path).toContain('conv-mate-');
  });

  it('`lead` names the lead slot', async () => {
    const answer = await run(['think', '--team', '档位队', '--agent', 'lead', '--level', 'off']);
    expect(answer.status).toBe(0);
    expect(answer.out).toContain('THINK_SET agent=货代 level=off');
    expect(configPuts.findLast((entry) => entry.path.includes('config-options/thinking'))?.path).toContain(
      'conv-lead-'
    );
  });

  it('clamps to the nearest offered level, cheaper first, and says what was asked', async () => {
    configOptionsAnswer = thinkingOptions(['off', 'medium', 'high']);
    const answer = await run(['think', '--team', '档位队', '--agent', '货代 2', '--level', 'low']);
    expect(answer.status).toBe(0);
    expect(answer.out).toContain('THINK_SET agent=货代 2 level=off (asked=low)');
    expect(configPuts.findLast((entry) => entry.path.includes('config-options/thinking'))?.body).toEqual({
      value: 'off',
    });
  });

  it('a slot that cannot be graded stays a warn line, never a failed dispatch', async () => {
    configOptionsGetStatus = 404;
    const answer = await run(['think', '--team', '档位队', '--agent', '货代 2', '--level', 'low']);
    expect(answer.status).toBe(0); // non-fatal by contract
    expect(answer.err).toContain('THINK_FAILED');
    expect(answer.err).toContain('options-unreadable');
  });

  it('retries once through the team session warmup when the member runtime is not ready', async () => {
    // First read answers the backend's not-ready 409; the warmup POST clears
    // the stub's flag and the retry lands — the lead never sees a cold member as a failure.
    memberNotReady = true;
    const answer = await run(['think', '--team', '档位队', '--agent', '货代 2', '--level', 'low']);
    expect(answer.status).toBe(0);
    expect(answer.out).toContain('THINK_SET agent=货代 2 level=low');
    expect(configPuts.findLast((entry) => entry.path.includes('config-options/thinking'))?.body).toEqual({
      value: 'low',
    });
  });

  it('refuses a level outside the four, and a slot no team carries', async () => {
    const badLevel = await run(['think', '--team', '档位队', '--agent', '货代 2', '--level', 'turbo']);
    expect(badLevel.status).toBe(1);
    expect(badLevel.err).toContain('--level must be one of');
    const ghost = await run(['think', '--team', '档位队', '--agent', '幽灵成员', '--level', 'low']);
    expect(ghost.status).toBe(1);
    expect(ghost.err).toContain('no slot named');
  });
});
