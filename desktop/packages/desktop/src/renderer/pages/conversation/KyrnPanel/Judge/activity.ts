import type { Activity } from '@/common/kyrn/types';
import { list, record, str } from '../activity';

/** Decision points of the harness by ledger spec id. An unknown id stays visible as `other`. */
export const DECISIONS = {
  'input.preflight': 'preflight',
  'input.interjection': 'interjection',
  'tool.admission': 'admission',
  'tool.admission.test-log': 'testLog',
  'context.forget': 'forget',
  'context.compact': 'compaction',
  'skills.disclosure': 'skills',
  'files.locate': 'locate',
  'swarm.routing': 'routing',
  'hive.publish': 'publish',
  'hive.deliver': 'deliver',
  'browser.step': 'browser',
  'memory.recall': 'recall',
  'memory.capture': 'capture',
  'memory.outcome': 'outcome',
  'memory.worth': 'worth',
  'memory.merge': 'merge',
  'memory.applied': 'applied',
  'tool.risk': 'risk',
  'turn.drift': 'drift',
  'turn.completion': 'completion',
  'notify.routing': 'notify',
  'cache.warming': 'cache',
  'turn.rewind': 'rewind',
  'goal.met': 'goalMet',
  'output.drift': 'outputDrift',
  'task.frame': 'taskFrame',
  'tool.constraint': 'constraint',
  'capability.disclosure': 'capabilities',
  'diagnostics.delivery': 'diagnostics',
  'swarm.patch': 'patch',
  'review.triage': 'review',
  'board.read': 'board',
  'hive.relate': 'relate',
  'tool.approval': 'approval',
  'tool.injection': 'injection',
  'turn.continue': 'continuation',
  'judge.items': 'items',
} as const;

export type JudgeStage = (typeof DECISIONS)[keyof typeof DECISIONS] | 'other';

/** The decision point a ledger spec id belongs to; its question is `common.kyrn.judgeView.questions.<stage>`. */
export const stageOf = (specId: string): JudgeStage => DECISIONS[specId as keyof typeof DECISIONS] ?? 'other';

/** The harness words an unanswered classification as "no answer after 6.0 s"; the view shows it as a code. */
const NO_ANSWER = /^no answer after (\d+(?:\.\d+)?) s$/;

/** What a reason names, such as the seconds waited: numbers only, anything else is dropped. */
export type ReasonParams = Record<string, number>;

const numbers = (value: unknown): ReasonParams | undefined => {
  const entries = Object.entries(record(value)).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
};

/** A reason as the view reads it: the code, what it names, and the recorded words where they differ from the code. */
export type ReadReason = { code: string; params?: ReasonParams; text?: string };

/**
 * A recorded reason as a code the view can translate, with what it names. A stable `code` beside the reason wins;
 * without one (records from before the harness sent codes), `error:<kind>` and the judge's own codes stay as they
 * are, and the preflight's English sentence for a wait without an answer becomes `no_answer` with its seconds.
 * `text` keeps the recorded English beside a code, for a code this build has no words for.
 */
export function readReason(reason: unknown, code?: unknown, params?: unknown): ReadReason {
  const text = str(reason).trim();
  const unanswered = NO_ANSWER.exec(text);
  if (typeof code === 'string' && code) {
    const named = numbers(params);
    // A record whose parameters were lost still names its seconds in its words.
    const read =
      code === 'no_answer' && named?.seconds === undefined && unanswered
        ? { ...named, seconds: Number(unanswered[1]) }
        : named;
    return { code, params: read, ...(text && text !== code ? { text } : {}) };
  }
  return unanswered ? { code: 'no_answer', params: { seconds: Number(unanswered[1]) } } : { code: text };
}

/** `readReason` without the parameters. */
export const reasonCode = (reason: string): string => readReason(reason).code;

/**
 * What became of a judgment. `returned` only says the runtime received it; `confirmed` needs a
 * recorded effect (an applied adjustment, a delivery receipt). `shadow`, `late`, `fallback` and
 * `rule` are never folded into either: each means the judge's answer did not drive execution.
 */
export type JudgeState =
  | 'pending'
  | 'returned'
  | 'confirmed'
  | 'shadow'
  | 'fallback'
  | 'late'
  | 'rule'
  | 'ended'
  | 'unknown';

export type JudgeAction =
  | 'toRuntime'
  | 'observeOnly'
  | 'useDefault'
  | 'lateIgnored'
  | 'waiting'
  | 'waitEnded'
  | 'recordedOnly'
  | 'mainGiven'
  | 'allowPublish'
  | 'denyPublish'
  | 'allowDelivery'
  | 'denyDelivery'
  | 'delivered';

export type JudgeCard = {
  id: string;
  at: number;
  stage: JudgeStage;
  specId: string;
  state: JudgeState;
  action: JudgeAction;
  /** The judge model that answered. Empty for a rule, or when none was recorded. */
  model: string;
  latencyMs?: number;
  outcome: unknown;
  /** Why the judge's answer did not drive execution, as a code (`abstain`, `error:timeout`, `no_answer`…). */
  reason: string;
  /** What the reason names (`no_answer`: `seconds`). */
  reasonParams?: ReasonParams;
  /** The recorded English beside a reason code, shown when this build has no words for the code. */
  reasonFallback?: string;
  thinking?: { from: string; to: string };
  /** What the main model was told, in the harness's (English) words. */
  hints: string[];
  /** Which hints those are, in the same order (`clarify`, `side_question`…); '' where a record names none. */
  hintIds: string[];
  answers: unknown;
  batch?: { size: number; failures: number };
  route?: { from: string; to: string };
  preview: string;
  /** A classification record without correlation fields. It stands alone; nothing is merged into it. */
  unlinked: boolean;
  evidence: Activity[];
};

type Payload = Record<string, unknown>;
type Group = { id: string; specId: string; unlinked: boolean; events: Activity[] };

const PREFLIGHT = 'input.preflight';
const amount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const joinKey = (...parts: unknown[]): string => JSON.stringify(parts);

/** Both fields or nothing: a turn number alone repeats in every runtime. */
const turnScope = (event: Activity): string | undefined =>
  typeof event.runtimeId === 'string' && event.runtimeId && Number.isSafeInteger(event.turnId)
    ? joinKey(event.runtimeId, event.turnId)
    : undefined;

const isPreflight = (event: Activity): boolean =>
  event.kind.startsWith('preflight.') || (event.kind === 'decision' && event.payload.specId === PREFLIGHT);

const bySequence = (a: Activity, b: Activity): number =>
  a.sequence !== undefined && b.sequence !== undefined ? a.sequence - b.sequence : 0;

/** A ledger record on its own: what the caller acted on, and whether the judge's answer was it. */
function ledgerVerdict(ledger: Payload): Pick<JudgeCard, 'state' | 'action'> {
  const reason = str(ledger.reason);
  if (ledger.mode === 'shadow' || reason === 'shadow') return { state: 'shadow', action: 'observeOnly' };
  if (ledger.source === 'fallback' || reason === 'abstain' || reason.startsWith('error:'))
    return { state: 'fallback', action: 'useDefault' };
  if (ledger.source === 'judge') return { state: 'returned', action: 'toRuntime' };
  return { state: 'unknown', action: 'recordedOnly' };
}

function batchOf(ledger: Payload): JudgeCard['batch'] {
  const batch = record(ledger.batch);
  const size = amount(batch.size);
  return size === undefined ? undefined : { size, failures: amount(batch.failures) ?? 0 };
}

function decisionCard(group: Group, ledger: Payload): JudgeCard {
  const shadow = ledger.mode === 'shadow';
  return {
    id: group.id,
    at: group.events.at(-1)!.at,
    stage: stageOf(group.specId),
    specId: group.specId,
    ...ledgerVerdict(ledger),
    model: str(ledger.modelId) || str(ledger.providerId),
    latencyMs: amount(ledger.latencyMs),
    // Observe-only: the caller acted on its default, so the judgment itself is what is worth reading.
    outcome: shadow && ledger.judged !== undefined ? ledger.judged : ledger.outcome,
    reason: str(ledger.reason),
    hints: [],
    hintIds: [],
    answers: ledger.answers ?? record(ledger.batch).answers,
    batch: batchOf(ledger),
    preview: '',
    unlinked: group.unlinked,
    evidence: group.events,
  };
}

function preflightCard(group: Group, ended: (group: Group) => boolean): JudgeCard {
  const last = (kind: string): Payload | undefined => group.events.findLast((event) => event.kind === kind)?.payload;
  const verdict = last('preflight.verdict');
  const wait = last('preflight.wait_end');
  const pending = last('preflight.pending');
  // A ledger frame is stamped with the turn that is current when it is written, so a judge that
  // answers after the next message began lands under that message. A verdict repeats its ledger
  // record's latency; a record that disagrees belongs to another turn and must not describe this one.
  const latency = amount(verdict?.latencyMs);
  const ledger = group.events.findLast(
    (event) =>
      event.kind === 'decision' &&
      (latency === undefined ||
        amount(event.payload.latencyMs) === undefined ||
        amount(event.payload.latencyMs) === latency)
  )?.payload;
  const base: JudgeCard = {
    ...decisionCard(group, ledger ?? {}),
    model: str(ledger?.modelId) || (verdict?.by === 'rule' ? '' : str(verdict?.by)) || str(pending?.judge),
  };
  if (!verdict) {
    if (ledger) return base;
    // Only the wait was recorded. A timeout runs the turn on stock behaviour; anything else says
    // nothing about a judgment, and a wait whose task has since ended is no longer a wait.
    const timedOut = wait?.reason === 'timeout';
    const over = Boolean(wait) || ended(group);
    return {
      ...base,
      state: timedOut ? 'fallback' : over ? 'ended' : 'pending',
      action: timedOut ? 'useDefault' : over ? 'waitEnded' : 'waiting',
      latencyMs: amount(wait?.waitedMs),
      reason: str(wait?.reason),
      outcome: undefined,
    };
  }
  const why = readReason(verdict.reason, verdict.reasonCode, verdict.reasonParams);
  const change = record(verdict.thinking);
  const thinking =
    str(change.from) && str(change.to) && change.from !== change.to
      ? { from: str(change.from), to: str(change.to) }
      : undefined;
  // A hint and its id share an index; a record from before the ids has the sentences only.
  const sentences = Array.isArray(verdict.hints) ? verdict.hints.map(str) : [];
  const ids = Array.isArray(verdict.hintIds) ? verdict.hintIds.map(str) : [];
  const told = Array.from({ length: Math.max(sentences.length, ids.length) }, (_, index) => ({
    hint: sentences[index] ?? '',
    id: ids[index] ?? '',
  })).filter((pair) => pair.hint || pair.id);
  const hints = told.map((pair) => pair.hint);
  const applied = verdict.state === 'applied';
  const effect = applied && (thinking !== undefined || hints.length > 0);
  let state: JudgeState = 'unknown';
  let action: JudgeAction = 'recordedOnly';
  if (verdict.state === 'shadow') [state, action] = ['shadow', 'observeOnly'];
  else if (verdict.state === 'late') [state, action] = ['late', 'lateIgnored'];
  else if (verdict.state === 'none') [state, action] = ['fallback', 'useDefault'];
  // A rule settled it without the judge: applied, but never presented as the judge's decision.
  else if (applied && verdict.by === 'rule') [state, action] = ['rule', effect ? 'mainGiven' : 'useDefault'];
  else if (applied) [state, action] = effect ? ['confirmed', 'mainGiven'] : ['returned', 'toRuntime'];
  return {
    ...base,
    state,
    action,
    // The wait marker and the ledger may still name the judge that was asked. It did not settle this one.
    model: state === 'rule' ? '' : base.model,
    latencyMs: amount(verdict.latencyMs) ?? base.latencyMs ?? amount(wait?.waitedMs),
    outcome: { turnType: verdict.turnType, gear: verdict.gear },
    ...(why.code ? { reason: why.code, reasonParams: why.params, reasonFallback: why.text } : {}),
    thinking: applied ? thinking : undefined,
    hints: applied ? hints : [],
    hintIds: applied ? told.map((pair) => pair.id) : [],
    // The answers by question id as the judge gave them; the label and English value pairs are for older records.
    answers: ledger?.answers ?? verdict.answerValues ?? verdict.answers,
  };
}

