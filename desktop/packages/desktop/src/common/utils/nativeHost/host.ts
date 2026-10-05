/**
 * What only a live host says, folded into a view's `host` part (view.ts `ViewHost`) and never into what a session file
 * gives: the judgment layer's presentation frames and the run's edges for the Jev panel (`activity`), what extensions
 * notify (`notices`), pi's queue of steering and follow-up messages, and the session as pi describes it when asked.
 * Also the permission question mu announces before it opens the dialog that asks it.
 *
 * Pure, like the reducer that calls it: no I/O, no clock (a time is the latest one the view has seen), and the view
 * passed in is never changed.
 */
import type { PresentationFrame } from './presentation.ts';
import { asList, asNumber, asObject, asText, hasModel, type JsonObject, type PiRecord } from './records.ts';
import type { NativeView, ViewActivity, ViewHost, ViewNotice, ViewPermission, ViewSession, ViewUsage } from './view.ts';

/** How many lines of activity a view keeps: the oldest go first. */
export const ACTIVITY_LIMIT = 2000;
/** How many notices a view keeps: the oldest go first. */
export const NOTICE_LIMIT = 200;

/** The next id of a list numbered `<prefix>1`, `<prefix>2`, …: one above the highest, so none is ever used twice. */
export function nextNumber(prefix: string, ids: readonly string[]): string {
  let highest = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const number = Number(id.slice(prefix.length));
    if (Number.isSafeInteger(number) && number > highest) highest = number;
  }
  return `${prefix}${highest + 1}`;
}

/** The latest time the view has seen: its last activity's, or its last message's. pi's events carry none. */
export function clockOf(view: NativeView): number {
  let latest = view.host.activity.at(-1)?.at ?? 0;
  for (let index = view.messages.length - 1; index >= 0; index--) {
    const message = view.messages[index];
    if (message.role === 'custom' || message.role === 'compaction') continue;
    latest = Math.max(latest, message.timestamp);
    break;
  }
  return latest;
}

const withHost = (view: NativeView, host: Partial<ViewHost>): NativeView => ({
  ...view,
  host: { ...view.host, ...host },
});

/**
 * Snapshots the panel reads only the latest of: a new one replaces the one before. A board without the running
 * account (`log`) keeps the last one that has it, whose account the panel still shows.
 */
function replaces(next: ViewActivity, old: ViewActivity): boolean {
  if (old.kind !== next.kind) return false;
  if (next.kind === 'context.policy') return true;
  if (next.kind === 'board.update') return Array.isArray(next.payload.log) || !Array.isArray(old.payload.log);
  return false;
}

function addActivity(view: NativeView, line: Omit<ViewActivity, 'id'>): NativeView {
  const activity = view.host.activity;
  const next: ViewActivity = {
    id: nextNumber(
      'a',
      activity.map((each) => each.id)
    ),
    ...line,
  };
  const kept = activity.filter((old) => !replaces(next, old));
  return withHost(view, { activity: [...kept.slice(Math.max(0, kept.length + 1 - ACTIVITY_LIMIT)), next] });
}

/**
 * A presentation frame, as the panel reads it. A `decision` frame keeps only its record's id (the record is the
 * view's judgment); a record without an id is kept whole, without the state the judge was shown.
 */
export function addFrame(view: NativeView, frame: PresentationFrame): NativeView {
  let payload = frame.payload;
  if (frame.kind === 'decision') {
    const { state: _state, ...record } = frame.payload;
    payload = typeof record.id === 'string' && record.id ? { id: record.id } : record;
  }
  const at = frame.at ?? clockOf(view);
  return addActivity(view, { kind: frame.kind, payload, at, ...frame.correlation });
}

/** One of pi's events the panel reads (a run's start and end, a compaction), at the latest time the view has seen. */
export function addRunEvent(view: NativeView, record: PiRecord): NativeView {
  const at = clockOf(view);
  switch (record.type) {
    case 'agent_start':
    case 'agent_settled':
      return addActivity(view, { kind: record.type, payload: {}, at });
    case 'compaction_start':
      return addActivity(view, { kind: 'compaction_start', payload: { reason: asText(record.reason) }, at });
    case 'compaction_end': {
      // As the CLI bridge's telemetry records it (process/agent/kyrn/telemetry.ts): what the context panel reads.
      const result = asObject(record.result);
      const kyrn = asObject(asObject(result.details).kyrn);
      return addActivity(view, {
        kind: 'compaction_end',
        payload: {
          reason: asText(record.reason),
          aborted: record.aborted === true,
          ...(typeof record.errorMessage === 'string' ? { error: record.errorMessage } : {}),
          applied: record.result !== undefined && record.result !== null && record.aborted !== true,
          ...(asNumber(result.tokensBefore) !== undefined ? { tokensBefore: result.tokensBefore } : {}),
          ...(asNumber(result.estimatedTokensAfter) !== undefined ? { tokensAfter: result.estimatedTokensAfter } : {}),
          beta: kyrn.version === 1,
          ...(kyrn.metrics !== undefined ? { metrics: asObject(kyrn.metrics) } : {}),
        },
        at,
      });
    }
    default:
      return view;
  }
}

