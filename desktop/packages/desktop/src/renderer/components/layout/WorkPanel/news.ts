import { isBeeActive, parseSwarmSnapshot, type HiveBeeStatus } from '@/common/kyrn/hive';
import type { Activity } from '@/common/kyrn/types';
import { boardView } from '@/renderer/pages/conversation/KyrnPanel/Board/board';
import { judgeCards } from '@/renderer/pages/conversation/KyrnPanel/Judge/activity';
import { memoryEvents } from '@/renderer/pages/conversation/KyrnPanel/Lessons/model';

/**
 * What counts as news in each tab, read from what the tab shows. A signature changes only when the person would
 * see something new there, so a session reread from the start (a conversation opened again) gives the same one.
 */

/** The board's words: a new board is news; the one replayed as the session opens repeats the last. */
export function boardSignature(events: readonly Activity[]): string {
  const update = boardView(events).update;
  return update ? JSON.stringify([update.phase ?? '', update.now, update.progress, update.confirm]) : '';
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

/**
 * A reader of the response stream that says when a file edit finished. An ACP tool call names its kind only when it
 * starts; its later updates carry the status alone, so the kind is kept by call id until the call completes. A
 * Gemini-style tool group reports an edit as a finished call with a diff to show.
 */
export function createEditWatcher(): (message: { type: string; data: unknown }) => boolean {
  const kinds = new Map<string, string>();
  const counted = new Map<string, true>();
  return (message) => {
    if (message.type === 'acp_tool_call') {
      const update = record(record(message.data).update);
      const id = str(update.tool_call_id) || str(update.toolCallId);
      if (!id) return false;
      if (str(update.kind)) remember(kinds, id, str(update.kind));
      if (update.status !== 'completed') return false;
      const kind = kinds.get(id);
      kinds.delete(id);
      const diff = Array.isArray(update.content) && update.content.some((item) => record(item).type === 'diff');
      return kind === 'edit' || diff;
    }
    if (message.type !== 'tool_group' || !Array.isArray(message.data)) return false;
    let edited = false;
    for (const item of message.data) {
      const tool = record(item);
      const id = str(tool.call_id);
      if (!id || counted.has(id) || tool.status !== 'Success') continue;
      if (typeof record(tool.result_display).file_diff !== 'string') continue;
      remember(counted, id, true);
      edited = true;
    }
    return edited;
  };
}
