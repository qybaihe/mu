/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The changed-files notes a finished team run leaves in the group chat: which
 * files the round's write/edit calls touched, one light row per run. The runs
 * write their tool calls into each member conversation's stored rows, so the
 * controller reads those rows back when `team.runCompleted` arrives — the run
 * event itself carries no file list — and the note is what survives a reload
 * (the aggregation window, a live run's start time, is process-local and
 * honestly degrades when it was never seen). Notes live in localStorage for
 * the same reason the ⚡ receipts do: the group chat's own backend
 * conversation is untouched by design.
 */
import { useSyncExternalStore } from 'react';
import type { TMessage } from '@/common/chat/chatLib';

/** One file the round touched, with the first and last write that hit it. */
export type ChangedFileEntry = { path: string; firstAt: number; lastAt: number };

/** One finished run's note, as the group chat's flow shows it. */
export type TeamChangedFilesNote = {
  id: string;
  /** The lead conversation (the group chat) whose flow merges this row. */
  conversationId: string;
  teamId: string;
  teamRunId: string;
  createdAt: number;
  files: { path: string; name: string }[];
};

const STORAGE_KEY = 'team-changed-files-notes-v1';
/** How many notes survive; the conversations' histories are the archive. */
const NOTES_CAP = 200;
/** How many files one note lists; a run that touched more keeps the first ones. */
const NOTE_FILES_CAP = 50;
/** Writes may be persisted a beat after the run event; give the read this much room. */
export const AGGREGATE_DELAY_MS = 1200;
/** The run's start time is process-local; allow skew between agent and wall clock. */
export const START_SLACK_MS = 2000;
/** How many run starts stay tracked, so a long session cannot grow the map forever. */
const MAX_TRACKED_RUNS = 50;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const isTMessage = (row: unknown): row is TMessage => {
  const candidate = record(row);
  return candidate.type === 'acp_tool_call' && typeof candidate.id === 'string';
};

/** The file path a write/edit call names: its input's `path`, else its recorded location. */
const writePathOf = (update: Record<string, unknown>): string | undefined => {
  const input = record(update.raw_input ?? update.rawInput);
  if (typeof input.path === 'string' && input.path) return input.path;
  const locations = update.locations;
  if (Array.isArray(locations) && locations.length > 0) {
    const first = record(locations[0]);
    if (typeof first.path === 'string' && first.path) return first.path;
  }
  return undefined;
};

/** One path as the note dedupes it: separators fold, so `a/b` and `a\b` are one file. */
const dedupeKeyOf = (path: string): string => path.replace(/\\/g, '/');

/** The file's name as the note shows it. */
export const fileNameOf = (path: string): string => path.replace(/\\/g, '/').split('/').pop() || path;

/**
 * The files the finished write/edit calls in `rows` touched between `sinceMs`
 * and `untilMs` (exclusive of nothing at the top end when omitted). Reads are
 * never counted, failed writes never are, and one path touched twice reads as
 * one entry spanning its first and last write. Rows that are not stored
 * tool-call messages are ignored, not rejected: a conversation's page mixes
 * every row type.
 */
export const changedFileRowsFrom = (
  rows: readonly unknown[],
  sinceMs: number,
  untilMs: number = Number.MAX_SAFE_INTEGER
): ChangedFileEntry[] => {
  const byPath = new Map<string, ChangedFileEntry>();
  for (const row of rows) {
    if (!isTMessage(row)) continue;
    const update = record(record(row.content).update);
    if (update.title !== 'write' && update.title !== 'edit') continue;
    if (update.status !== 'completed') continue;
    const at = row.created_at;
    if (typeof at !== 'number' || at < sinceMs || at > untilMs) continue;
    const path = writePathOf(update);
    if (path === undefined) continue;
    const key = dedupeKeyOf(path);
    const known = byPath.get(key);
    if (known === undefined) byPath.set(key, { path, firstAt: at, lastAt: at });
    else known.lastAt = Math.max(known.lastAt, at);
  }
  return [...byPath.values()];
};

// --- the note store (localStorage, the ⚡ notes' sibling) ---

const listeners = new Set<() => void>();
let cache: TeamChangedFilesNote[] | undefined;
const snapshots = new Map<string, TeamChangedFilesNote[]>();

const loadAll = (): TeamChangedFilesNote[] => {
  if (cache !== undefined) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed)
      ? (parsed.filter((item) => record(item).conversationId !== undefined) as TeamChangedFilesNote[])
      : [];
  } catch {
    cache = [];
  }
  return cache;
};

const persist = (notes: TeamChangedFilesNote[]): void => {
  cache = notes;
  snapshots.clear();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  } catch {
    // A full or blocked localStorage keeps the notes for this session only.
  }
  for (const listener of listeners) listener();
};