const NOTICE_LEVELS: ReadonlySet<string> = new Set(['info', 'warning', 'error']);

const lastMessageId = (view: NativeView): string | undefined => view.messages.at(-1)?.id;

function addNotice(view: NativeView, notice: Omit<ViewNotice, 'id' | 'after'>): NativeView {
  const notices = view.host.notices;
  const after = lastMessageId(view);
  const next: ViewNotice = {
    id: nextNumber(
      'n',
      notices.map((each) => each.id)
    ),
    ...notice,
    ...(after ? { after } : {}),
  };
  return withHost(view, { notices: [...notices.slice(Math.max(0, notices.length + 1 - NOTICE_LIMIT)), next] });
}

/**
 * What an extension notified: an answer (`info`) each time it comes, a warning or an error once, as the CLI bridge
 * says them (`KyrnAgent.harnessNotice`). A line a coded notice already carries (mu's `judge.notice` comes first) is not
 * said again.
 */
export function takeNotify(view: NativeView, record: PiRecord): NativeView {
  const text = asText(record.message).trim();
  if (!text) return view;
  const type = asText(record.notifyType);
  const level = NOTICE_LEVELS.has(type) ? (type as ViewNotice['level']) : 'info';
  if (view.host.notices.some((notice) => notice.text === text && (level !== 'info' || notice.code))) return view;
  return addNotice(view, { level, text });
}

/**
 * mu's `checkpoint.off`: the session goes without checkpoints, said once, by its code, so the app words it. mu sends its
 * own line as a warning just before; that line becomes the coded notice where it stands.
 */
export function takeCheckpointOff(view: NativeView, payload: JsonObject): NativeView {
  const notices = view.host.notices;
  if (notices.some((notice) => notice.code === 'checkpoint_off')) return view;
  const text = asText(payload.message).trim();
  const reason = asText(payload.code);
  const params: Record<string, number> = {};
  for (const [name, value] of Object.entries(asObject(payload.params)))
    if (typeof value === 'number' && Number.isFinite(value)) params[name] = value;
  const coded = { code: 'checkpoint_off' as const, ...(reason ? { reason } : {}), params };
  const said = text ? notices.findIndex((notice) => notice.text === text) : -1;
  if (said < 0) return addNotice(view, { level: 'warning', text, ...coded });
  const next = notices.slice();
  next[said] = { ...notices[said], level: 'warning', ...coded };
  return withHost(view, { notices: next });
}

/**
 * mu's `judge.notice`: the judge answers with the free Jev on OpenCode Zen (`free_jev`), or the free Jev stopped
 * (`free_jev_unavailable`, with `paid` or `gone`), said once each, by code, so the app words it. mu sends its own line
 * with `notify` right after (`takeNotify` drops it); a line already said becomes the coded notice where it stands. A
 * code this build does not know leaves mu's line to say it.
 */
export function takeJudgeNotice(view: NativeView, payload: JsonObject): NativeView {
  const named = asText(payload.code);
  const code = named === 'free_jev' || named === 'free_jev_unavailable' ? named : undefined;
  if (!code) return view;
  const notices = view.host.notices;
  if (notices.some((notice) => notice.code === code)) return view;
  const text = asText(payload.message).trim();
  const reason = asText(payload.reason);
  const coded: Pick<ViewNotice, 'level' | 'code' | 'reason'> = {
    level: code === 'free_jev' ? 'info' : 'warning',
    code,
    ...(reason ? { reason } : {}),
  };
  const said = text ? notices.findIndex((notice) => notice.text === text) : -1;
  if (said < 0) return addNotice(view, { text, ...coded });
  const next = notices.slice();
  next[said] = { ...notices[said], ...coded };
  return withHost(view, { notices: next });
}

/** pi's queue as it stands (`queue_update`, which carries both lists whole). */
export function takeQueue(view: NativeView, record: PiRecord): NativeView {
  const list = (value: unknown): string[] => asList(value).map(asText);
  return withHost(view, { queue: { steering: list(record.steering), followUp: list(record.followUp) } });
}

const modelName = (model: unknown): string | undefined => {
  const { provider, id } = asObject(model);
  return hasModel(model) ? `${asText(provider)}/${asText(id)}` : undefined;
};

