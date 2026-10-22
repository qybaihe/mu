import type { TFunction } from 'i18next';
import type { Activity } from '@/common/kyrn/types';
import { formatNumber } from '@/renderer/services/i18n/format';
import { fallbackKind, isTurnType, judgeName } from '@/renderer/pages/conversation/Messages/acp/judgeLine';
import { record, str } from '../activity';
import { judgeCards, LESSON_FIELDS, runtimeEvents, type JudgeCard } from './activity';
import { eventLines } from './eventLine';

/**
 * The judge tab as a log: one line per judgment and per runtime event, oldest first, so the newest is at the bottom
 * where the eye follows it. A judgment is one line however many records it took (a preflight's wait, verdict and
 * ledger entry fold into one), and each line says what happened in a short sentence of the app language. The same
 * line many times over in a row is one line with a count (`foldRepeats`).
 */

export type LogItem =
  | { type: 'judgment'; id: string; at: number; card: JudgeCard }
  /** `about`: for an answer to a permission question, the call the question named (its `summary`). */
  | { type: 'event'; id: string; at: number; event: Activity; about?: string };

/**
 * Kinds another tab shows (the board, and the cache ring above it), or the context line above the log: the log leaves
 * them out.
 */
const SHOWN_ELSEWHERE = new Set(['board.update', 'board.note', 'context.usage', 'context.policy', 'turn.usage']);

/** A harness frame is known by its runtime and its number there; a record the app made, by its own id. */
const identity = (event: Activity): string =>
  event.runtimeId && event.sequence !== undefined ? JSON.stringify([event.runtimeId, event.sequence]) : event.id;

type StateReport = { about: string; state: string };

/**
 * Reports of how things stand. The harness sends each one whenever it starts, which is every time the conversation
 * is opened, and again when the state changes. A server's start and its failures report one state: running with
 * these tools, or failed for this reason. The task frame comes back as `restored` at every start: only a frame that
 * reads differently is an update.
 */
const STATE_REPORTS: Readonly<Record<string, (payload: Record<string, unknown>) => StateReport>> = {
  'frame.updated': (payload) => ({
    about: 'frame',
    state: JSON.stringify([payload.frame, payload.openQuestionCodes, payload.stale, payload.unmerged]),
  }),
  'permissions.mode': (payload) => ({ about: 'permissions', state: str(payload.mode) || str(payload.label) }),
  'board.switched': (payload) => ({ about: 'board', state: String(payload.on) }),
  'inherit.found': (payload) => ({
    about: 'inherit',
    state: JSON.stringify([payload.rules, payload.skills, payload.servers, payload.problems]),
  }),
  'mcp.started': (payload) => ({
    about: `mcp:${str(payload.id) || str(payload.name)}`,
    state: JSON.stringify(['started', payload.tools ?? null]),
  }),
  'mcp.failed': (payload) => ({
    about: `mcp:${str(payload.id) || str(payload.name)}`,
    state: JSON.stringify(['failed', str(payload.code) || str(payload.reason)]),
  }),
};

/** A state report whose state is the one last reported about the same thing tells nothing new. */
function changes(events: readonly Activity[]): Activity[] {
  const states = new Map<string, string>();
  return events.filter((event) => {
    const report = STATE_REPORTS[event.kind]?.(event.payload);
    if (!report) return true;
    if (states.get(report.about) === report.state) return false;
    states.set(report.about, report.state);
    return true;
  });
}

/**
 * Each record once, and a state report only when it changed something: reopening a conversation adds no lines, and
 * a switch still gets its line.
 */