function gateCard(group: Group, receipts: ReadonlySet<string>, notes: ReadonlyMap<string, Payload>): JudgeCard {
  const event = group.events[0];
  const gate = event.payload;
  const delivering = gate.gate === 'deliver' || (gate.gate === undefined && 'deliver' in gate);
  const allowed = delivering ? gate.deliver : gate.publish;
  const reason = str(gate.reason);
  let state: JudgeState = 'unknown';
  let action: JudgeAction = 'recordedOnly';
  if (reason === 'shadow') [state, action] = ['shadow', 'observeOnly'];
  // The gates fail closed: their default withholds, it never waves a note through.
  else if (reason === 'abstain' || reason.startsWith('error:')) [state, action] = ['fallback', 'useDefault'];
  else if (typeof allowed === 'boolean') {
    state = 'returned';
    action = delivering ? (allowed ? 'allowDelivery' : 'denyDelivery') : allowed ? 'allowPublish' : 'denyPublish';
  }
  // "Allowed" is a verdict. Only a delivery receipt for the same run, note and bee is an arrival.
  if (delivering && allowed === true && event.run && receipts.has(joinKey(event.run, gate.note, gate.to)))
    [state, action] = ['confirmed', 'delivered'];
  const note = event.run ? notes.get(joinKey(event.run, gate.note)) : undefined;
  return {
    id: group.id,
    at: event.at,
    stage: delivering ? 'deliver' : 'publish',
    specId: group.specId,
    state,
    action,
    model: '',
    outcome: {
      [delivering ? 'deliver' : 'publish']: allowed,
      ...(typeof gate.kind === 'string' ? { kind: gate.kind } : {}),
      ...(typeof gate.score === 'number' ? { score: gate.score } : {}),
    },
    reason,
    hints: [],
    hintIds: [],
    answers: undefined,
    route: { from: str(gate.bee) || str(gate.from), to: str(gate.to) },
    preview: str(gate.text) || str(gate.head) || str(note?.text),
    unlinked: false,
    evidence: group.events,
  };
}

/**
 * One card per judgment, newest first. Phases of a classification are folded only when they carry
 * the same runtime id and turn number; a record without them is never attached to a neighbour by
 * timestamp. It stays a card of its own.
 */
export function judgeCards(events: Activity[]): JudgeCard[] {
  const groups = new Map<string, Group>();
  const receipts = new Set<string>();
  const notes = new Map<string, Payload>();
  const latestTurn = new Map<string, number>();
  const closes: number[] = [];
  const add = (id: string, specId: string, event: Activity, unlinked = false) => {
    const group = groups.get(id) ?? { id, specId, unlinked, events: [] };
    group.events.push(event);
    groups.set(id, group);
  };
  for (const event of events) {
    if (event.kind === 'hive.delivery' && event.run)
      receipts.add(joinKey(event.run, event.payload.note, event.payload.to));
    if (event.kind === 'hive.note' && event.run) notes.set(joinKey(event.run, event.payload.id), event.payload);
    if (event.kind === 'agent_settled' || event.kind === 'kyrn_rpc_closed') closes.push(event.at);
    if (event.kind === 'hive.gate') add(event.id, `hive.${str(event.payload.gate) || 'gate'}`, event);
    else if (isPreflight(event)) {
      const scope = turnScope(event);
      if (scope) {
        add(`preflight:${scope}`, PREFLIGHT, event);
        latestTurn.set(event.runtimeId!, Math.max(latestTurn.get(event.runtimeId!) ?? 0, event.turnId!));
      }
      // A lone wait marker is no judgment. It stays in the runtime event list, unpaired.
      else if (event.kind === 'preflight.verdict' || event.kind === 'decision') add(event.id, PREFLIGHT, event, true);
    } else if (event.kind === 'decision')
      add(str(event.payload.id) ? `decision:${str(event.payload.id)}` : event.id, str(event.payload.specId), event);
  }
  const ended = (group: Group): boolean => {
    const first = group.events[0];
    const at = group.events.at(-1)!.at;
    return closes.some((close) => close >= at) || (latestTurn.get(first.runtimeId ?? '') ?? 0) > (first.turnId ?? 0);
  };
  return [...groups.values()]
    .map((group): JudgeCard => {
      group.events.sort(bySequence);
      const first = group.events[0];
      if (first.kind === 'hive.gate') return gateCard(group, receipts, notes);
      if (group.specId === PREFLIGHT) return preflightCard(group, ended);
      return decisionCard(group, group.events.at(-1)!.payload);
    })
    .toSorted((a, b) => b.at - a.at);
}

