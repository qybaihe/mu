#!/usr/bin/env node
/**
 * mu desktop supervisor workspace — position-template catalog CLI. Written
 * into the supervisor workspace by the desktop app
 * (process/services/team/supervisor/supervisorService.ts); the supervisor
 * agent runs it from that workspace when the roster covers nothing
 * (supervisor rules, rule 6): it searches the community template catalog
 * (awesome-grok-bot, CC0-1.0) for a reference before drafting a new
 * position to propose.
 *
 * The catalog is a CACHE the desktop downloads (the wizard's template tab
 * or the startup fetch); this script never goes online and never writes —
 * no cache on disk is not an error but `UNAVAILABLE`, so the supervisor's
 * rule 3 (paste ERROR and stop) never fires for a missing catalog: the
 * rules say to skip the template step and propose from task context alone.
 *
 * The search spec mirrors common/chat/team/positions/templateCatalogCore.ts
 * (the contract): substring, case-insensitive; a name hit weighs 4, a tag 3,
 * a category or the Chinese summary 2, the English summary 1; entries sort
 * by score then slug. Keep the two in sync.
 *
 * Subcommands:
 *   search "<query>" [--category X] [--limit N]
 *           up to N (default 5) `TEMPLATE <name> | <summary_zh> | <category> | slug=<slug>`
 *           lines, then `COUNT <n>`; `COUNT 0` when nothing matches
 *   get <slug>
 *           the entry's full block (name, summaries, category, tags, the
 *           share link); `NOT_FOUND <slug>` when the slug is unknown
 *
 * The catalog file is `$MU_TEMPLATE_CATALOG` or
 * `<workspace>/../_shared/templates/catalog.json` (the shared folder every
 * position workspace resolves the same way). Errors of usage print
 * `ERROR …` on stderr and exit 1, the same convention as teams.cjs; a
 * missing or unparsable catalog prints `UNAVAILABLE <reason>` on stdout and
 * exits 0.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CATALOG =
  process.env.MU_TEMPLATE_CATALOG || path.resolve(__dirname, '..', '_shared', 'templates', 'catalog.json');

const fail = (message) => {
  console.error(`ERROR ${message}`);
  process.exit(1);
};

/** The catalog's entries, or an UNAVAILABLE reason string. */
function readCatalog() {
  let text;
  try {
    text = fs.readFileSync(CATALOG, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT')
      return { reason: 'no local catalog cache yet (open the position wizard template tab once, or restart the app)' };
    return { reason: `cannot read the catalog cache: ${error.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { reason: `the catalog cache is not valid JSON: ${error.message}` };
  }
  const raw = parsed && Array.isArray(parsed.entries) ? parsed.entries : undefined;
  if (!raw) return { reason: 'the catalog cache has no entries array' };
  const entries = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const slug = typeof item.slug === 'string' ? item.slug.trim() : '';
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const summaryZh = typeof item.summary_zh === 'string' ? item.summary_zh.trim() : '';
    const category = typeof item.category === 'string' ? item.category.trim() : '';
    if (!slug || !name || !summaryZh || !category) continue;
    entries.push({
      slug,
      name,
      summaryZh,
      category,
      tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === 'string') : [],
      summary: typeof item.summary === 'string' ? item.summary.trim() : '',
      import: typeof item.import === 'string' ? item.import.trim() : '',
      updated: typeof item.updated === 'string' ? item.updated : '',
      verified: item.verified === true,
    });
  }
  if (entries.length === 0) return { reason: 'the catalog cache carries no usable entries' };
  return { entries };
}

/** How well one entry answers one lowercase token (see the header for the weights). */
function entryScore(entry, token) {
  if (entry.name.toLowerCase().includes(token)) return 4;
  if (entry.tags.some((tag) => tag.toLowerCase().includes(token))) return 3;
  if (entry.category.toLowerCase().includes(token)) return 2;
  if (entry.summaryZh.toLowerCase().includes(token)) return 2;
  if (entry.summary.toLowerCase().includes(token)) return 1;
  return 0;
}

function cmdSearch(positional, args) {
  const query = positional || '';
  const limit = Math.max(1, Math.min(20, Number.parseInt(args.limit || '5', 10) || 5));
  const whole = query.trim().toLowerCase();
  const words = whole.split(/\s+/).filter((w) => w && /[a-z0-9]/.test(w));
  const tokens = whole ? (words.length > 0 ? words : [whole]) : [];
  if (tokens.length === 0) fail('usage: templates.cjs search "<query>" [--category X] [--limit N]');
  const read = readCatalog();
  if (read.reason) {
    console.log(`UNAVAILABLE ${read.reason}`);
    return;
  }
  const scored = read.entries
    .filter((entry) => !args.category || entry.category === args.category)
    .map((entry) => ({ entry, score: tokens.reduce((sum, token) => sum + entryScore(entry, token), 0) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || (a.entry.slug < b.entry.slug ? -1 : 1))
    .slice(0, limit);
  for (const row of scored) {
    const summary = row.entry.summaryZh.replace(/\s+/g, ' ');
    console.log(
      `TEMPLATE ${row.entry.name} | ${summary.length > 80 ? `${summary.slice(0, 79)}…` : summary} | ${row.entry.category} | slug=${row.entry.slug}`
    );
  }
  console.log(`COUNT ${scored.length}`);
}

function cmdGet(positional) {
  const slug = positional || '';
  if (!slug) fail('usage: templates.cjs get <slug>');
  const read = readCatalog();
  if (read.reason) {
    console.log(`UNAVAILABLE ${read.reason}`);
    return;
  }
  const entry = read.entries.find((item) => item.slug === slug);
  if (!entry) {
    console.log(`NOT_FOUND ${slug}`);
    return;
  }
  console.log(`name: ${entry.name}`);
  console.log(`slug: ${entry.slug}`);
  console.log(`category: ${entry.category}`);
  console.log(`tags: ${entry.tags.join(', ')}`);
  console.log(`summary_zh: ${entry.summaryZh}`);
  console.log(`summary: ${entry.summary}`);
  console.log(`import: ${entry.import}`);
  console.log(`updated: ${entry.updated}${entry.verified ? ' (verified)' : ''}`);
}

/** Minimal `--key value` argv, the same shape positions.cjs parses. */
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

const COMMANDS = { search: cmdSearch, get: cmdGet };

(async () => {
  const [command, ...rest] = process.argv.slice(2);
  const run = COMMANDS[command];
  if (!run) fail(`usage: templates.cjs <${Object.keys(COMMANDS).join('|')}> [options]`);
  const positional = rest.find((arg) => !arg.startsWith('--'));
  try {
    await run(positional, parseArgs(rest));
  } catch (error) {
    fail(error && error.message ? error.message : String(error));
  }
})();
