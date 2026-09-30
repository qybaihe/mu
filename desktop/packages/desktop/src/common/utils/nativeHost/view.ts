import type { DialogMethod, JsonObject } from './records.ts';

/**
 * What a conversation looks like, derived from pi's records (reducer.ts). Plain data: a view is never mutated, each
 * record gives a new one.
 *
 * A live run and a session read back from its file give the same view, except `host`: what only a live host says
 * (the judgment layer's frames, notices, pi's queue, the session state pi reports) is not in the file. `durable`
 * leaves it out, to compare the two.
 */

/**
 * idle: nothing ran yet, or a reloaded session with no answer to show. working: a run is going. thinking: the model
 * writes a thinking block. settled / aborted / error: how the last run ended, from its last assistant message.
 */
export type TurnStatus = 'idle' | 'working' | 'thinking' | 'settled' | 'aborted' | 'error';

export type ViewImage = { mimeType: string; data: string };

/** What a tool call gave back, as its tool result message says. */
export type ViewToolResult = { text: string; images: ViewImage[]; details?: unknown; isError: boolean };

/**
 * streaming: the model still writes the call. pending: written, not started. running: executing (`partial` holds its
 * latest output). done / error: over, `result` says what came back.
 */
export type ToolStatus = 'streaming' | 'pending' | 'running' | 'done' | 'error';

export type ViewToolCall = {
  type: 'tool';
  id: string;
  name: string;
  args: JsonObject;
  status: ToolStatus;
  partial?: ViewToolResult;
  result?: ViewToolResult;
};

/** A block of an assistant message. A thinking block the provider redacted shows no text, only that it was there. */
export type ViewBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; redacted?: boolean }
  | ViewToolCall;

/**
 * Message ids number the conversation's messages (`m1`, `m2`, …) in the order the view took them, the same for a live
 * run and a file, and never change: a streaming message keeps its id when it ends. `entryId` is the session entry pi
 * saved the message as (`message_end.entryId` live, the entry's `id` in a file); a live record from a harness older
 * than that field has none.
 */
export type ViewUserMessage = {
  id: string;
  role: 'user';
  entryId?: string;
  text: string;
  images: ViewImage[];
  timestamp: number;
  /** Jev's verdict line on this message (`kyrn.verdict`), when the preflight ran for it. */
  verdict?: JsonObject;
};

/** What one reply of the model read and wrote, as pi counts it (`input` is what the cache did not hold). */
export type ViewUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type ViewAssistantMessage = {
  id: string;
  role: 'assistant';
  entryId?: string;
  blocks: ViewBlock[];
  timestamp: number;
  /** `provider/model` that answered. */
  model?: string;
  /** pi's stop reason (`stop`, `toolUse`, `length`, `aborted`, `error`), once the message is complete. */
  stopReason?: string;
  errorMessage?: string;
  /** The model is still writing it. */
  streaming: boolean;
  /** Its token counts, once the message is complete. */
  usage?: ViewUsage;
  /**
   * Failed attempts pi retried before this one (stop reason `error`). pi keeps each in the session file and hides it
   * from the model with a `context_edit`; the view folds it into the attempt that followed.
   */
  retries?: number;
  /**
   * This attempt failed and pi hid it from the model to try again. The next attempt takes its id and it leaves the
   * list; if none comes (the retry was stopped, or failed before it began), this attempt is how the run ended.
   */
  retried?: true;
};

/**
 * A message an extension put in the conversation for the person to see (`display: true`). It has no time: live, pi
 * says when it was sent, while its session entry keeps only when it was written, and the two differ.
 */
export type ViewCustomMessage = { id: string; role: 'custom'; entryId?: string; customType: string; text: string };

/**
 * A point where pi compacted the conversation (a `compaction` entry in the file, `compaction_end` live): from here on
 * the model gets what came before it condensed. Every message stays in the transcript; this marks where the model's own
 * memory of them changed. `tokensBefore` is how much context was condensed (0 when the entry does not say).
 */
export type ViewCompaction = { id: string; role: 'compaction'; tokensBefore: number };

export type ViewMessage = ViewUserMessage | ViewAssistantMessage | ViewCustomMessage | ViewCompaction;

/**
 * One of Jev's judgments: a decision ledger record, without the state the judge was shown, filed under the turn that
 * asked (the ledger's `origin.turn`, which a late verdict keeps). `turn` is missing only for records of a mu from
 * before `origin`.
 */
export type ViewJudgment = { id: string; turn?: number; record: JsonObject };

/**
 * What mu said about the permission question a select dialog asks (its `permissions.request` frame), for a card in
 * the reader's language: what kind of call, the call itself, why mu asks, and its answers by id (`once`, `session`,
 * `deny`), in the order of the dialog's options.
 */
export type ViewPermission = {
  /** edit, shell, run, outside, delegate or other. */
  kind: string;
  /** The call: a command, `edit <path>`, `<tool> <target>`. */
  summary: string;
  /** The answers as mu words them, which the dialog offers as its options. */
  answers: string[];
  answerIds?: string[];
  /** ask, unsure, beyond, unrelated, flagged, protected, nojudge, judgedown. */
  reason?: string;
  /** What makes a flagged command risky (`force_push`, …). */
  flagCode?: string;
  /** What "for this conversation" would cover. Data, not words. */
  grantLabel?: string;
  /** The tool call mu asks about. */
  toolCallId?: string;
};

/** A dialog pi waits on: an extension UI request of method select, confirm, input or editor. */
export type ViewDialog = {
  id: string;
  method: DialogMethod;
  title: string;
  /** confirm */
  message?: string;
  /** select */
  options?: string[];
  /** input */
  placeholder?: string;
  /** editor */
  prefill?: string;
  /**
   * After this many milliseconds pi stops waiting and takes the default, and says nothing: a screen closes the dialog
   * itself when that time has passed.
   */
  timeout?: number;
  /** Opened while a run was going: pi no longer waits for it once the run has settled. */
  inRun: boolean;
  /** A select that is mu's permission question: what mu said about it. */
  permission?: ViewPermission;
};

/** What only a live run has, gone once it settles: a reloaded view has none of it. */
export type ViewLive = {
  /** Jev classifies the message of this turn (`preflight.pending`), until its verdict or the end of the wait. */
  classifying?: { turn: number; judge: string };
  /**
   * What the judgment layer says it is working out (`progress`), until the run settles: its English line, and its code
   * and params for a screen to word it (`permission_review` names the command in `summary`).
   */
  progress?: { turn?: number; step: string; code?: string; params?: JsonObject };
  /** pi retries a failed request: which attempt of how many, after what error. */
  retry?: { attempt: number; maxAttempts: number; delayMs: number; error: string };
  /** The permission question mu announced (`permissions.request`), until its select dialog opens or it is resolved. */
  permission?: ViewPermission;
  compacting: boolean;
};

/**
 * One line of what the judgment layer and the run did, as the Jev panel reads it (the panel's `Activity`, by the same
 * names): one of the judgment layer's presentation frames (`permissions.request`, `board.update`, `memory.recalled`,
 * `goal.state`, `preflight.verdict`, …), or one of pi's events (`agent_start`, `agent_settled`, `compaction_start`,
 * `compaction_end`). A `decision` frame keeps only its record's id: the record is in `judgments`.
 */
export type ViewActivity = {
  /** `a1`, `a2`, …: numbered in the order the view took them, never reused. */
  id: string;
  kind: string;
  payload: JsonObject;
  /** In ms since the epoch: a frame's own time; for pi's events, the latest time the view had seen. */
  at: number;
  /** A frame's correlation: which judgment runtime, which of its turns, its place in that runtime's frames. */
  runtimeId?: string;
  turnId?: number;
  sequence?: number;
};

/**
 * What an extension said with `notify` (the answer to a command, a warning), as a line of the conversation after the
 * message it followed. A warning or an error is said once. `checkpoint_off` is mu's own notice that the session goes
 * without checkpoints, with its reason code and the numbers it names, for the app to word.
 */
export type ViewNotice = {
  /** `n1`, `n2`, … */
  id: string;
  level: 'info' | 'warning' | 'error';
  text: string;
  code?: 'checkpoint_off';
  reason?: string;
  params?: Record<string, number>;
  /** The message that was last when it came; none when it came before any. */
  after?: string;
};

/** What pi holds to send while a run goes (`queue_update`): steering goes in at the next step, follow-ups after. */
export type ViewQueue = { steering: string[]; followUp: string[] };

/** The session as pi last described it, in the answers to `get_state` and `get_session_stats` that any window asked. */
export type ViewSession = {
  /** `provider/id` of the model pi answers with; none while it has no usable model. */
  model?: string;
  thinkingLevel?: string;
  name?: string;
  /** pi's context usage: `tokens` (null right after a compaction), `contextWindow`, `percent`. */
  contextUsage?: JsonObject;
  compactionSettings?: JsonObject;
  autoCompaction?: boolean;
  /** The session's token counts (`get_session_stats`). */
  tokens?: JsonObject;
  /** What the session cost so far, in US dollars as pi prices its models (`get_session_stats`). */
  cost?: number;
  /** When the view took the latest report, in the latest time it had seen. */
  at: number;
};

/** What only a live host says, kept for as long as it runs: a view read from a file has none of it. */
export type ViewHost = {
  activity: ViewActivity[];
  notices: ViewNotice[];
  queue: ViewQueue;
  session?: ViewSession;
};

/**
 * The goal mu works towards (`/goal <condition>`: the agent keeps going until the condition holds), as mu last said
 * it: its latest `kyrn.goal` entry on the branch (live from `entry_appended`, in a file as it is), or a later
 * `goal.state` frame. The two say the same, except that a mu resuming a session whose goal was running says it
 * paused (a frame, no entry): a file read with no host says `active` there.
 */
export type ViewGoal = { status: 'active' | 'paused' | 'met' | 'cleared'; text: string };

export type NativeView = {
  messages: ViewMessage[];
  status: TurnStatus;
  /** Why the last run failed, when `status` is `error`. */
  error?: string;
  judgments: ViewJudgment[];
  dialogs: ViewDialog[];
  live: ViewLive;
  host: ViewHost;
  /** The goal mu works towards, once one was set in the session. */
  goal?: ViewGoal;
};

export const emptyHost = (): ViewHost => ({ activity: [], notices: [], queue: { steering: [], followUp: [] } });

export const emptyView = (): NativeView => ({
  messages: [],
  status: 'idle',
  judgments: [],
  dialogs: [],
  live: { compacting: false },
  host: emptyHost(),
});

/** The view without what only a live host says: what a session file gives as well. */
export const durable = (view: NativeView): NativeView => ({ ...view, host: emptyHost() });
