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
 *                                           (soft-deleted teams are invisible)
 *   match --positions a,b                   `MATCH <name>` when an active team's
 *                                           positions cover the needed set, else `NONE`
 *                                           (a soft-deleted team never matches)
 *   add  --name X --positions a,b           create the team (backend POST /api/teams,
 *                                           members = the positions as mu slots), seed
 *                                           the workspace's AGENTS.md dispatch rules,
 *                                           register it
 *   send --team X (--file F | --message M)  deliver a task to the team and refresh
 *                                           its lifecycle (the team's own ttlDays;
 *                                           permanent teams never expire)
 *   lesson --position a --text "..."        append one lesson line to the shared
 *                                           ledger ../_shared/LESSONS.md (the wrap-up
 *                                           gate's double write: date|position|one line)
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
const DAY_MS = 24 * 60 * 60 * 1000;
/** The lifecycle every row without one reads as: the format's 7-day origin. */
const DEFAULT_TTL_DAYS = 7;
const MIN_TTL_DAYS = 1;
const MAX_TTL_DAYS = 365;
const TEAMS_FILE = path.resolve(__dirname, '..', '_shared', 'TEAMS.md');
/** The lock file guarding TEAMS.md read-modify-write cycles: same policy as the desktop's teamsFileLock.ts (O_EXCL create, stale takeover) — this script and the desktop are separate processes mutating one file. */
const TEAMS_LOCK_FILE = `${TEAMS_FILE}.lock`;
/** The shared lessons ledger the wrap-up gate's `lesson` subcommand appends to: one line per recorded lesson, same folder as the teams index. */
const LESSONS_FILE = path.resolve(__dirname, '..', '_shared', 'LESSONS.md');
/** Same lock policy as TEAMS.md, on its own file: two positions may wrap up at once. */
const LESSONS_LOCK_FILE = `${LESSONS_FILE}.lock`;
/** Marks the ledger as app-managed prose (not a parsed table): a hand edit is fine, nothing parses it. */
const LESSONS_MARKER = '<!-- mu-desktop lessons v1 -->';
/** A lesson is one line; a longer text is cut, newlines fold to spaces. */
const LESSON_TEXT_CAP = 500;
/** A lock file older than this holds nothing: its writer died, so a waiter takes it over. */
const LOCK_STALE_MS = 5000;
const TEAMS_MARKER = '<!-- mu-supervisor-teams v1 -->';
/** The dispatch rules block for a fresh team workspace; the app injects the canonical text in place of this whole `null` expression when it ships the script. */
const DISPATCH_RULES_BLOCK = /* mu-dispatch-rules-block */ null;
const TABLE_HEADER =
  '| 队名 | 岗位成员 | 创建时间 | 最后复用 | 到期时间 | team_id | lead会话 | TTL天数 | 永久 | 删除时间 |';
const TABLE_RULE = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';
/** The permanent flag's cell text; anything else reads as false. */
const PERMANENT_CELL = '是';

/** A row's day count, clamped into the allowed range, the default when unparsable. */
const clampTtlDays = (days) => {
  const clamped = Math.min(MAX_TTL_DAYS, Math.max(MIN_TTL_DAYS, Math.round(days)));
  return Number.isFinite(clamped) ? clamped : DEFAULT_TTL_DAYS;
};

/** Whether a team is soft-deleted: it left every surface and waits out its grace. */
const isDeleted = (team) => team.deletedAt !== undefined;

/** Whether a team is still matchable: a permanent team never retires; a deleted team never matches. */
const isActive = (team, now) => team.deletedAt === undefined && (team.permanent || team.expiresAt > now);

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
 * `货代` (its display name) when it has one, so a model may pass any of the three
 * spellings to --positions. This maps every spelling to the id TEAMS.md keys
 * on, and ids to their display name (the team slot names carry the display
 * name, so the sidebar shows 货代 (the display name), not forwarder (the
 * id)). Best-effort: an unreadable
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
 * display name(id)) settles on the id.
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

/** A pipe-table cell's text, safe to write: backslashes double first, `|` escapes as `\|`, line breaks fold to spaces — a hostile name must not corrupt its row. */
const escapeCell = (text) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** A cell's text back: `\\` and `\|` unescape; any other `\x` stays, so an index an older version wrote still reads unchanged. */
const unescapeCell = (text) => text.replace(/\\(.)/g, (match, next) => (next === '\\' || next === '|' ? next : match));

/** A row's cells, split on the pipes that are not the `\|` escape. */
const splitCells = (row) => row.split(/(?<!\\)\|/).map((cell) => unescapeCell(cell.trim()));

