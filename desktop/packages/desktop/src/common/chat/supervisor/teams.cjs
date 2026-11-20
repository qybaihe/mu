#!/usr/bin/env node
/**
 * mu desktop supervisor workspace — temporary-team maintenance CLI.
 * Written into the supervisor workspace by the desktop app
 * (process/services/supervisor/supervisorService.ts); the supervisor agent
 * runs it from that workspace. TEAMS.md's format contract lives in
 * common/chat/supervisor/supervisorCore.ts (marker v1, pipe table, ISO dates):
 * this script and that core must stay in sync.
 *
 * Subcommands:
 *   list                                    active teams, then the retired count
 *   match --positions a,b                   `MATCH <name>` when an active team's
 *                                           positions cover the needed set, else `NONE`
 *   add  --name X --positions a,b           create the team (backend POST /api/teams,
 *                                           members = the positions as mu slots), seed
 *                                           the workspace's AGENTS.md dispatch rules,
 *                                           register it
 *   send --team X (--file F | --message M)  deliver a task to the team and refresh
 *                                           its 7-day lifecycle
 *
 * The dispatch block: the app injects the canonical team-dispatch rules block
 * (common/chat/teamDispatch/dispatchRules.ts, single source of truth) into the
 * `mu-dispatch-rules-block` placeholder below when it ships this script,
 * and `add` writes it into the fresh workspace's AGENTS.md at team creation —
 * before the lead's first turn can start reading context — so a team built over
 * REST (the supervisor flow, no renderer involved) carries the rules from its
 * first message. The renderer's seed (teamStore) stays for UI-created teams and
 * for upgrading older blocks in place.
 *
 * The team index is SHARED: this script ships into every team-creating
 * workspace (the supervisor's and each library position's), and all copies
 * resolve the same TEAMS.md at <dataDir>/positions/_shared/TEAMS.md — one
 * global index, so a team the supervisor opened is a team a position finds
 * by match, and vice versa. The workspace folders all sit directly under
 * positions/, so `../_shared/` is the shared folder from any of them.
 *
 * Answers the backend at $AIONUI_BASE_URL (plain localhost REST, no auth —
 * the same wire the app's own bridge uses). Errors print `ERROR …` on stderr
 * and exit 1; the supervisor is told to paste that output verbatim.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BASE_URL = (process.env.AIONUI_BASE_URL || 'http://127.0.0.1:13400').replace(/\/+$/, '');
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TEAMS_FILE = path.resolve(__dirname, '..', '_shared', 'TEAMS.md');
const TEAMS_MARKER = '<!-- mu-supervisor-teams v1 -->';
/** The dispatch rules block for a fresh team workspace; the app injects the canonical text in place of this whole `null` expression when it ships the script. */
const DISPATCH_RULES_BLOCK = /* mu-dispatch-rules-block */ null;
const TABLE_HEADER = '| 队名 | 岗位成员 | 创建时间 | 最后复用 | 到期时间 | team_id | lead会话 |';
const TABLE_RULE = '| --- | --- | --- | --- | --- | --- | --- |';

const iso = (ms) => new Date(ms).toISOString();

const fail = (message) => {
  console.error(`ERROR ${message}`);
  process.exit(1);
};

/** Minimal `--key value` argv: flags until the first `--`, repeated keys keep the last value. */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = 'true';
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

/**
 * The position library's display-name aliases: a roster spells a position
 * `货代` when it has a display_name, so a model may pass any of the three
 * spellings to --positions. This maps every spelling to the id TEAMS.md keys
 * on, and ids to their display name (the team slot names carry the display
 * name, so the sidebar shows 货代, not forwarder). Best-effort: an unreadable
 * library changes nothing — tokens pass through, ids stay ids.
 */
