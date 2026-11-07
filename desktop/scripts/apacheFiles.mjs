#!/usr/bin/env node
// Lists the files in desktop/ that came from AionUi, which stay under the Apache License 2.0 (see NOTICE); every
// other file is mu's, under the MIT license. Writes APACHE-FILES.txt next to package.json.
//
//   node scripts/apacheFiles.mjs                     fetches AionUi v2.2.2 into a temporary folder
//   node scripts/apacheFiles.mjs --upstream <repo>   uses a clone that has commit 6744099b
//   node scripts/apacheFiles.mjs --check             says whether APACHE-FILES.txt is up to date
//
// A file came from AionUi when it has the same path as a file of AionUi v2.2.2 (6744099b, the version the fork is
// based on), or when 15% or more of its distinctive lines (30 characters or more, with a letter) appear in AionUi's
// files of the same kind: code copied or moved to a new path. Lines are compared without case and with AionUi's names
// read as mu's (`AIONUI_E_…` and `MU_E_…`, `AionModal` and `MuModal` are the same line), so renaming AionUi's code
// keeps it on the list. Rewriting such a file from scratch, or deleting it, takes it off the list.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIST = join(DESKTOP, 'APACHE-FILES.txt');
const UPSTREAM = 'https://github.com/iOfficeAI/AionUi.git';
const BASE = '6744099b279b991c17e31c243f0920477bd31cb6';
const SHARED = 0.15;
const TEXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.html',
  '.sh',
  '.ps1',
  '.nsh',
  '.toml',
  '.txt',
  '.svg',
  '.scss',
  '.less',
]);
const TEXT_NAMES = new Set(['justfile', 'Makefile', 'LICENSE', '.gitignore']);
/** The legal files say what the license is; they are not code from either side. */
const LEGAL = new Set(['LICENSE', 'LICENSE-APACHE', 'NOTICE', 'APACHE-FILES.txt']);

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
const isText = (path) => TEXT.has(extname(path).toLowerCase()) || TEXT_NAMES.has(path.split('/').at(-1));

/**
 * The lines that say something: whitespace evened out, 30 characters or more, with a letter. Each is kept in lower
 * case with AionUi's names as mu's (AionCore as the backend, Aionrs as the built-in agent), so a line that only had
 * its names changed is still the same line.
 */
function distinctive(text) {
  const lines = new Set();
  for (const line of text.split('\n')) {
    const even = line.trim().split(/\s+/).join(' ');
    if (even.length < 30 || !/\p{L}/u.test(even)) continue;
    lines.add(
      even
        .toLowerCase()
        .replace(/(?:the )?(?:aioncore|backend)/g, 'backend')
        .replace(/aionrs|builtin[-_]?agent/g, 'builtinagent')
        .replace(/aion(?:ui)?/g, 'mu')
    );
  }
  return lines;
}

function upstreamRepo(args) {
  const at = args.indexOf('--upstream');
  if (at >= 0) return resolve(args[at + 1]);
  const repo = mkdtempSync(join(tmpdir(), 'upstream-'));
  git(repo, ['init', '-q']);
  git(repo, ['fetch', '-q', '--depth', '1', UPSTREAM, BASE]);
  return repo;
}

function upstreamFiles(upstream) {
  const rows = git(upstream, ['ls-tree', '-r', BASE]).trim().split('\n');
  const paths = new Set();
  const linesByKind = new Map();
  for (const row of rows) {
    const [meta, path] = row.split('\t');
    paths.add(path);
    if (!isText(path)) continue;
    const kind = extname(path).toLowerCase();
    const lines = linesByKind.get(kind) ?? new Set();
    for (const line of distinctive(git(upstream, ['cat-file', 'blob', meta.split(' ')[2]]))) lines.add(line);
    linesByKind.set(kind, lines);
  }
  const ours = git(DESKTOP, ['ls-files']).trim().split('\n');
  return ours.filter((path) => {
    if (LEGAL.has(path)) return false;
    if (paths.has(path)) return true;
    const full = join(DESKTOP, path);
    if (!isText(path) || !existsSync(full) || !statSync(full).isFile()) return false;
    const mine = distinctive(readFileSync(full, 'utf8'));
    if (mine.size === 0) return false;
    const theirs = linesByKind.get(extname(path).toLowerCase()) ?? new Set();
    let shared = 0;
    for (const line of mine) if (theirs.has(line)) shared += 1;
    return shared / mine.size >= SHARED;
  });
}

const args = process.argv.slice(2);
const files = upstreamFiles(upstreamRepo(args)).sort();
const text = `# Files in desktop/ that came from AionUi (https://github.com/iOfficeAI/AionUi, v2.2.2, ${BASE.slice(0, 8)}).
# They stay under the Apache License 2.0 (LICENSE-APACHE); every other file in desktop/ is under the MIT license
# (LICENSE). Regenerate with: node scripts/apacheFiles.mjs
${files.join('\n')}
`;
if (args.includes('--check')) {
  const current = existsSync(LIST) ? readFileSync(LIST, 'utf8') : '';
  if (current !== text) {
    console.error('APACHE-FILES.txt is out of date: run node scripts/apacheFiles.mjs');
    process.exit(1);
  }
  console.log(`APACHE-FILES.txt is up to date: ${files.length} files from AionUi.`);
} else {
  writeFileSync(LIST, text);
  console.log(`Wrote APACHE-FILES.txt: ${files.length} files from AionUi.`);
}
