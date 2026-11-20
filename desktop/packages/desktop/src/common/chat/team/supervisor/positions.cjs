#!/usr/bin/env node
/**
 * mu desktop supervisor workspace — read-only position-roster CLI. Written
 * into the supervisor workspace by the desktop app
 * (process/services/supervisor/supervisorService.ts); the supervisor agent
 * runs it from that workspace as the new-project/new-position dedup check
 * (supervisor rules, 规则 5): before creating any project or position, list
 * every existing position and compare domains.
 *
 * The parsing mirrors common/chat/positions/positionLibraryCore.ts (the
 * contract): a position is an .md file whose frontmatter carries both `name`
 * and `description` (README.md is documentation, not a position); the project
 * root is the body's 「项目根：`E:/x/y`」 backtick line. Keep the two in sync.
 *
 * Subcommands:
 *   list    one `POSITION <displayName(name)|name> | <description> | project=<root|->` line per
 *           position, then `COUNT <n>`; a missing library dir is an empty
 *           roster, not an error
 *
 * The library is `$MU_POSITION_LIBRARY` or `~/.mu/agent/agents`, read-only —
 * the library is the user's, this script never writes it. Errors print
 * `ERROR …` on stderr and exit 1, the same convention as teams.cjs.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIBRARY = process.env.MU_POSITION_LIBRARY || path.join(os.homedir(), '.mu', 'agent', 'agents');

const fail = (message) => {
  console.error(`ERROR ${message}`);
  process.exit(1);
};

/** `---\nname: x\ndescription: y\n---\n…` → the position, or null when the file is not one. */
function parsePosition(fileName, content) {
  if (fileName.toLowerCase() === 'readme.md') return null;
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!frontmatter) return null;
  const fields = {};
  for (const line of frontmatter[1].split(/\r?\n/)) {
    const match = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (match) fields[match[1]] = match[2];
  }
  const name = (fields.name || '').trim();
  const description = (fields.description || '').trim();
  if (!name || !description) return null;
  const displayName = (fields.display_name || '').trim() || name;
  const label = displayName === name ? name : `${displayName}(${name})`;
  const root = /项目根[：:]\s*`([^`]+)`/.exec(content);
  return { name, displayName, label, description, projectRoot: root ? root[1].trim() : undefined };
}

function readPositions() {
  let files;
  try {
    files = fs.readdirSync(LIBRARY);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const positions = [];
  for (const file of files.filter((name) => name.toLowerCase().endsWith('.md')).toSorted()) {
    let content;
    try {
      content = fs.readFileSync(path.join(LIBRARY, file), 'utf8');
    } catch {
      continue;
    }
    const position = parsePosition(file, content);
    if (position) positions.push(position);
  }
  return positions;
}

function cmdList() {
  const positions = readPositions();
  for (const position of positions) {
    console.log(`POSITION ${position.label} | ${position.description} | project=${position.projectRoot || '-'}`);
  }
  console.log(`COUNT ${positions.length}`);
}

/** Minimal `--key value` argv, the same shape teams.cjs parses. */
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

const COMMANDS = { list: cmdList };

(async () => {
  const [command, ...rest] = process.argv.slice(2);
  const run = COMMANDS[command];
  if (!run) fail(`usage: positions.cjs <${Object.keys(COMMANDS).join('|')}> [options]`);
  try {
    await run(parseArgs(rest));
  } catch (error) {
    fail(error && error.message ? error.message : String(error));
  }
})();
