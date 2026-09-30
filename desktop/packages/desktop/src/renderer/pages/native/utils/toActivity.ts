/**
 * A native conversation's view as the Jev panel's activity (`Activity`, what the panel's board, judge and hive tabs
 * read), shaped as the mu bridge's telemetry writes it (process/agent/kyrn/telemetry.ts) so the tabs read it as they
 * read any mu conversation:
 *
 * - every presentation frame and the run's edges, as the view keeps them (`host.activity`), a decision frame with its
 *   ledger record (the view files the record under `judgments`); a judgment no frame carries, as a decision at the time
 *   its record says: a view read from the session file (a reopened conversation) has the ledger and no frames;
 * - what the telemetry makes of pi's records: the latest reply's token counts (`turn.usage`), the session's context
 *   (`context.usage`), a hive's manifest and its latest snapshots (`hive.manifest`, `swarm.snapshot`), and the images
 *   tools gave back (`artifact.image`).
 *
 * What the telemetry reads from files beside a hive run (its notes, deliveries, relations, gates and each bee's
 * transcript) is not in the view: the renderer reads no files, so the hive tab shows the snapshots only.
 */
import type { NativeView, ViewAssistantMessage, ViewToolCall } from '@/common/utils/nativeHost';
import type { Activity } from '@/common/kyrn/types';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The images the panel shows, as the telemetry takes them. */
const IMAGE_TYPE = /^image\/(png|jpeg|webp|gif)$/;
const IMAGE_LIMIT = 8 * 1024 * 1024;

const tools = (message: ViewAssistantMessage): ViewToolCall[] =>
  message.blocks.filter((block): block is ViewToolCall => block.type === 'tool');

/** The model id of `provider/id`, as the telemetry names the context's model. */
const modelId = (model: string | undefined): string => {
  if (!model) return '';
  const slash = model.indexOf('/');
  return slash < 0 ? model : model.slice(slash + 1);
};

function fromTools(message: ViewAssistantMessage): Activity[] {
  const events: Activity[] = [];
  const at = message.timestamp;
  for (const tool of tools(message)) {
    const run = tool.id;
    if (tool.name === 'hive' && typeof tool.args.goal === 'string' && Array.isArray(tool.args.bees) && run.trim())
      events.push({
        id: `hive:${run}`,
        at,
        kind: 'hive.manifest',
        run,
        payload: {
          goal: tool.args.goal.slice(0, 16000),
          bees: tool.args.bees.slice(0, 16).map((bee) => {
            const row = record(bee);
            return { name: text(row.name).slice(0, 160), focus: text(row.focus).slice(0, 16000) };
          }),
        },
      });
    const shown = tool.result ?? tool.partial;
    const snapshot = record(record(shown?.details).snapshot);
    if (['hive', 'delegate'].includes(text(snapshot.kind)))
      events.push({ id: `snapshot:${run}`, at, kind: 'swarm.snapshot', run, payload: snapshot });
    (tool.result?.images ?? []).forEach((image, index) => {
      if (!IMAGE_TYPE.test(image.mimeType) || image.data.length >= IMAGE_LIMIT) return;
      events.push({
        id: `image:${run}:${index}`,
        at,
        kind: 'artifact.image',
        run,
        payload: { type: 'image', data: image.data, mimeType: image.mimeType, toolCallId: run },
      });
    });
  }
  return events;
}

/** The latest reply that read anything: the board's cache ring shows its hit rate. */
function latestUsage(view: NativeView): Activity | undefined {
  for (let index = view.messages.length - 1; index >= 0; index--) {
    const message = view.messages[index];
    if (message.role !== 'assistant' || !message.usage) continue;
    const { input, output, cacheRead, cacheWrite } = message.usage;
    if (input + cacheRead + cacheWrite <= 0) continue;
    return {
      id: `usage:${message.id}`,
      at: message.timestamp,
      kind: 'turn.usage',
      payload: { input, output, cacheRead, cacheWrite },
    };
  }
  return undefined;
}

/** The session's context, as pi last described it. */
function contextUsage(view: NativeView): Activity | undefined {
  const session = view.host.session;
  if (!session) return undefined;
  return {
    id: 'context',
    at: session.at,
    kind: 'context.usage',
    payload: {
      usage: record(session.contextUsage),
      settings: record(session.compactionSettings),
      sessionTokens: record(session.tokens),
      model: modelId(session.model),
      busy: view.status === 'working' || view.status === 'thinking',
      compacting: view.live.compacting,
    },
  };
}

/**
 * The judgments no decision frame of the view carries, as the decisions the telemetry would have written: the frames
 * are live only, the ledger is in the session file. At the time the record says it was made.
 */
function fromLedger(view: NativeView, framed: ReadonlySet<string>): Activity[] {
  const events: Activity[] = [];
  for (const judgment of view.judgments) {
    if (framed.has(judgment.id)) continue;
    const at = Date.parse(text(judgment.record.timestamp));
    events.push({
      id: `judgment:${judgment.id}`,
      at: Number.isFinite(at) ? at : 0,
      kind: 'decision',
      payload: judgment.record,
    });
  }
  return events;
}

/** The panel's activity of one view, in time order. */
export function toActivity(view: NativeView): Activity[] {
  const judgments = new Map(view.judgments.map((judgment) => [judgment.id, judgment.record]));
  const framed = new Set<string>();
  const events: Activity[] = view.host.activity.map((line) => {
    const id = line.kind === 'decision' ? text(line.payload.id) : '';
    if (id) framed.add(id);
    const payload = (id && judgments.get(id)) || line.payload;
    return {
      id: line.id,
      at: line.at,
      kind: line.kind,
      payload,
      ...(line.runtimeId !== undefined ? { runtimeId: line.runtimeId } : {}),
      ...(line.turnId !== undefined ? { turnId: line.turnId } : {}),
      ...(line.sequence !== undefined ? { sequence: line.sequence } : {}),
    };
  });
  events.push(...fromLedger(view, framed));
  for (const message of view.messages) if (message.role === 'assistant') events.push(...fromTools(message));
  const usage = latestUsage(view);
  if (usage) events.push(usage);
  const context = contextUsage(view);
  if (context) events.push(context);
  // Stable: lines of the same time keep the order they came in.
  return events.toSorted((a, b) => a.at - b.at);
}