/**
 * `pairs` are the labelled fields of one candidate in a batch; `more` counts what the list left out. A `tally` counts
 * identical answers of a batch: its name is an answer ("shrink"), not a field, and its one value is the count ("×2").
 */
export type JudgeFact = {
  name: string;
  values: string[];
  pairs?: { key: string; value: string }[];
  more?: number;
  tally?: true;
  /** The values are words to show as they are (a lesson's text), never a code to translate. */
  text?: true;
};

const FACT_LIMIT = 6;
const scalar = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : typeof value === 'boolean'
      ? String(value)
      : typeof value === 'number' && Number.isFinite(value)
        ? String(Math.round(value * 100) / 100)
        : '';
const capped = (name: string, values: string[]): JudgeFact =>
  values.length > FACT_LIMIT
    ? { name, values: values.slice(0, FACT_LIMIT), more: values.length - FACT_LIMIT }
    : { name, values };

/** The outcome fields that hold lesson ids: the lessons brought into a turn, and the ones it followed or not. */
export const LESSON_FIELDS: Partial<Record<JudgeStage, readonly string[]>> = {
  recall: ['apply'],
  applied: ['applied', 'notApplied'],
};

/**
 * The outcome fields that list positions counted from 0: the rules an output or a call goes against, the board's news
 * among what happened, the parts of a test log left out (`part_3`). A person counts from 1.
 */
const POSITIONS: Partial<Record<JudgeStage, string>> = {
  outputDrift: 'broken',
  constraint: 'broken',
  board: 'key',
  testLog: 'omit',
};

const position = (value: unknown): string => {
  const index = typeof value === 'number' ? value : Number(/^part_(\d+)$/.exec(str(value))?.[1] ?? Number.NaN);
  return Number.isSafeInteger(index) && index >= 0 ? String(index + 1) : scalar(value);
};

/** Every probability in an outcome of per-item probabilities, batches flattened (`[[0.9, 0.1], [0.02]]`). */
const probabilities = (value: unknown): number[] =>
  Array.isArray(value)
    ? value.flatMap(probabilities)
    : typeof value === 'number' && Number.isFinite(value)
      ? [value]
      : [];

/**
 * Counts for the decision points whose outcome is one probability per item: the passages the injection screen
 * withheld (over 0.5, as the harness reads it) and passed on, and the model's own question answered yes, no or
 * neither (the harness's 0.8 and 0.2).
 */
function probabilityFacts(stage: JudgeStage, outcome: unknown[]): JudgeFact[] | undefined {
  if (stage !== 'injection' && stage !== 'items') return undefined;
  const all = probabilities(outcome);
  const count = (keep: (probability: number) => boolean) => String(all.filter(keep).length);
  if (stage === 'injection')
    return [
      { name: 'withhold', values: [count((probability) => probability > 0.5)] },
      { name: 'kept', values: [count((probability) => probability <= 0.5)] },
    ];
  return [
    { name: 'answeredYes', values: [count((probability) => probability >= 0.8)] },
    { name: 'answeredNo', values: [count((probability) => probability <= 0.2)] },
    { name: 'answeredUnsure', values: [count((probability) => probability > 0.2 && probability < 0.8)] },
  ];
}

/**
 * The outcome as labelled fields. Names and values stay raw: the view translates the ones it knows; positions are
 * counted from 1. Nothing here turns a verdict into a claim that the operation was carried out. `lessonText` names a
 * lesson by its words, one fact each: which lessons a turn was given or followed is read by what they say, not by ids.
 */
