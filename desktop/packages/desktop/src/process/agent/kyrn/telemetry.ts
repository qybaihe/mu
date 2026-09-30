import {
  appendFileSync,
  closeSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { THINKING_LEVELS, type ModelThinkingLevels, type ThinkingLevel } from '../../../common/kyrn/models';
import type { Activity, ActivityPage } from '../../../common/kyrn/types';
import { readPresentation } from '../../../common/utils/nativeHost/presentation.ts';
import { array, asRecord, text, type JsonRecord } from './piRpc';

const MAX_PAGE = 16 * 1024 * 1024;
export function readPage(path: string, cursor: number): { rows: JsonRecord[]; cursor: number; more: boolean } {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { rows: [], cursor: 0, more: false };
    throw e;
  }
  try {
    const size = statSync(path).size;
    const start = cursor > size ? 0 : cursor;
    const buffer = Buffer.alloc(Math.min(MAX_PAGE, Math.max(0, size - start)));
    const bytes = readSync(fd, buffer, 0, buffer.length, start);
    const end = buffer.subarray(0, bytes).lastIndexOf(10) + 1;
    if (!end && bytes === MAX_PAGE) throw new Error('Activity record exceeds the page limit');
    const rows = buffer
      .subarray(0, end)
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [asRecord(JSON.parse(line))];
        } catch {
          return [];
        }
      });
    return { rows, cursor: start + end, more: start + end < size && end > 0 };
  } finally {
    closeSync(fd);
  }
}

const SESSION_ID = /^[a-f\d-]{36}$/;

/**
 * One page of a session's activity. With `kinds`, only events of those kinds come back; the cursor still moves past
 * every row, so a reader that follows one kind (the send box and `goal.state`) never ships the rest to the renderer.
 */
export function activityPage(
  store: string,
  sessionId: string,
  cursor: number,
  kinds?: readonly string[]
): ActivityPage {
  if (!SESSION_ID.test(sessionId) || !Number.isSafeInteger(cursor) || cursor < 0)
    throw new Error('Invalid activity cursor');
  const page = readPage(join(store, `${sessionId}.events.jsonl`), cursor);
  const rows = page.rows as Activity[];
  const events = kinds ? rows.filter((event) => kinds.includes(event.kind)) : rows;
  return { sessionId, cursor: page.cursor, more: page.more, events };
}

const LEVELS: ReadonlySet<string> = new Set(THINKING_LEVELS);
const modelsPath = (store: string, sessionId: string): string => join(store, `${sessionId}.models.json`);

/**
 * The thinking levels each model of a session takes, as the adapter last recorded them (`Telemetry.levels`), keyed
 * `provider/model-id`. Empty when nothing was recorded: another agent, or a session from before the record.
 */