/** Records one finished run's files. The controller calls this; tests may too. */
export const appendTeamChangedFilesNote = (note: TeamChangedFilesNote): void => {
  persist([...loadAll(), note].slice(-NOTES_CAP));
};

/** The notes of one conversation, oldest first — the shape the message list merges. */
export const teamChangedFileNotesOf = (conversationId: string): TeamChangedFilesNote[] => {
  const memoized = snapshots.get(conversationId);
  if (memoized !== undefined) return memoized;
  const notes = loadAll().filter((note) => note.conversationId === conversationId);
  snapshots.set(conversationId, notes);
  return notes;
};

/** When the team's latest note landed: the fallback window start when a run's own start was never seen. */
export const lastChangedFilesNoteAtOf = (teamId: string): number | undefined => {
  let latest: number | undefined;
  for (const note of loadAll()) if (note.teamId === teamId) latest = Math.max(latest ?? 0, note.createdAt);
  return latest;
};

const NO_NOTES: TeamChangedFilesNote[] = [];

/** React binding: the notes of one conversation, re-rendered on append. */
export const useTeamChangedFileNotes = (conversationId: string | undefined): TeamChangedFilesNote[] => {
  const getSnapshot = () => (conversationId === undefined ? NO_NOTES : teamChangedFileNotesOf(conversationId));
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    getSnapshot,
    getSnapshot
  );
};

/** Test seam: drop the store and the memoized snapshots, as a reload would. */
export const resetTeamChangedFileNotesForTest = (): void => {
  cache = undefined;
  snapshots.clear();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // absent storage is already the empty store
  }
  for (const listener of listeners) listener();
};

// --- the run controller: run events in, one note per finished run out ---

/** What the controller needs of a `team.run*` event. */
export type ChangedFilesRunEvent = { team_id: string; team_run_id: string };

/** The team's conversations as the aggregation needs them: the lead's and every member's. */
export type ChangedFilesTeamShape = { leadConversationId: string; conversationIds: string[] };

export type ChangedFilesControllerDeps = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The stored rows of one conversation, newest last; a failed read counts as none. */
  loadRows: (conversationId: string) => Promise<readonly unknown[]>;
  teamConversationsOf: (teamId: string) => Promise<ChangedFilesTeamShape | undefined>;
  appendNote: (note: TeamChangedFilesNote) => void;
  lastNoteAtOf: (teamId: string) => number | undefined;
};

let nextNoteId = 0;

/**
 * Turns team run events into changed-files notes. Start times are remembered
 * from `runAccepted`/`runStarted` (either may be the first event seen); a run
 * whose start was never seen — the app reloaded mid-run — falls back to the
 * team's latest note's time, and a team with neither gets no note rather than
 * a guess at a window. One note per run, whatever events replay.
 */
export const createTeamChangedFilesController = (deps: ChangedFilesControllerDeps) => {
  const runStarts = new Map<string, number>();
  const processedRuns = new Set<string>();

  const rememberStart = (event: ChangedFilesRunEvent): void => {
    if (!event?.team_id || !event?.team_run_id) return;
    runStarts.set(event.team_run_id, deps.now());
    if (runStarts.size > MAX_TRACKED_RUNS) {
      const oldest = runStarts.keys().next().value;
      if (typeof oldest === 'string') runStarts.delete(oldest);
    }
  };

  const aggregate = async (teamId: string, runId: string, startMs: number): Promise<void> => {
    await deps.sleep(AGGREGATE_DELAY_MS);
    const team = await deps.teamConversationsOf(teamId);
    if (team === undefined) return;
    const until = deps.now();
    const pages = await Promise.all(
      team.conversationIds.map((id) => deps.loadRows(id).catch((): readonly unknown[] => []))
    );
    const entries = changedFileRowsFrom(pages.flat(), startMs - START_SLACK_MS, until);
    if (entries.length === 0) return;
    entries.sort((a, b) => a.firstAt - b.firstAt);
    deps.appendNote({
      id: `tcf-${deps.now()}-${nextNoteId++}`,
      conversationId: team.leadConversationId,
      teamId,
      teamRunId: runId,
      createdAt: deps.now(),
      files: entries.slice(0, NOTE_FILES_CAP).map((entry) => ({ path: entry.path, name: fileNameOf(entry.path) })),
    });
  };

  return {
    onRunAccepted: rememberStart,
    onRunStarted: rememberStart,
    onRunCompleted: (event: ChangedFilesRunEvent): void => {
      if (!event?.team_id || !event?.team_run_id) return;
      if (processedRuns.has(event.team_run_id)) return;
      processedRuns.add(event.team_run_id);
      const seen = runStarts.get(event.team_run_id);
      const startMs = seen ?? deps.lastNoteAtOf(event.team_id);
      if (startMs === undefined) return;
      void aggregate(event.team_id, event.team_run_id, startMs);
    },
  };
};