export function resultFacts(card: JudgeCard, lessonText?: (id: string) => string): JudgeFact[] {
  const outcome = card.outcome;
  const lessonFields = LESSON_FIELDS[card.stage];
  if (lessonFields && lessonText) {
    const named = record(outcome);
    return lessonFields
      .flatMap((name) =>
        (Array.isArray(named[name]) ? named[name] : [])
          .filter((id): id is string => typeof id === 'string' && id !== '')
          .map((id): JudgeFact => ({ name, values: [lessonText(id)], text: true }))
      )
      .slice(0, FACT_LIMIT);
  }
  if (Array.isArray(outcome)) {
    const counted = probabilityFacts(card.stage, outcome);
    if (counted) return counted;
    const rows = list(outcome);
    if (card.stage === 'admission')
      return [
        { name: 'drop', values: [String(rows.filter((row) => row.drop === true).length)] },
        { name: 'keep', values: [String(rows.filter((row) => row.drop === false).length)] },
      ];
    if (outcome.every((value) => scalar(value))) {
      const counts = new Map<string, number>();
      for (const value of outcome) counts.set(scalar(value), (counts.get(scalar(value)) ?? 0) + 1);
      return [...counts]
        .slice(0, FACT_LIMIT)
        .map(([name, count]): JudgeFact => ({ name, values: [`×${count}`], tally: true }));
    }
    const facts = rows.flatMap((row, index): JudgeFact[] => {
      const pairs = Object.entries(row).flatMap(([key, value]) =>
        scalar(value) ? [{ key, value: scalar(value) }] : []
      );
      return pairs.length ? [{ name: String(index + 1), values: [], pairs }] : [];
    });
    return facts.length > FACT_LIMIT
      ? [...facts.slice(0, FACT_LIMIT - 1), { name: '…', values: [], more: facts.length - FACT_LIMIT + 1 }]
      : facts;
  }
  if (scalar(outcome)) return [{ name: 'result', values: [scalar(outcome)] }];
  return Object.entries(record(outcome))
    .flatMap(([name, value]): JudgeFact[] => {
      if (name === 'ranked')
        return [
          capped(
            'path',
            list(value)
              .map((row) => str(row.path))
              .filter(Boolean)
          ),
        ];
      const values = Array.isArray(value)
        ? value.map(POSITIONS[card.stage] === name ? position : scalar).filter(Boolean)
        : scalar(value)
          ? [scalar(value)]
          : [];
      return values.length ? [capped(name, values)] : [];
    })
    .slice(0, FACT_LIMIT);
}

export type JudgeAnswer =
  | { id: string; type: 'boolean'; probability: number }
  | { id: string; type: 'choice'; choice: string; options: { name: string; probability: number }[] }
  | { id: string; type: 'score'; score: number }
  | { id: string; type: 'text'; text: string };

const ANSWER_LIMIT = 12;

/** The judge's recorded answers with their probabilities. A batch keeps its per-item answers in the raw record. */
export function answerRows(card: JudgeCard): { rows: JudgeAnswer[]; more: number } {
  const source = card.answers;
  const rows: JudgeAnswer[] = Array.isArray(source)
    ? source.flatMap((pair): JudgeAnswer[] =>
        Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string'
          ? [{ id: pair[0], type: 'text', text: pair[1] }]
          : []
      )
    : Object.entries(record(source)).flatMap(([id, value]): JudgeAnswer[] => {
        const answer = record(value);
        if (answer.type === 'boolean' && typeof answer.probability === 'number')
          return [{ id, type: 'boolean', probability: answer.probability }];
        if (answer.type === 'score' && typeof answer.score === 'number')
          return [{ id, type: 'score', score: answer.score }];
        if (answer.type !== 'choice' || typeof answer.choice !== 'string') return [];
        const options = Object.entries(record(answer.probabilities))
          .flatMap(([name, probability]) => (typeof probability === 'number' ? [{ name, probability }] : []))
          .toSorted((a, b) => b.probability - a.probability)
          .slice(0, 3);
        return [{ id, type: 'choice', choice: answer.choice, options }];
      });
  return { rows: rows.slice(0, ANSWER_LIMIT), more: Math.max(0, rows.length - ANSWER_LIMIT) };
}

/** Events the Jev tab lists under its cards: everything that is neither a judgment nor another tab's record. */
export function runtimeEvents(events: Activity[]): Activity[] {
  return events.filter(
    (event) =>
      event.kind !== 'swarm.snapshot' &&
      event.kind !== 'bee.event' &&
      event.kind !== 'artifact.image' &&
      !event.kind.startsWith('hive.') &&
      event.kind !== 'decision' &&
      event.kind !== 'preflight.verdict' &&
      !(isPreflight(event) && turnScope(event))
  );
}