/** The shape a backend team id may take: ids flow into backend URL paths, so anything with separators or dots reads as a malformed row. */
const TEAM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function parseTeams(content) {
  if (!content.includes(TEAMS_MARKER)) return [];
  const teams = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = splitCells(trimmed.slice(1, -1));
    // Seven cells is the pre-lifecycle format: it reads as the default 7-day,
    // non-permanent team it was.
    if (cells.length !== 7 && cells.length !== 9 && cells.length !== 10) continue;
    const createdAt = Date.parse(cells[2]);
    const lastUsedAt = Date.parse(cells[3]);
    const expiresAt = Date.parse(cells[4]);
    if (!Number.isFinite(createdAt) || !Number.isFinite(lastUsedAt) || !Number.isFinite(expiresAt)) continue;
    if (!cells[0] || !cells[5] || !cells[6]) continue;
    // A teamId or conversation id outside its shape would flow into backend
    // URL paths (send, purge); the row reads as malformed, like any other.
    if (!TEAM_ID_RE.test(cells[5]) || !TEAM_ID_RE.test(cells[6])) continue;
    // A ten-cell row's empty last cell reads as not deleted, as do the older
    // seven- and nine-cell formats.
    const deletedAt = cells.length === 10 ? Date.parse(cells[9]) : Number.NaN;
    teams.push({
      name: cells[0],
      positions: cells[1]
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean),
      createdAt,
      lastUsedAt,
      expiresAt,
      ttlDays: cells.length >= 9 ? clampTtlDays(parseInt(cells[7], 10)) : DEFAULT_TTL_DAYS,
      permanent: cells.length >= 9 && cells[8] === PERMANENT_CELL,
      deletedAt: Number.isFinite(deletedAt) ? deletedAt : undefined,
      teamId: cells[5],
      leadConversationId: cells[6],
    });
  }
  return teams;
}

function buildTeams(teams, now) {
  const active = teams.filter((t) => isActive(t, now)).toSorted((a, b) => b.lastUsedAt - a.lastUsedAt);
  const retired = teams
    .filter((t) => !isActive(t, now) && !isDeleted(t))
    .toSorted((a, b) => b.lastUsedAt - a.lastUsedAt);
  const deleted = teams.filter((t) => isDeleted(t)).toSorted((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
  const table = (rows) => (rows.length === 0 ? [] : [TABLE_HEADER, TABLE_RULE, ...rows.map(teamRow)]);
  const lines = [TEAMS_MARKER, '# 临时团队索引（由 teams.cjs 维护，勿手改）', '', ...table(active)];
  if (active.length > 0) lines.push('');
  if (retired.length > 0) lines.push('已退役（到期未复用，不再匹配）：', '', ...table(retired), '');
  if (deleted.length > 0) lines.push('已删除（7 天内可恢复，到期连同后端团队彻底删除）：', '', ...table(deleted));
  return `${lines.join('\n')}\n`;
}

const teamRow = (t) =>
  `| ${escapeCell(t.name)} | ${escapeCell(t.positions.join(', '))} | ${iso(t.createdAt)} | ${iso(t.lastUsedAt)} | ${iso(
    t.expiresAt
  )} | ${escapeCell(t.teamId)} | ${escapeCell(t.leadConversationId)} | ${t.ttlDays} | ${
    t.permanent ? PERMANENT_CELL : ''
  } | ${t.deletedAt !== undefined ? iso(t.deletedAt) : ''} |`;

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
  // Temp-then-rename: an unlocked reader (the desktop's sidebar, another
  // command) never sees a torn half-written file.
  const temp = `${TEAMS_FILE}.write`;
  fs.writeFileSync(temp, buildTeams(teams, Date.now()), 'utf8');
  fs.renameSync(temp, TEAMS_FILE);
}

/** A synchronous sleep (the script is sync): Atomics.wait on the main thread blocks without burning CPU. */
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Runs `work` holding the lock file `lockFile`: O_EXCL create, so exactly one
 * holder; a held lock older than LOCK_STALE_MS is a dead writer's leftover and is
 * taken over (unlinked only when a second stat still shows the same stale
 * mtime, never a fresh lock another waiter just won); the winner unlinks in
 * `finally`. Holders hold for milliseconds (read, splice, write), so waiting
 * is a short poll.
 */
function withFileLock(lockFile, work) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockFile, 'wx'));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let held;
    try {
      held = fs.statSync(lockFile);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (Date.now() - held.mtimeMs > LOCK_STALE_MS) {
      try {
        const again = fs.statSync(lockFile);
        if (again.mtimeMs === held.mtimeMs) fs.unlinkSync(lockFile);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      continue;
    }
    sleepSync(25);
  }
  try {
    return work();
  } finally {
    try {
      fs.unlinkSync(lockFile);
    } catch {}
  }
}

/** The teams index's own lock: every TEAMS.md read-modify-write cycle. */
const withTeamsLock = (work) => withFileLock(TEAMS_LOCK_FILE, work);

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
  if (safe === '' || safe === '.' || safe === '..') fail(`team name "${name}" cannot become a safe workspace folder`);
  const root = path.resolve(__dirname, '..', '..', 'teams');
  let dir = path.join(root, safe);
  if (fs.existsSync(dir)) dir = path.join(root, `${safe}-${Date.now().toString(36)}`);
  return dir;
}

const findTeam = (teams, name) => teams.find((t) => t.name === name);