export function modelLevels(store: string, sessionId: string): ModelThinkingLevels {
  if (!SESSION_ID.test(sessionId)) throw new Error('Invalid session');
  let raw: string;
  try {
    raw = readFileSync(modelsPath(store, sessionId), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  let stored: JsonRecord;
  try {
    stored = asRecord(JSON.parse(raw));
  } catch {
    return {};
  }
  const levels: ModelThinkingLevels = {};
  for (const [model, value] of Object.entries(asRecord(stored.levels))) {
    const known = array(value).filter(
      (level): level is ThinkingLevel => typeof level === 'string' && LEVELS.has(level)
    );
    if (model.includes('/') && known.length) levels[model] = known;
  }
  return levels;
}

/** One durable, presentation-only stream. It is never appended to the model context. */
export class Telemetry {
  private path: string;
  private modelsPath: string;
  private offsets = new Map<string, number>();
  private lastContext = '';
  private lastLevels = '';
  /**
   * The harness said itself which lessons it brought into a turn (a `memory.recalled` frame, sent before the message
   * that carries them). From then on the record is not made again from that message, which would repeat it.
   */
  private presentsRecall = false;
  constructor(store: string, sessionId: string) {
    this.path = join(store, `${sessionId}.events.jsonl`);
    this.modelsPath = modelsPath(store, sessionId);
  }
  private append(
    kind: string,
    payload: JsonRecord,
    run?: string,
    bee?: string,
    correlation?: Pick<Activity, 'runtimeId' | 'turnId' | 'sequence'>
  ): void {
    const event: Activity = { id: randomUUID(), at: Date.now(), kind, payload, run, bee, ...correlation };
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }
  context(state: JsonRecord): void {
    // Only presentation data; never persist credentials, full settings or prompts.
    const payload = {
      usage: asRecord(state.contextUsage),
      settings: asRecord(state.compactionSettings),
      sessionTokens: asRecord(state.sessionTokens),
      model: text(asRecord(state.model).id),
      busy: state.isStreaming === true,
      compacting: state.isCompacting === true,
    };
    const key = JSON.stringify(payload);
    if (key === this.lastContext) return;
    try {
      this.append('context.usage', payload);
      this.lastContext = key;
    } catch {
      /* Observability cannot fail a turn. */
    }
  }
  /**
   * The thinking levels each model the session can switch to takes, for the send box's picker (`modelLevels`). A
   * record beside the activity, not an event in it: it is replaced, never appended, and written only when it changed.
   */
  levels(levels: ModelThinkingLevels): void {
    const key = JSON.stringify(levels);
    if (key === this.lastLevels) return;
    try {
      writeFileSync(`${this.modelsPath}.tmp`, JSON.stringify({ version: 1, levels }), { mode: 0o600 });
      renameSync(`${this.modelsPath}.tmp`, this.modelsPath);
      this.lastLevels = key;
    } catch {
      /* The picker then offers models without their levels; a turn never fails over it. */
    }
  }
  /**
   * What one reply of the model read and wrote, as pi counts it (`input` is what the cache did not hold): the board's
   * cache ring shows the hit rate of the latest one. Counts only, never content. A reply that failed before the model
   * read anything has nothing to count.
   */
  private turnUsage(value: unknown): void {
    const usage = asRecord(value);
    const count = (name: string): number | undefined => {
      const n = usage[name];
      return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
    };
    const input = count('input');
    const output = count('output');
    const cacheRead = count('cacheRead');
    const cacheWrite = count('cacheWrite');
    if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return;
    if (input + cacheRead + cacheWrite <= 0) return;
    this.append('turn.usage', { input, output, cacheRead, cacheWrite });
  }
  private ingest(path: string, kind: string, run: string, bee?: string): void {
    try {
      if (dirname(realpathSync(path)) !== realpathSync(dirname(path))) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let more: boolean;
    do {
      const page = readPage(path, this.offsets.get(path) ?? 0);
      this.offsets.set(path, page.cursor);
      more = page.more;
      for (const row of page.rows) {
        this.append(kind, row, run, bee);
        const message = asRecord(row.message);
        if (row.type === 'message_end' && message.role === 'toolResult') this.images(message.content, run, bee);
      }
    } while (more);
  }
  private images(content: unknown, run: string, bee?: string): void {
    for (const block of array(content).map(asRecord)) {
      if (
        block.type === 'image' &&
        /^image\/(png|jpeg|webp|gif)$/.test(text(block.mimeType)) &&
        text(block.data).length < 8 * 1024 * 1024
      )
        this.append(
          'artifact.image',
          { type: 'image', data: block.data, mimeType: block.mimeType, toolCallId: run },
          run,
          bee
        );
    }
  }
  capture(event: JsonRecord): void {
    try {
      const frame = readPresentation(event);
      if (frame?.version === 1) {
        this.append(frame.kind, frame.payload, undefined, undefined, frame.correlation);
        if (frame.kind === 'memory.recalled') this.presentsRecall = true;
      }
      if (['agent_start', 'agent_settled', 'kyrn_rpc_closed'].includes(text(event.type)))
        this.append(text(event.type), {});
      if (event.type === 'compaction_start') this.append('compaction_start', { reason: event.reason });
      if (event.type === 'compaction_end') {
        const result = asRecord(event.result);
        this.append('compaction_end', {
          reason: event.reason,
          aborted: event.aborted,
          error: event.errorMessage,
          applied: Boolean(event.result) && !event.aborted,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.estimatedTokensAfter,
          beta: asRecord(asRecord(result.details).kyrn).version === 1,
          metrics: asRecord(asRecord(result.details).kyrn).metrics,
        });
      }
      if (event.type === 'message_end') {
        const message = asRecord(event.message);
        if (message.role === 'assistant') this.turnUsage(message.usage);
        if (message.customType === 'kyrn.lessons' && !this.presentsRecall)
          this.append('memory.recalled', { content: message.content });
      }
      if (event.type === 'tool_execution_start' && event.toolName === 'hive') {
        const run = text(event.toolCallId);
        const args = asRecord(event.args);
        if (run.trim() && typeof args.goal === 'string' && Array.isArray(args.bees))
          this.append(
            'hive.manifest',
            {
              goal: args.goal.slice(0, 16000),
              bees: args.bees.slice(0, 16).map((bee) => {
                const row = asRecord(bee);
                return { name: text(row.name).slice(0, 160), focus: text(row.focus).slice(0, 16000) };
              }),
            },
            run
          );
      }
      if (!['tool_execution_update', 'tool_execution_end'].includes(text(event.type))) return;
      const result = asRecord(event.result ?? event.partialResult);
      const snapshot = asRecord(asRecord(result.details).snapshot);
      const run = text(event.toolCallId);
      if (['hive', 'delegate'].includes(text(snapshot.kind))) {
        this.append('swarm.snapshot', snapshot, run);
        // Only known mu temp run directories (still named kyrn-*) are eligible; never follow a tool-supplied arbitrary path.
        const dir = realpathSync(text(snapshot.dir));
        if (dirname(dir) !== realpathSync(tmpdir()) || !/^kyrn-(hive|swarm|delegate)-[\w-]+$/.test(basename(dir)))
          return;
        for (const [name, kind] of [
          ['board.jsonl', 'hive.note'],
          ['deliveries.jsonl', 'hive.delivery'],
          ['relations.jsonl', 'hive.relation'],
          ['gate.jsonl', 'hive.gate'],
        ])
          this.ingest(join(dir, name), kind, run);
        for (const bee of array(snapshot.bees).map(asRecord)) {
          if (!bee.transcript) continue;
          try {
            const path = realpathSync(text(bee.transcript));
            if (dirname(path) === join(dir, 'transcripts')) this.ingest(path, 'bee.event', run, text(bee.name));
          } catch {
            /* A queued bee has no transcript yet; keep reading the other bees. */
          }
        }
      }
      if (event.type === 'tool_execution_end') this.images(result.content, run);
    } catch {
      /* Observability must never block or fail a model turn. */
    }
  }
}
