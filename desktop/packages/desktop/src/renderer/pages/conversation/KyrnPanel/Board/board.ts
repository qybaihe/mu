import type { Activity } from '@/common/kyrn/types';
import { record, str } from '../activity';

/**
 * The plain-language board as the panel shows it, read from the harness's presentation events of one conversation:
 * `board.switched` ({ on, cwd }) says whether the board is on for the project, when the session opens and after
 * `/board on|off`; `board.update` is the latest board, `restored` when it is the last one replayed on opening;
 * `board.note` is one line of the board's running account (what the agent did), sent the moment it happens, and every
 * `board.update` carries the last lines of that account as `log`.
 *
 * Board v2 (kyrn/docs/features/plain-language-board.md) adds, all optional: a spoken `headline`, what is `blocked`,
 * what comes `next`, who is doing what (`agents`, built by the harness's rules from the live helper runs), when the
 * board was made (`updatedAt`), the stage `blocked`, and `who` on a line of the account. A board without them is shown
 * exactly as before.
 */

export const BOARD_PHASES = [
  'understanding',
  'planning',
  'changing',
  'checking',
  'fixing',
  'waiting',
  'wrapping_up',
  'stuck',
  // Waiting on something other than the person: a long command, a helper, the judge, the network.
  'blocked',
] as const;
export type BoardPhase = (typeof BOARD_PHASES)[number];

export const NOTE_KINDS = ['step', 'check', 'said', 'ticked', 'asked', 'helpers', 'goal', 'trouble', 'ended'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/**
 * One line of the board's running account: one thing the agent did, in one plain sentence. `by: 'model'` is the
 * board model's own words (the agent's words retold, a finding, what a check meant, the summing up at the end);
 * `by: 'rules'` is one of the harness's fixed sentences, named by `code`, which the app words in its own language.
 */
export type BoardNote = {
  /** `${at}:${sequence}`: a note with the identity of one already shown replaces it where it stands. */
  id: string;
  /** The harness's own counter. */
  sequence: number;
  /** When it happened, in ms since the epoch. */
  at: number;
  /** What it records; absent for a sort of note this build does not know. */
  kind?: NoteKind;
  /** The harness's sentence, in the person's language (Chinese or English). */
  text: string;
  by: 'model' | 'rules';
  /** Which fixed sentence it is (rules only). */
  code?: string;
  /** What fills the fixed sentence. */
  params?: Record<string, string | number>;
  /** Something went wrong: a failed check, a command that errored, a denied permission, trouble. */
  failed: boolean;
  /** From the account the session replays as it opens: not news. */
  restored: boolean;
  /** The helper the line is about (its name as the agent gave it); absent for the main agent. */
  who?: string;
};

export const AGENT_STATES = ['working', 'waiting', 'done', 'failed', 'stuck'] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** One helper the main agent sent out, as the harness's rules saw it when the board was made. */
export type BoardAgent = {
  /** Its name, exactly as the helper run names it. */
  who: string;
  role?: string;
  /** Absent for a state this build does not know. */
  state?: AgentState;
  /** What it is doing: the model's words for this helper when it gave some, else the rules' summary. */
  doing: string;
  /** How long it had been in its state when the board was made. */
  sinceMs?: number;
};

/** A sentence of the harness's rules, named by its code so the app can word it in its own language. */
export type BoardCode = { code: string; params?: Record<string, string | number> };

export type BoardUpdate = {
  /** The event's own id: a new one is a new board. */
  id: string;
  progress: string;
  now: string;
  confirm: string[];
  phase?: BoardPhase;
  needsUser: boolean;
  done: number;
  total: number;
  /** Written by the model, or the harness's fixed sentences when the model did not answer. */
  by: 'model' | 'rules';
  /** Written when the agent stopped. */
  ended: boolean;
  /** The last board, shown again as the session opened: not news. */
  restored: boolean;
  /** The text of the acceptance item being worked on (the task's own words), from a harness that sends it. */
  focusText?: string;
  /**
   * One per `confirm` line of a fixed board: `waiting_reply` for the harness's "It waits for your reply", null for a
   * line quoted from the agent. A harness that sends codes sends this with every fixed board, empty when nothing
   * waits: its presence says the board can be rebuilt from its facts.
   */
  confirmCodes?: (string | null)[];
  /** The last lines of the running account, oldest first, from a harness that keeps one. */
  log?: BoardNote[];
  /** One spoken line: who is doing what right now, or what just happened (v2). */
  headline?: string;
  /** The headline's fixed sentence, when the harness's rules wrote it. */
  headlineCode?: BoardCode;
  /** Who waits on what, and for how long (v2). */
  blocked?: string;
  /** The blocked line's fixed sentence, when the harness's rules wrote it. */
  blockedCode?: BoardCode;
  /** What comes next, taken from the facts (v2). */
  next?: string;
  /** Who is doing what: one row per helper (v2); the main agent is not listed. */
  agents?: BoardAgent[];
  /** When the harness made the board, in ms since the epoch (v2). */
  updatedAt?: number;
};

export type BoardView = {
  /**
   * Whether this conversation's harness has a board at all: it said so (a switch, a board or a note). Another agent's
   * conversation, or mu with the board feature off, never does, and `/board` would reach its model as a message.
   */
  known: boolean;
  /** Whether the board is on for this project; undefined until the session has said. */
  on: boolean | undefined;
  update?: BoardUpdate;
};

/** A line the board shows is short: a longer one is cut rather than let it take the panel. */
const LINE_LIMIT = 600;
const CONFIRM_LIMIT = 8;
/** How many helpers the board lists. */
const AGENT_LIMIT = 16;
/** A name is short: a longer one is cut. */
const NAME_LIMIT = 80;
/** How many lines the account keeps: the oldest go first. */
export const ACCOUNT_LIMIT = 200;
/** The latest time a Date can hold. */
const TIME_LIMIT = 8.64e15;

const clip = (text: string) => (text.length > LINE_LIMIT ? `${text.slice(0, LINE_LIMIT)}…` : text);
const line = (value: unknown) => clip(str(value).trim());
/** A code is a lowercase word or words joined by underscores. */
const CODE = /^[a-z][a-z_]{0,47}$/;
/** A param is named by a word. */
const PARAM = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
const shortName = (value: unknown) => {
  const text = str(value).trim();
  return text.length > NAME_LIMIT ? `${text.slice(0, NAME_LIMIT)}…` : text;
};
/** A time in ms since the epoch that a Date can hold. */
const instant = (value: unknown): number | undefined =>
  typeof value === 'number' && value > 0 && value <= TIME_LIMIT ? value : undefined;

/** A fixed sentence's code and what fills it; none without a code. */
function codeOf(code: unknown, params: unknown): BoardCode | undefined {
  if (!CODE.test(str(code))) return undefined;
  const filled = noteParams(params);
  return { code: str(code), ...(filled ? { params: filled } : {}) };
}

/** The helpers a board lists, in the harness's order; a row without a name is dropped. */
function boardAgents(value: unknown): BoardAgent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const agents: BoardAgent[] = [];
  for (const item of value as unknown[]) {
    const row = record(item);
    const who = shortName(row.who);
    if (!who) continue;
    const role = shortName(row.role);
    const state = AGENT_STATES.find((known) => known === row.state);
    const since = row.sinceMs;
    agents.push({
      who,
      ...(role ? { role } : {}),
      ...(state ? { state } : {}),
      doing: line(row.doing),
      ...(typeof since === 'number' && Number.isFinite(since) && since >= 0 ? { sinceMs: since } : {}),
    });
    if (agents.length === AGENT_LIMIT) break;
  }
  return agents;
}

export function toBoardUpdate(event: Activity): BoardUpdate | undefined {
  const payload = event.payload;
  const now = line(payload.now);
  const progress = line(payload.progress);
  const headline = line(payload.headline);
  if (!now && !progress && !headline) return undefined;
  const phase = BOARD_PHASES.find((known) => known === payload.phase);
  // Each line keeps its code through the filtering: the codes are the lines' own, in the same order.
  const coded = Array.isArray(payload.confirmCodes);
  const codes: unknown[] = coded ? (payload.confirmCodes as unknown[]) : [];
  const confirmed = (Array.isArray(payload.confirm) ? payload.confirm : [])
    .map((item, index) => ({ text: line(item), code: CODE.test(str(codes[index])) ? str(codes[index]) : null }))
    .filter((item) => item.text)
    .slice(0, CONFIRM_LIMIT);
  const total = count(payload.total);
  const focusText = line(payload.focusText);
  const restored = payload.restored === true;
  const log = boardLog(payload, restored);
  const blocked = line(payload.blocked);
  const next = line(payload.next);
  const headlineCode = headline ? codeOf(payload.headlineCode, payload.headlineParams) : undefined;
  const blockedCode = blocked ? codeOf(payload.blockedCode, payload.blockedParams) : undefined;
  const agents = boardAgents(payload.agents);
  const updatedAt = instant(payload.updatedAt);
  return {
    id: event.id,
    progress,
    now,
    confirm: confirmed.map((item) => item.text),
    ...(coded ? { confirmCodes: confirmed.map((item) => item.code) } : {}),
    ...(focusText ? { focusText } : {}),
    ...(phase ? { phase } : {}),
    needsUser: payload.needsUser === true,
    done: Math.min(count(payload.done), total),
    total,
    by: payload.by === 'rules' ? 'rules' : 'model',
    ended: payload.ended === true,
    restored,
    ...(log ? { log } : {}),
    ...(headline ? { headline } : {}),
    ...(headlineCode ? { headlineCode } : {}),
    ...(blocked ? { blocked } : {}),
    ...(blockedCode ? { blockedCode } : {}),
    ...(next ? { next } : {}),
    ...(agents?.length ? { agents } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

/** What fills a fixed sentence: text (cut like a line) and numbers, by name. */
function noteParams(value: unknown): Record<string, string | number> | undefined {
  const params: Record<string, string | number> = {};
  for (const [name, item] of Object.entries(record(value))) {
    if (!PARAM.test(name)) continue;
    if (typeof item === 'string') params[name] = clip(item);
    else if (typeof item === 'number' && Number.isFinite(item)) params[name] = item;
  }
  return Object.keys(params).length ? params : undefined;
}

/** One line of the account as the harness sent it; none without its text or its time. */
function toNote(value: unknown, restored: boolean): BoardNote | undefined {
  const payload = record(value);
  const text = line(payload.text);
  const at = instant(payload.at);
  if (!text || at === undefined) return undefined;
  // Without its counter a note is known by its time alone.
  const sequence =
    Number.isSafeInteger(payload.sequence) && (payload.sequence as number) >= 0 ? (payload.sequence as number) : 0;
  const kind = NOTE_KINDS.find((known) => known === payload.kind);
  const by = payload.by === 'rules' ? 'rules' : 'model';
  const code = by === 'rules' && CODE.test(str(payload.code)) ? str(payload.code) : undefined;
  const params = noteParams(payload.params);
  const who = shortName(payload.who);
  return {
    id: `${at}:${sequence}`,
    sequence,
    at,
    ...(kind ? { kind } : {}),
    text,
    by,
    ...(code ? { code } : {}),
    ...(params ? { params } : {}),
    failed: payload.failed === true,
    restored,
    ...(who ? { who } : {}),
  };
}

/** A `board.note` event as one line of the account. */
export const toBoardNote = (event: Activity): BoardNote | undefined => toNote(event.payload, false);

/** The lines of the account a board carries, oldest first; undefined when it carries none. */
function boardLog(payload: Record<string, unknown>, restored: boolean): BoardNote[] | undefined {
  if (!Array.isArray(payload.log)) return undefined;
  return (payload.log as unknown[])
    .slice(-ACCOUNT_LIMIT)
    .map((item) => toNote(item, restored))
    .filter((note): note is BoardNote => note !== undefined);
}

/** What the board says now: the last switch and the last board, in the order the session sent them. */
export function boardView(events: readonly Activity[]): BoardView {
  let on: boolean | undefined;
  let update: BoardUpdate | undefined;
  for (const event of events) {
    if (event.kind === 'board.switched' && typeof event.payload.on === 'boolean') on = event.payload.on;
    else if (event.kind === 'board.update') {
      update = toBoardUpdate(event) ?? update;
      // A harness that sends boards has the board on, even when its switch was not seen.
      on ??= true;
    } else if (event.kind === 'board.note') on ??= true;
  }
  return { known: on !== undefined, on, ...(update ? { update } : {}) };
}

/**
 * The board's running account, oldest first: every `board.note`, and the `log` of the last board that carries one
 * (on a reopened conversation, the one replayed as the session opens), one line per identity. Where two say the same
 * note the later one wins, so a note sent again (a count that grew) is replaced where it stands. The newest
 * `ACCOUNT_LIMIT` are kept.
 */
export function boardAccount(events: readonly Activity[]): BoardNote[] {
  const last = events.findLastIndex((event) => event.kind === 'board.update' && Array.isArray(event.payload.log));
  const notes = new Map<string, BoardNote>();
  events.forEach((event, index) => {
    const found =
      event.kind === 'board.note'
        ? [toBoardNote(event)]
        : index === last
          ? boardLog(event.payload, event.payload.restored === true)
          : undefined;
    for (const note of found ?? []) if (note) notes.set(note.id, note);
  });
  return [...notes.values()].toSorted((a, b) => a.at - b.at || a.sequence - b.sequence).slice(-ACCOUNT_LIMIT);
}

/**
 * The one state the board's header shows. While the agent works, its stage. Once it has stopped (`ended`), how the run
 * ended: done when it was wrapping up or every acceptance item is done, waiting when it waits for the person, and
 * stopped otherwise. A stage is never shown for a run that has stopped: "wrapping up" over a finished run misreads it.
 */
export type BoardState = { ended: false; phase: BoardPhase } | { ended: true; outcome: 'done' | 'waiting' | 'stopped' };
// Read a state's kind with `state.ended === false`: the project type-checks without strictNullChecks, where
// `!state.ended` does not narrow a state to the working one.

export function boardState(update: BoardUpdate): BoardState | undefined {
  if (!update.ended) return update.phase ? { ended: false, phase: update.phase } : undefined;
  if (update.phase === 'wrapping_up' || (update.total > 0 && update.done === update.total)) {
    return { ended: true, outcome: 'done' };
  }
  if (update.phase === 'waiting' || update.needsUser) return { ended: true, outcome: 'waiting' };
  return { ended: true, outcome: 'stopped' };
}

/** The words of a state, as a key under `common.kyrn.boardView`: a run waiting for the person reads as that stage. */
export function boardStateKey(state: BoardState): string {
  if (state.ended === false) return `phases.${state.phase}`;
  return state.outcome === 'done' ? 'done' : state.outcome === 'waiting' ? 'phases.waiting' : 'ended';
}

/** The part of the work done, from 0 to 1, when the task has acceptance items to count. */
export const share = (update: BoardUpdate) => (update.total > 0 ? update.done / update.total : undefined);

/** Whether the board asks something of the person: said so, or listed what to confirm. */
export const asksUser = (update: BoardUpdate) => update.needsUser || update.confirm.length > 0;