async function cmdList() {
  const teams = readTeams();
  const now = Date.now();
  // Soft-deleted teams are invisible here too: they left, they are the
  // desktop's restore queue, not the supervisor's roster.
  const active = teams.filter((t) => isActive(t, now));
  const retired = teams.filter((t) => !isActive(t, now) && !isDeleted(t)).length;
  for (const t of active) {
    console.log(
      `TEAM ${t.name} | positions=${t.positions.join(',')} | expires=${
        t.permanent ? 'permanent' : iso(t.expiresAt)
      } | team_id=${t.teamId} | lead_conversation=${t.leadConversationId}`
    );
  }
  console.log(retired > 0 ? `RETIRED ${retired}` : 'RETIRED 0');
}

async function cmdMatch(args) {
  const needed = parsePositions(args.positions);
  if (needed.length === 0) fail('--positions is required (comma-separated position names)');
  const now = Date.now();
  const candidates = readTeams().filter((t) => isActive(t, now) && needed.every((p) => t.positions.includes(p)));
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
      teams.filter((t) => isActive(t, now)),
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

  // Slots carry the positions' display names (货代, the display name, not
  // forwarder, the id): the team
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
    expiresAt: now + DEFAULT_TTL_DAYS * DAY_MS,
    ttlDays: DEFAULT_TTL_DAYS,
    permanent: false,
    deletedAt: undefined,
    teamId: team.id,
    leadConversationId: lead.conversation_id,
  };
  // The registration is its own locked read-modify-write: the teams read at
  // the top predates the backend calls, so the write re-reads inside the
  // lock — a team another process added meanwhile survives.
  withTeamsLock(() => writeTeams([...readTeams(), row]));
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
  // A deleted team with the name is not the team: it left the roster, so a
  // send aimed at it fails instead of reviving it.
  const team =
    findTeam(
      teams.filter((t) => !isDeleted(t)),
      name
    ) || fail(`no team named "${name}" in ${TEAMS_FILE} (run: node teams.cjs list)`);
  await api('POST', `/api/teams/${team.teamId}/messages`, { content, files: [] });

  // The refresh is its own locked read-modify-write: re-read inside the
  // lock and refresh the row by team id; a row that vanished between the
  // POST and here (a purge raced this send) is left gone — not resurrected.
  const refreshed = withTeamsLock(() => {
    const fresh = readTeams();
    const row = fresh.find((t) => t.teamId === team.teamId);
    if (!row) return undefined;
    const now = Date.now();
    row.lastUsedAt = now;
    // The team's own lifecycle: a reuse extends to `now + ttlDays`; a permanent
    // team never expires, so its recorded expiry stays untouched.
    if (!row.permanent) row.expiresAt = now + row.ttlDays * DAY_MS;
    writeTeams(fresh);
    return row;
  });
  const logged = refreshed || team;
  console.log(
    `SENT team=${logged.name} to_conversation=${logged.leadConversationId} refreshed_until=${
      logged.permanent ? 'permanent' : iso(logged.expiresAt)
    }`
  );
}

/** One position's spelling as the ledger's middle cell: any of the three roster spellings (id, display name, display(id)) settles on the id. */
function lessonPositionOf(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  const { aliases } = positionAliases();
  const stripped = /^(.*)\([A-Za-z0-9._-]+\)$/.exec(trimmed);
  return aliases.get(trimmed) || (stripped && aliases.get(stripped[1])) || trimmed;
}

/** A local `YYYY-MM-DD` (the ledger's first cell): lessons are read by humans in their own timezone. */
const localDate = () => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
};

async function cmdLesson(args) {
  const position = lessonPositionOf(args.position);
  if (!position) fail('--position is required (the position id, or its display name)');
  // One line: whitespace runs (line breaks a model may send) fold to spaces, then the cap.
  const text = String(args.text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LESSON_TEXT_CAP);
  if (!text) fail('--text is required (the lesson, one line)');
  const date = localDate();
  // The append is a locked read-modify-write, like every ledger write: two
  // positions wrapping up at once both land. Temp-then-rename keeps readers
  // (the supervisor's memory check) off a torn file.
  withFileLock(LESSONS_LOCK_FILE, () => {
    let existing = '';
    try {
      existing = fs.readFileSync(LESSONS_FILE, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const lines = existing ? existing.split(/\r?\n/) : [];
    // The heading rides the first line in: an empty ledger gains it, an
    // existing one keeps whatever its writer left.
    const head =
      lines.length === 0 ? [LESSONS_MARKER, '# 岗位教训总账（各岗收尾经 teams.cjs lesson 追加，勿手改）', ''] : [];
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const next = `${[...lines, ...head, `${date} | ${position} | ${text}`].join('\n')}\n`;
    fs.mkdirSync(path.dirname(LESSONS_FILE), { recursive: true });
    const temp = `${LESSONS_FILE}.write`;
    fs.writeFileSync(temp, next, 'utf8');
    fs.renameSync(temp, LESSONS_FILE);
  });
  console.log(`LESSON_ADDED date=${date} position=${position}`);
}

const COMMANDS = { list: cmdList, match: cmdMatch, add: cmdAdd, send: cmdSend, lesson: cmdLesson };

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