function positionAliases() {
  const library = process.env.MU_POSITION_LIBRARY || path.join(os.homedir(), '.mu', 'agent', 'agents');
  const aliases = new Map();
  const displayNames = new Map();
  let files;
  try {
    files = fs.readdirSync(library);
  } catch {
    return { aliases, displayNames };
  }
  for (const file of files) {
    if (!file.toLowerCase().endsWith('.md')) continue;
    let content;
    try {
      content = fs.readFileSync(path.join(library, file), 'utf8');
    } catch {
      continue;
    }
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
    if (!frontmatter) continue;
    const fields = {};
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const match = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
      if (match) fields[match[1]] = match[2];
    }
    const name = (fields.name || '').trim();
    const displayName = (fields.display_name || '').trim();
    if (!name) continue;
    if (displayName && displayName !== name) {
      aliases.set(displayName, name);
      aliases.set(`${displayName}(${name})`, name);
      displayNames.set(name, displayName);
    }
  }
  return { aliases, displayNames };
}

/** A position's user-facing slot label: its display name when the library has one, else the id. */
function positionLabelOf(id, displayNames) {
  return displayNames.get(id) || id;
}

/**
 * The positions of an `--positions` value: split, trimmed, empty dropped,
 * duplicates kept out; every spelling of a position (id, display name, or
 * `显示名`) settles on the id.
 */
function parsePositions(value) {
  const { aliases } = positionAliases();
  const seen = new Set();
  const positions = [];
  for (const item of String(value || '').split(',')) {
    const stripped = /^(.*)\([A-Za-z0-9._-]+\)$/.exec(item.trim());
    const name = aliases.get(item.trim()) || (stripped && aliases.get(stripped[1])) || item.trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      positions.push(name);
    }
  }
  return positions;
}

function parseTeams(content) {
  if (!content.includes(TEAMS_MARKER)) return [];
  const teams = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());
    if (cells.length !== 7) continue;
    const createdAt = Date.parse(cells[2]);
    const lastUsedAt = Date.parse(cells[3]);
    const expiresAt = Date.parse(cells[4]);
    if (!Number.isFinite(createdAt) || !Number.isFinite(lastUsedAt) || !Number.isFinite(expiresAt)) continue;
    if (!cells[0] || !cells[5] || !cells[6]) continue;
    teams.push({
      name: cells[0],
      positions: cells[1]
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean),
      createdAt,
      lastUsedAt,
      expiresAt,
      teamId: cells[5],
      leadConversationId: cells[6],
    });
  }
  return teams;
}

function buildTeams(teams, now) {
  const active = teams.filter((t) => t.expiresAt > now).toSorted((a, b) => b.lastUsedAt - a.lastUsedAt);
  const retired = teams.filter((t) => t.expiresAt <= now).toSorted((a, b) => b.lastUsedAt - a.lastUsedAt);
  const table = (rows) => (rows.length === 0 ? [] : [TABLE_HEADER, TABLE_RULE, ...rows.map(teamRow)]);
  const lines = [TEAMS_MARKER, '# 临时团队索引（由 teams.cjs 维护，勿手改）', '', ...table(active)];
  if (active.length > 0) lines.push('');
  if (retired.length > 0) lines.push('已退役（到期未复用，不再匹配）：', '', ...table(retired));
  return `${lines.join('\n')}\n`;
}

const teamRow = (t) =>
  `| ${t.name} | ${t.positions.join(', ')} | ${iso(t.createdAt)} | ${iso(t.lastUsedAt)} | ${iso(t.expiresAt)} | ${t.teamId} | ${t.leadConversationId} |`;

