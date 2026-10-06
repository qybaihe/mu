import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { load } from 'js-yaml';
import { KyrnError } from '../../../../common/kyrn/errors';
import { configPath } from '../naming';
import { asRecord, type JsonRecord } from '../piRpc';

/*
 * What the skills and MCP readers share: mu.json's switches, the frontmatter of a skill's file, and the checks on what
 * the screen sends. The rules are the harness's (see common/kyrn/capabilities.ts).
 */

/** Config and skill files are small: anything larger is not what it claims to be (mu's `MAX_FILE_BYTES`). */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** A skill's file is read up to this size, as mu reads the skills it takes over. */
export const MAX_SKILL_BYTES = 512 * 1024;

/** The text of a file without a byte order mark; undefined when it is missing, no file, too large or unreadable. */
export function readSmall(path: string, maxBytes = MAX_FILE_BYTES): string | undefined {
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > maxBytes) return undefined;
    return readFileSync(path, 'utf8').replace(/^﻿/, '');
  } catch {
    return undefined;
  }
}

/** The path with its links resolved, or the path itself when that fails. */
export function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** mu.json (kyrn.json on a home not moved yet): `config` is `{}` when it is missing or broken, as the harness takes it. */
export function readMuConfig(agentDir: string): { file: string; config: JsonRecord; broken: boolean } {
  const file = configPath(agentDir);
  const text = readSmall(file);
  if (text === undefined) return { file, config: {}, broken: false };
  try {
    const parsed: unknown = JSON.parse(text);
    const config = asRecord(parsed);
    return { file, config, broken: config !== parsed };
  } catch {
    return { file, config: {}, broken: true };
  }
}

/** A feature's options: its defaults, overridden by `features.<name>` when that is an object; `false` switches it off. */
export function featureOptions<T extends { enabled: boolean }>(config: JsonRecord, name: string, defaults: T): T {
  const value = asRecord(config.features)[name];
  if (value === false) return { ...defaults, enabled: false };
  if (value === true) return { ...defaults, enabled: true };
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return { ...defaults, ...value } as T;
  return defaults;
}

/** What mu takes over from Claude Code, Cursor and Codex, and whether it does at all (`INHERIT_DEFAULTS` of mu). */
export const INHERIT_DEFAULTS = {
  enabled: true,
  claude: true,
  cursor: true,
  codex: true,
  rules: true,
  skills: true,
  mcp: true,
};

/** The frontmatter of a Markdown file as pi reads it: the YAML between a first `---` line and the next. */
export function frontmatter(text: string): JsonRecord {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---')) return {};
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return {};
  return asRecord(load(normalized.slice(4, end)));
}

/** A full path as the screen sends it: one line, not too long. */
export function readPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    value.includes('\u0000') ||
    /[\r\n]/.test(value) ||
    !isAbsolute(value)
  )
    throw new KyrnError('invalid', 'Invalid path');
  return value;
}

/** A name as the screen sends it: a short line. */
export function readName(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 200 || [...value].some((character) => character < ' '))
    throw new KyrnError('invalid', 'Invalid name');
  return value;
}
