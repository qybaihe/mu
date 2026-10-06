/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NormalizedToolCall, NormalizedToolStatus } from '@/common/chat/normalizeToolCall';

/**
 * How a stretch of tool calls reads when it is folded into one line.
 *
 * A turn can run a dozen tools; listing them all costs the reply its shape. One line says how many steps ran and what
 * is happening right now, and opens to the steps themselves. What went wrong is never folded away: a failed step keeps
 * its own line under the fold, so a failure is read without a click.
 */

/**
 * A tool call in the box: the verb it ran as (`read`, `bash`) and what it ran on (`src/a.ts`, `npm test`). `path`: the
 * target names a file or folder, which a narrow row cuts in its middle, so the name itself stays in sight.
 */
export type ToolLabel = { verb: string; target?: string; path?: boolean };

export type ToolActivityStatus = 'running' | 'error' | 'done';

export type ToolActivitySummary = {
  /** How many calls the stretch holds. */
  steps: number;
  status: ToolActivityStatus;
  /** The call the box is waiting on, when one is still running. */
  running?: ToolLabel;
  failed: number;
};

export type ToolActivityError = { key: string; label: ToolLabel; line: string };

/** A call still on its way: `pending` is a call the agent announced but has not started. */
const isLive = (status: NormalizedToolStatus): boolean => status === 'running' || status === 'pending';

/** The arguments that name a file or folder. */
const PATH_KEYS: ReadonlySet<string> = new Set(['file_path', 'path']);

/**
 * A shell command as tools give it: a string (`command`, or `cmd` as Codex's `exec_command` names it), or the words of
 * a command line (Codex's `shell` sends `["bash", "-lc", "npm test"]`, and what ran is the script, `npm test`).
 */
const commandText = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value || undefined;
  if (!Array.isArray(value) || value.length === 0 || !value.every((part) => typeof part === 'string')) return undefined;
  const words: string[] = value;
  return words.length >= 3 && /^-\w*c$/.test(words[words.length - 2]) ? words[words.length - 1] : words.join(' ');
};

/** The arguments a shell command is in, before the ones that name a file or a search. */
const COMMAND_KEYS: ReadonlySet<string> = new Set(['command', 'cmd']);

/**
 * The one string worth showing next to a tool's name, and whether it is a path. A JSON input is mined for the argument
 * that names the work (a command, a path, a query); anything else falls back to its first line.
 */
const inputTarget = (input?: string): { text: string; path: boolean } | undefined => {
  if (!input) return undefined;
  try {
    const value: unknown = JSON.parse(input);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      for (const key of ['command', 'cmd', 'file_path', 'path', 'query', 'pattern', 'url', 'prompt']) {
        const text = COMMAND_KEYS.has(key) ? commandText(record[key]) : record[key];
        if (typeof text === 'string' && text) return { text, path: PATH_KEYS.has(key) };
      }
      return undefined;
    }
  } catch {
    const text = input.split('\n', 1)[0];
    return text ? { text, path: false } : undefined;
  }
  return undefined;
};

/** A home folder at the start of a path: macOS, Linux and Windows. */
const HOME = /^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\]|$)/;

/** A path as a row shows it: the home folder as `~`, the rest as it is. The whole path stays in the row's tooltip. */
export const shortPath = (path: string): string => path.replace(HOME, '~');

/** What a call line shows: its verb and its target, else the call's own description. */
export const toolLabel = (item: NormalizedToolCall): ToolLabel => {
  const named = inputTarget(item.input);
  if (!named) return { verb: item.name, target: item.description || undefined };
  return named.path ? { verb: item.name, target: named.text, path: true } : { verb: item.name, target: named.text };
};

/** An error said in one line: the first line of the output that carries words, cut to something a row can hold. */
const ERROR_LINE_MAX = 160;

export const toolErrorLine = (item: NormalizedToolCall): string | undefined => {
  const source = item.output || item.description || '';
  const line = source
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  if (!line) return undefined;
  return line.length > ERROR_LINE_MAX ? `${line.slice(0, ERROR_LINE_MAX - 1)}…` : line;
};

/** A call that failed. One the person said no to never ran, which is no failure. */
const isFailure = (item: NormalizedToolCall): boolean => item.status === 'error' && !item.denied;

