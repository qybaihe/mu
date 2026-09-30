/**
 * pi's RPC protocol as the app reads it (packages/coding-agent/src/modes/rpc/rpc-types.ts in the harness): the
 * commands the app sends, what their responses carry, and small readers for the records that come back.
 *
 * Records arrive as JSON from another process, so the reducer reads every field through these readers instead of
 * trusting a type. Imported by the main process (the host manager) and, later, the renderer: no Node APIs here.
 */

/** One record of pi's output: a response, a session event or an extension UI request. */
export type PiRecord = { type: string; [key: string]: unknown };

/** A JSON object whose fields are read defensively. */
export type JsonObject = Record<string, unknown>;

export const asObject = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
export const asText = (value: unknown): string => (typeof value === 'string' ? value : '');
export const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Whether a model pi names (in `get_state`, `set_model`, `cycle_model`) is one it can answer with. With none set up,
 * pi still runs, on its placeholder `unknown/unknown` (DEFAULT_MODEL in pi's agent), and every prompt fails.
 */
export function hasModel(model: unknown): boolean {
  const { provider, id } = asObject(model);
  return (
    typeof provider === 'string' &&
    typeof id === 'string' &&
    provider !== '' &&
    id !== '' &&
    !(provider === 'unknown' && id === 'unknown')
  );
}

/** An image as pi carries it: base64 data and its media type. */
export type PiImage = { type: 'image'; data: string; mimeType: string };

export type QueueMode = 'all' | 'one-at-a-time';

/** What the app can ask pi. The host manager adds the `id` that pairs a command with its response. */
export type PiCommand =
  | { type: 'prompt'; message: string; images?: PiImage[]; streamingBehavior?: 'steer' | 'followUp' }
  | { type: 'steer'; message: string; images?: PiImage[] }
  | { type: 'follow_up'; message: string; images?: PiImage[] }
  | { type: 'abort' }
  | { type: 'clear_queue' }
  | { type: 'new_session'; parentSession?: string }
  | { type: 'get_state' }
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'cycle_model' }
  | { type: 'get_available_models' }
  | { type: 'set_thinking_level'; level: string }
  | { type: 'cycle_thinking_level' }
  | { type: 'get_available_thinking_levels' }
  | { type: 'set_steering_mode'; mode: QueueMode }
  | { type: 'set_follow_up_mode'; mode: QueueMode }
  | { type: 'compact'; customInstructions?: string }
  | { type: 'set_auto_compaction'; enabled: boolean }
  | { type: 'set_auto_retry'; enabled: boolean }
  | { type: 'abort_retry' }
  | { type: 'bash'; command: string; excludeFromContext?: boolean }
  | { type: 'abort_bash' }
  | { type: 'get_session_stats' }
  | { type: 'export_html'; outputPath?: string }
  | { type: 'switch_session'; sessionPath: string }
  | { type: 'fork'; entryId: string }
  | { type: 'clone' }
  | { type: 'get_fork_messages' }
  | { type: 'get_entries'; since?: string }
  | { type: 'get_tree' }
  | { type: 'get_last_assistant_text' }
  | { type: 'set_session_name'; name: string }
  | { type: 'get_messages' }
  | { type: 'get_commands' };

export type PiCommandType = PiCommand['type'];

/** `get_state`: the session as pi runs it now. */
export type PiSessionState = {
  model?: { provider: string; id: string; [key: string]: unknown };
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  contextUsage?: unknown;
  compactionSettings?: unknown;
  messageCount: number;
  pendingMessageCount: number;
};

/** One entry of a pi session file (its header, `type: "session"`, is not one). */
export type PiEntry = { type: string; id: string; parentId: string | null; timestamp: string; [key: string]: unknown };

/** What a successful response carries, by command. Commands not listed carry data the app does not read yet. */
export type PiResponseData = {
  prompt: undefined;
  steer: undefined;
  follow_up: undefined;
  abort: undefined;
  abort_retry: undefined;
  abort_bash: undefined;
  set_model: JsonObject;
  /** null when there is no other model to cycle to. */
  cycle_model: { model: JsonObject; thinkingLevel: string; isScoped: boolean } | null;
  set_thinking_level: undefined;
  set_steering_mode: undefined;
  set_follow_up_mode: undefined;
  set_auto_compaction: undefined;
  set_auto_retry: undefined;
  set_session_name: undefined;
  clear_queue: { steering: string[]; followUp: string[] };
  new_session: { cancelled: boolean };
  switch_session: { cancelled: boolean };
  clone: { cancelled: boolean };
  fork: { text: string; cancelled: boolean };
  get_state: PiSessionState;
  get_entries: { entries: PiEntry[]; leafId: string | null };
  get_messages: { messages: unknown[] };
  get_tree: { tree: unknown[]; leafId: string | null };
  get_fork_messages: { messages: { entryId: string; text: string }[] };
  get_last_assistant_text: { text: string | null };
  get_available_models: { models: JsonObject[] };
  get_available_thinking_levels: { levels: string[] };
};

export type PiResponseDataOf<T extends PiCommandType> = T extends keyof PiResponseData ? PiResponseData[T] : unknown;

/** The extension UI requests that wait for an answer: a dialog. */
export const DIALOG_METHODS = ['select', 'confirm', 'input', 'editor'] as const;
export type DialogMethod = (typeof DIALOG_METHODS)[number];

/** The app's answer to a dialog, as pi's `extension_ui_response` carries it after `type` and `id`. */
export type DialogAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };
