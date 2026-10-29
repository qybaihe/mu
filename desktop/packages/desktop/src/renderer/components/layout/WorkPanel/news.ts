import { isBeeActive, parseSwarmSnapshot, type HiveBeeStatus } from '@/common/kyrn/hive';
import type { Activity } from '@/common/kyrn/types';
import { boardView } from '@/renderer/pages/conversation/KyrnPanel/Board/board';
import { judgeCards } from '@/renderer/pages/conversation/KyrnPanel/Judge/activity';
import { memoryEvents } from '@/renderer/pages/conversation/KyrnPanel/Lessons/model';

/**
 * What counts as news in each tab, read from what the tab shows. A signature changes only when the person would
 * see something new there, so a session reread from the start (a conversation opened again) gives the same one.
 */

/**
 * The board's words: a new board is news; the one replayed as the session opens repeats the last. A new headline or a
 * new blocked line is news too (a long run's "6 min" becoming "7 min" included).
 */
export function boardSignature(events: readonly Activity[]): string {
  const update = boardView(events).update;
  return update
    ? JSON.stringify([
        update.phase ?? '',
        update.now,
        update.progress,
        update.confirm,
        update.headline ?? '',
        update.blocked ?? '',
      ])
    : '';
}

/** The latest verdict on a message. The wait before it is not news; the verdict is. */
export function judgeSignature(events: Activity[]): string {
  const card = judgeCards(events).find((item) => item.stage === 'preflight' && item.state !== 'pending');
  return card ? JSON.stringify([card.id, card.state]) : '';
}

/** A lesson stored, brought into a turn, followed, retired or merged into another: each one is news. */
export function lessonsSignature(events: readonly Activity[]): string {
  return memoryEvents(events)
    .map((event) => event.id)
    .join('\n');
}

/** Coarse on purpose: a sub-agent moving between thinking and a tool is not news; starting, ending or failing is. */
const phase = (status: HiveBeeStatus): string =>
  isBeeActive(status)
    ? 'running'
    : status === 'failed' || status === 'timed-out'
      ? 'failed'
      : status === 'unknown'
        ? ''
        : status;

/** Which sub-agents there are and where each one is: a new run, one that started, finished or failed. */
export function hiveSignature(events: readonly Activity[]): string {
  const rows: string[] = [];
  for (const event of events) {
    if (event.kind === 'hive.manifest' && event.run) rows.push(JSON.stringify([event.run]));
    if (event.kind !== 'swarm.snapshot') continue;
    const snapshot = parseSwarmSnapshot(event.payload);
    for (const bee of snapshot?.bees ?? []) rows.push(JSON.stringify([event.run ?? '', bee.name, phase(bee.status)]));
  }
  return rows.join('\n');
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Tool calls followed at once; the oldest are forgotten first, so a long session does not grow this. */
const FOLLOWED = 500;

const remember = <T>(map: Map<string, T>, key: string, value: T): void => {
  map.delete(key);
  map.set(key, value);
  if (map.size > FOLLOWED) map.delete(map.keys().next().value as string);
};

/** A file edit the agent finished, and the file it changed when the stream names it. */
export type FinishedEdit = { path?: string };

/** The file an ACP tool call names: its first location, or the path of a diff it shows. */
const acpPath = (update: Record<string, unknown>): string | undefined => {
  const location = Array.isArray(update.locations) ? record(update.locations[0]) : {};
  if (str(location.path)) return str(location.path);
  const diff = Array.isArray(update.content)
    ? update.content.map(record).find((item) => item.type === 'diff')
    : undefined;
  return str(diff?.path) || undefined;
};

/**
 * A reader of the response stream that says when a file edit finished, and which file when it can tell. An ACP tool
 * call names its kind and its file only when it starts; its later updates carry the status alone, so both are kept by
 * call id until the call completes. A Gemini-style tool group reports an edit as a finished call with a diff to show.
 */
export function createEditWatcher(): (message: { type: string; data: unknown }) => FinishedEdit | undefined {
  const calls = new Map<string, { kind?: string; path?: string }>();
  const counted = new Map<string, true>();
  return (message) => {
    if (message.type === 'acp_tool_call') {
      const update = record(record(message.data).update);
      const id = str(update.tool_call_id) || str(update.toolCallId);
      if (!id) return undefined;
      const known = calls.get(id) ?? {};
      const call = { kind: str(update.kind) || known.kind, path: acpPath(update) ?? known.path };
      if (call.kind || call.path) remember(calls, id, call);
      if (update.status !== 'completed') return undefined;
      calls.delete(id);
      const diff = Array.isArray(update.content) && update.content.some((item) => record(item).type === 'diff');
      if (call.kind !== 'edit' && !diff) return undefined;
      return call.path ? { path: call.path } : {};
    }
    if (message.type !== 'tool_group' || !Array.isArray(message.data)) return undefined;
    let edited: FinishedEdit | undefined;
    for (const item of message.data) {
      const tool = record(item);
      const id = str(tool.call_id);
      if (!id || counted.has(id) || tool.status !== 'Success') continue;
      if (typeof record(tool.result_display).file_diff !== 'string') continue;
      remember(counted, id, true);
      // Such a call names its file by name only, which says nothing of the folder.
      edited = {};
    }
    return edited;
  };
}