function readTeams() {
  try {
    return parseTeams(fs.readFileSync(TEAMS_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function writeTeams(teams) {
  fs.mkdirSync(path.dirname(TEAMS_FILE), { recursive: true });
  fs.writeFileSync(TEAMS_FILE, buildTeams(teams, Date.now()), 'utf8');
}

async function api(method, apiPath, body) {
  let response;
  try {
    const options = { method };
    if (body !== undefined) {
      options.headers = { 'Content-Type': 'application/json; charset=utf-8' };
      options.body = JSON.stringify(body);
    }
    response = await fetch(`${BASE_URL}${apiPath}`, options);
  } catch (error) {
    fail(`backend unreachable at ${BASE_URL} (${error.message})`);
  }
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  const data = json && typeof json === 'object' ? (json.data ?? json) : null;
  if (!response.ok) {
    const detail = (data && data.error) || text.slice(0, 200);
    fail(`${method} ${apiPath} -> ${response.status}: ${detail}`);
  }
  return data;
}

/** Whether a management row can join a team: `team_selectable` on some shapes, `behavior_policy.supports_team` on this one. */
/** The assistant id for every team slot: the assistants list's team-selectable mu (ids live in the assistant namespace, e.g. `bare:…` — the agents list's bare id is NOT accepted by POST /api/teams). */
async function teamAssistantId() {
  const answer = await api('GET', '/api/assistants');
  const list = Array.isArray(answer) ? answer : (answer && answer.items) || [];
  const capable = list.filter((a) => a && a.team_selectable === true);
  const chosen = capable.find((a) => (a.name || '').toLowerCase() === 'mu') || capable[0];
  if (!chosen || !chosen.id) fail('no team-selectable assistant found (GET /api/assistants)');
  return chosen.id;
}

/** A filesystem-safe folder for the team's workspace, under the app data dir's teams/. */
function teamWorkspace(name) {
  const safe = name.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '');
  // `.` and `..` are the only sanitized names that escape the teams root
  // (separators never survive the replace), so they are refused, not written.
  if (safe === '' || safe === '.' || safe === '..')
    fail(`team name "${name}" cannot become a safe workspace folder`);
  const root = path.resolve(__dirname, '..', '..', 'teams');
  let dir = path.join(root, safe);
  if (fs.existsSync(dir)) dir = path.join(root, `${safe}-${Date.now().toString(36)}`);
  return dir;
}

const findTeam = (teams, name) => teams.find((t) => t.name === name);

async function cmdList() {
  const teams = readTeams();
  const now = Date.now();
  const active = teams.filter((t) => t.expiresAt > now);
  const retired = teams.length - active.length;
  for (const t of active) {
    console.log(
      `TEAM ${t.name} | positions=${t.positions.join(',')} | expires=${iso(t.expiresAt)} | team_id=${t.teamId} | lead_conversation=${t.leadConversationId}`
    );
  }
  console.log(retired > 0 ? `RETIRED ${retired}` : 'RETIRED 0');
}

async function cmdMatch(args) {
  const needed = parsePositions(args.positions);
  if (needed.length === 0) fail('--positions is required (comma-separated position names)');
  const now = Date.now();
  const candidates = readTeams().filter((t) => t.expiresAt > now && needed.every((p) => t.positions.includes(p)));
  candidates.sort((a, b) => a.positions.length - b.positions.length || b.lastUsedAt - a.lastUsedAt);
  console.log(candidates.length > 0 ? `MATCH ${candidates[0].name}` : 'NONE');
}

async function cmdAdd(args) {
  const name = String(args.name || '').trim();
  const positions = parsePositions(args.positions);
  if (!name) fail('--name is required');
  if (positions.length === 0) fail('--positions is required (comma-separated position names)');
  const teams = readTeams();
  const now = Date.now();
  if (
    findTeam(
      teams.filter((t) => t.expiresAt > now),
      name
    )
  ) {
    fail(`active team named "${name}" already exists; pick another name`);
  }

  const assistantId = await teamAssistantId();
  const workspace = teamWorkspace(name);
  fs.mkdirSync(workspace, { recursive: true });
  // The workspace is fresh (teamWorkspace never reuses a folder): the block is
  // the whole file. Empty when the app's injection is absent (source checkout).
  if (DISPATCH_RULES_BLOCK) fs.writeFileSync(path.join(workspace, 'AGENTS.md'), `${DISPATCH_RULES_BLOCK}\n`, 'utf8');

  // Slots carry the positions' display names (货代, not forwarder): the team
  // and its conversations are user-facing surfaces. TEAMS.md keys stay ids.
  const { displayNames } = positionAliases();
  const slots = positions.map((position, index) => ({
    name: positionLabelOf(position, displayNames),
    role: index === 0 ? 'lead' : 'teammate',
    model: 'default',
    assistant_id: assistantId,
  }));
  // A team needs a lead and at least one teammate: a single position gets a second slot of its own.
  if (slots.length === 1) slots.push({ ...slots[0], name: `${slots[0].name} 2`, role: 'teammate' });

  const team = await api('POST', '/api/teams', { name, agents: slots, workspace });
  const teamAgents = (team && (team.agents || team.assistants)) || [];
  const lead = teamAgents.find((a) => a.role === 'lead' || a.role === 'leader');
  if (!team || !team.id || !lead || !lead.conversation_id) {
    fail(`backend created the team but the answer lacked id/lead conversation: ${JSON.stringify(team).slice(0, 300)}`);
  }

  // Name the conversations for the sidebar: the lead conversation IS the
  // group chat (「<队名>（群聊）」), each teammate thread says whose it is
  // (「货代 2（<队名>）」). Plain fetch, never `api()`: a rename must not
  // exit the process — the team already exists.
  const renameJobs = [];
  for (const agent of teamAgents) {
    const isLead = agent.role === 'lead' || agent.role === 'leader';
    const label = isLead ? `${name}（群聊）` : `${agent.assistant_name || agent.name || ''}（${name}）`;
    if (!agent.conversation_id || !label) continue;
    renameJobs.push(
      (async () => {
        try {
          const response = await fetch(`${BASE_URL}/api/conversations/${agent.conversation_id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ name: label, name_source: 'user' }),
          });
          if (!response.ok)
            console.warn(`RENAME_FAILED conversation=${agent.conversation_id} status=${response.status}`);
        } catch (error) {
          console.warn(`RENAME_FAILED conversation=${agent.conversation_id} (${error.message})`);
        }
      })()
    );
  }
  await Promise.all(renameJobs);

  const row = {
    name,
    positions,
    createdAt: now,
    lastUsedAt: now,
    expiresAt: now + TTL_MS,
    teamId: team.id,
    leadConversationId: lead.conversation_id,
  };
  writeTeams([...teams, row]);
  console.log(
    `TEAM_ADDED name=${name} team_id=${team.id} lead_conversation=${lead.conversation_id} positions=${positions.join(',')} workspace=${workspace}`
  );
}

async function cmdSend(args) {
  const name = String(args.team || '').trim();
  if (!name) fail('--team is required');
  let content;
  if (args.file) {
    try {
      content = fs.readFileSync(args.file, 'utf8');
    } catch (error) {
      fail(`cannot read --file ${args.file} (${error.message})`);
    }
  } else if (args.message) {
    content = String(args.message);
  } else {
    fail('pass the task with --file <path> or --message <text>');
  }
  content = content.trim();
  if (!content) fail('the task text is empty');

  const teams = readTeams();
  const team = findTeam(teams, name) || fail(`no team named "${name}" in ${TEAMS_FILE} (run: node teams.cjs list)`);
  await api('POST', `/api/teams/${team.teamId}/messages`, { content, files: [] });

  const now = Date.now();
  team.lastUsedAt = now;
  team.expiresAt = now + TTL_MS;
  writeTeams(teams);
  console.log(
    `SENT team=${team.name} to_conversation=${team.leadConversationId} refreshed_until=${iso(team.expiresAt)}`
  );
}

const COMMANDS = { list: cmdList, match: cmdMatch, add: cmdAdd, send: cmdSend };

(async () => {
  const [command, ...rest] = process.argv.slice(2);
  const run = COMMANDS[command];
  if (!run) fail(`usage: teams.cjs <${Object.keys(COMMANDS).join('|')}> [options]`);
  try {
    await run(parseArgs(rest));
  } catch (error) {
    fail(error && error.message ? error.message : String(error));
  }
})();