/** What the folded line says: the count, whether anything is still running, and how many calls failed. */
export function summarizeToolActivity(tools: NormalizedToolCall[]): ToolActivitySummary {
  const running = tools.find((item) => isLive(item.status));
  const failed = tools.filter(isFailure).length;
  return {
    steps: tools.length,
    status: running ? 'running' : failed > 0 ? 'error' : 'done',
    ...(running ? { running: toolLabel(running) } : {}),
    failed,
  };
}

/** What kind of work a call was, for the folded line's count: files read, lookups, edits, commands, the web. */
export type ToolActivityKind = 'read' | 'look' | 'edit' | 'run' | 'web' | 'other';

/** The order the folded line names the kinds in. */
export const TOOL_ACTIVITY_KINDS: readonly ToolActivityKind[] = ['read', 'look', 'edit', 'run', 'web', 'other'];

/** Tool names by kind, as mu, pi and the agents the app imports from name them (case does not matter). */
const KIND_OF: Readonly<Record<string, ToolActivityKind>> = {
  read: 'read',
  read_file: 'read',
  view: 'read',
  grep: 'look',
  find: 'look',
  ls: 'look',
  glob: 'look',
  locate: 'look',
  find_skill: 'look',
  write: 'edit',
  edit: 'edit',
  multiedit: 'edit',
  apply_patch: 'edit',
  bash: 'run',
  shell: 'run',
  exec_command: 'run',
  bg_run: 'run',
  web_search: 'web',
  web_fetch: 'web',
  websearch: 'web',
  webfetch: 'web',
  browse: 'web',
};

export const toolActivityKind = (name: string): ToolActivityKind => KIND_OF[name.toLowerCase()] ?? 'other';

/**
 * What a stretch did, counted by kind in a fixed order ("read 3 files · ran 1 command"), so a folded line says more than
 * how many steps it holds. Kinds with no call are left out.
 */
export function toolActivityParts(tools: NormalizedToolCall[]): { kind: ToolActivityKind; count: number }[] {
  const counts = new Map<ToolActivityKind, number>();
  for (const item of tools) {
    const kind = toolActivityKind(item.name);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return TOOL_ACTIVITY_KINDS.flatMap((kind) => {
    const count = counts.get(kind);
    return count ? [{ kind, count }] : [];
  });
}

/** The failures of a stretch, one line each. These stay visible while the group is closed. */
export function toolActivityErrors(tools: NormalizedToolCall[]): ToolActivityError[] {
  return tools.flatMap((item) => {
    if (!isFailure(item)) return [];
    const line = toolErrorLine(item);
    return line ? [{ key: item.key, label: toolLabel(item), line }] : [];
  });
}

/** The calls of a stretch the person said no to. They stay visible while the group is closed, as quiet lines. */
export const toolActivityDenied = (tools: NormalizedToolCall[]): { key: string; label: ToolLabel }[] =>
  tools.filter((item) => item.denied).map((item) => ({ key: item.key, label: toolLabel(item) }));

/**
 * Below this a stretch is just its line. A header over a single call is a box more than it is a summary (user,
 * 2026-09-22), and from two calls up the fold is what keeps a long turn readable.
 */
export const ACTIVITY_FOLD_MIN = 2;

/** Whether a stretch of calls is worth folding into one line at all. */
export const shouldFoldActivity = (tools: NormalizedToolCall[]): boolean => tools.length >= ACTIVITY_FOLD_MIN;

// ── clipping long output ────────────────────────────────────────────────────

/** A tool's output opens to at most this much before "show more" takes over. */
export const OUTPUT_CLIP_LINES = 14;
export const OUTPUT_CLIP_CHARS = 1400;

export type ClippedText = { text: string; clipped: boolean };

/** The head of a long output, cut on a line boundary, with whether anything was left out. */
export function clipOutput(
  value: string,
  { lines = OUTPUT_CLIP_LINES, chars = OUTPUT_CLIP_CHARS }: { lines?: number; chars?: number } = {}
): ClippedText {
  const rows = value.split('\n');
  const head = rows.length > lines ? rows.slice(0, lines).join('\n') : value;
  if (head.length <= chars) return { text: head, clipped: head.length < value.length };
  return { text: head.slice(0, chars), clipped: true };
}