/** The session with `change`, at the latest time the view has seen. A field `change` names as undefined is dropped. */
function updateSession(view: NativeView, change: Partial<Omit<ViewSession, 'at'>>): NativeView {
  const merged: Record<string, unknown> = { ...view.host.session, ...change, at: clockOf(view) };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return withHost(view, { session: merged as ViewSession });
}

/**
 * The answers that describe the session, whoever asked: `get_state`, `get_session_stats`, `set_model`,
 * `cycle_model`. A failed answer says nothing about it.
 */
export function takeResponse(view: NativeView, record: PiRecord): NativeView {
  if (record.success !== true) return view;
  const data = asObject(record.data);
  switch (record.command) {
    case 'get_state':
      // A state without a usable model says pi has none now: the one it had before is gone.
      return updateSession(view, {
        model: modelName(data.model),
        ...(typeof data.thinkingLevel === 'string' ? { thinkingLevel: data.thinkingLevel } : {}),
        ...(typeof data.sessionName === 'string' ? { name: data.sessionName } : {}),
        ...(data.contextUsage !== undefined ? { contextUsage: asObject(data.contextUsage) } : {}),
        ...(data.compactionSettings !== undefined ? { compactionSettings: asObject(data.compactionSettings) } : {}),
        ...(typeof data.autoCompactionEnabled === 'boolean' ? { autoCompaction: data.autoCompactionEnabled } : {}),
      });
    case 'get_session_stats':
      return updateSession(view, {
        ...(data.tokens !== undefined ? { tokens: asObject(data.tokens) } : {}),
        ...(asNumber(data.cost) !== undefined ? { cost: asNumber(data.cost) } : {}),
        ...(data.contextUsage !== undefined ? { contextUsage: asObject(data.contextUsage) } : {}),
      });
    case 'set_model': {
      const model = modelName(data);
      return model ? updateSession(view, { model }) : view;
    }
    case 'cycle_model': {
      const model = modelName(data.model);
      return model
        ? updateSession(view, {
            model,
            ...(typeof data.thinkingLevel === 'string' ? { thinkingLevel: data.thinkingLevel } : {}),
          })
        : view;
    }
    default:
      return view;
  }
}

/** pi's own events about the session: its name, its thinking level. */
export function takeSessionEvent(view: NativeView, record: PiRecord): NativeView {
  if (record.type === 'session_info_changed')
    return updateSession(view, typeof record.name === 'string' ? { name: record.name } : { name: undefined });
  if (record.type === 'thinking_level_changed' && typeof record.level === 'string')
    return updateSession(view, { thinkingLevel: record.level });
  return view;
}

/** Codes are lowercase words joined by underscores; anything else is not one. */
const CODE = /^[a-z][a-z_]{0,47}$/;
const code = (value: unknown): string | undefined =>
  typeof value === 'string' && CODE.test(value) ? value : undefined;
/** A tool call's id is the provider's own: any short line of text. */
const callId = (value: unknown): string | undefined =>
  typeof value === 'string' && value && value.length <= 256 && !/[\r\n]/.test(value) ? value : undefined;

/**
 * mu's `permissions.request`, as the CLI bridge reads it (process/agent/kyrn/permissions.ts `readRequest`): none
 * without at least two answers. Ids count only as a full, distinct set in the answers' order.
 */
export function readPermission(payload: JsonObject): ViewPermission | undefined {
  const answers = asList(payload.answers).map(asText);
  if (answers.length < 2 || answers.some((answer) => !answer)) return undefined;
  const ids = asList(payload.answerIds).map(code);
  const answerIds =
    ids.length === answers.length && ids.every(Boolean) && new Set(ids).size === ids.length
      ? (ids as string[])
      : undefined;
  const reason = code(payload.reason);
  const flagCode = code(payload.flagCode);
  const grantLabel = asText(asObject(payload.grant).label);
  const toolCallId = callId(payload.toolCallId);
  return {
    kind: asText(payload.kind),
    summary: asText(payload.summary),
    answers,
    ...(answerIds ? { answerIds } : {}),
    ...(reason ? { reason } : {}),
    ...(flagCode ? { flagCode } : {}),
    ...(grantLabel ? { grantLabel } : {}),
    ...(toolCallId ? { toolCallId } : {}),
  };
}

/** A reply's token counts, when pi counted all four. */
export function usageOf(value: unknown): ViewUsage | undefined {
  const usage = asObject(value);
  const count = (name: string): number | undefined => {
    const number = asNumber(usage[name]);
    return number !== undefined && number >= 0 ? number : undefined;
  };
  const input = count('input');
  const output = count('output');
  const cacheRead = count('cacheRead');
  const cacheWrite = count('cacheWrite');
  return input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined
    ? undefined
    : { input, output, cacheRead, cacheWrite };
}