export function logItems(events: Activity[]): LogItem[] {
  const seen = new Set<string>();
  const once = events.filter((event) => {
    const key = identity(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const judgments = judgeCards(once).map(
    (card): LogItem => ({ type: 'judgment', id: `judgment:${card.id}`, at: card.at, card })
  );
  // An answer names its question by id, which counts within one harness process; the question names the call.
  const question = (event: Activity): string => JSON.stringify([event.runtimeId ?? '', str(event.payload.id)]);
  const asked = new Map(
    once
      .filter((event) => event.kind === 'permissions.request' && str(event.payload.summary))
      .map((event) => [question(event), str(event.payload.summary)])
  );
  const listed = new Set(runtimeEvents(once));
  const others = changes(once)
    .filter((event) => (listed.has(event) || event.kind === 'artifact.image') && !SHOWN_ELSEWHERE.has(event.kind))
    .map((event): LogItem => {
      const item: Extract<LogItem, { type: 'event' }> = { type: 'event', id: `event:${event.id}`, at: event.at, event };
      const about = event.kind === 'permissions.resolved' ? asked.get(question(event)) : undefined;
      if (about) item.about = about;
      return item;
    });
  // A stable sort: records of the same moment keep the order they came in.
  return [...others, ...judgments].toSorted((a, b) => a.at - b.at);
}

/** One line of the log: `item` is the latest of `count` records in a row that said the same. */
export type LogRow = { key: string; item: LogItem; count: number };

/**
 * The same line many times over in a row ("What the agent is doing · fallback" at every look of the board) is one line
 * with a count. The row keeps the first record's key, so an opened line stays open as the count grows, and shows the
 * latest record. Only neighbours fold: a line in between keeps the order of what happened.
 */
export function foldRepeats(items: readonly LogItem[], sentence: (item: LogItem) => string): LogRow[] {
  const rows: LogRow[] = [];
  let previous = '';
  for (const item of items) {
    const said = JSON.stringify([itemCode(item), sentence(item)]);
    const last = rows.at(-1);
    if (last && said === previous) rows[rows.length - 1] = { key: last.key, item, count: last.count + 1 };
    else rows.push({ key: item.id, item, count: 1 });
    previous = said;
  }
  return rows;
}

/** Whether the agent is working on a turn: it started one and has not settled since. */
export function turnRunning(events: readonly Activity[]): boolean {
  for (let index = events.length - 1; index >= 0; index--) {
    const kind = events[index].kind;
    if (kind === 'agent_start') return true;
    if (kind === 'agent_settled' || kind === 'kyrn_rpc_closed') return false;
  }
  return false;
}

/** The verdict on the message being worked on: kept in view while its turn runs, or while it is still being made. */
export function pinnedVerdict(items: readonly LogItem[], running: boolean): JudgeCard | undefined {
  const latest = items.findLast((item) => item.type === 'judgment' && item.card.stage === 'preflight');
  const card = latest?.type === 'judgment' ? latest.card : undefined;
  return card && (running || card.state === 'pending') ? card : undefined;
}

/** The code a line shows: the decision point a judgment answered, or the kind of a runtime event. */
export const itemCode = (item: LogItem): string => (item.type === 'judgment' ? item.card.specId : item.event.kind);

/**
 * A classification in the words the conversation uses for it ("Classified by Jev: Multi-step task"), naming the judge
 * that answered. One that came to nothing says why: no judge set up, the judge not answering, switched off, skipped.
 */
function verdictSentence(t: TFunction, card: JudgeCard): string {
  const judge = judgeName(card.model);
  if (card.state === 'pending') return t('common.kyrn.judgeLine.classifying', { judge });
  if (card.state === 'fallback') {
    // A wait that ran out (`timeout`) is the judge not answering in time.
    const kind = fallbackKind(card.reason);
    if (kind === 'noJudge') return t('common.kyrn.judgeLine.noJudge');
    if (kind === 'quiet')
      return t(card.reason === 'off' ? 'common.kyrn.judgeLine.off' : 'common.kyrn.judgeLine.skipped');
    return t(kind === 'unanswered' ? 'common.kyrn.judgeLine.unanswered' : 'common.kyrn.judgeLine.fallback', { judge });
  }
  if (card.state === 'ended') return t('common.kyrn.event.preflight.wait_end');
  const turnType = str(record(card.outcome).turnType);
  const type = t(`common.kyrn.judgeView.values.${isTurnType(turnType) ? turnType : 'other'}`);
  const said =
    card.state === 'rule'
      ? t('common.kyrn.judgeLine.byRule', { type })
      : t('common.kyrn.judgeLine.classified', { type, judge });
  if (card.state === 'shadow') return t('common.kyrn.judgeLine.shadow', { line: said });
  if (card.state === 'late') return t('common.kyrn.judgeLine.late', { line: said });
  return said;
}

/** What one line says: a judgment by its question and what became of it, an event by its coded words. */
export function itemSentence(t: TFunction, item: LogItem, language?: string | null): string {
  if (item.type === 'judgment') {
    const card = item.card;
    if (card.stage === 'preflight') return verdictSentence(t, card);
    const route = card.route ? [card.route.from, card.route.to].filter(Boolean).join(' → ') : '';
    return [route, t(`common.kyrn.judgeView.questions.${card.stage}`), t(`common.kyrn.judgeView.state.${card.state}`)]
      .filter(Boolean)
      .join(' · ');
  }
  const { kind, payload } = item.event;
  // An answer is worded with the call its question named; the record itself stays as it came.
  const lines = eventLines(t, kind, item.about ? { ...payload, summary: item.about } : payload, language);
  if (lines?.length) return lines.join(' · ');
  const label = t(`common.kyrn.event.${kind}`, { defaultValue: kind });
  const text = str(payload.text) || str(payload.lesson) || str(payload.head) || str(payload.step);
  const score =
    typeof payload.score === 'number' && Number.isFinite(payload.score)
      ? formatNumber(payload.score, language, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '';
  return [label, text, score].filter(Boolean).join(' · ');
}

/** Events that name lessons by id: the lessons brought into a turn, and the ones it followed. */
const NAMES_LESSONS: ReadonlySet<string> = new Set(['memory.recalled', 'memory.applied']);

/** Whether a line names lessons by id, so that the log needs their words (`lessonText`) to say which. */
export const namesLessons = (item: LogItem): boolean =>
  item.type === 'judgment' ? LESSON_FIELDS[item.card.stage] !== undefined : NAMES_LESSONS.has(item.event.kind);

/**
 * Every line of an event, for its opened view: the coded words, or the text it carried. An event that names lessons
 * lists them by their words (`lessonText`), one line each.
 */
export function eventDetail(
  t: TFunction,
  event: Activity,
  language?: string | null,
  lessonText?: (id: string) => string
): string[] {
  const lines = eventLines(t, event.kind, event.payload, language);
  if (lines?.length) return lines;
  if (lessonText && NAMES_LESSONS.has(event.kind) && Array.isArray(event.payload.ids)) {
    const named = event.payload.ids.filter((id): id is string => typeof id === 'string' && id !== '').map(lessonText);
    if (named.length) return named;
  }
  const text = str(event.payload.text) || str(event.payload.lesson) || str(event.payload.head);
  return text ? [text] : [];
}
