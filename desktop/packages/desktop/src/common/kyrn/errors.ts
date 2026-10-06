/**
 * Failures the main process reports to mu's screens. The message stays plain English, for logs and tests; a screen
 * shows the translated text for the code (`mu.errors.*`, mapped in `renderer/pages/settings/KyrnSettings/fields/
 * muError.ts`), and at most the raw message as a secondary detail. Codes are stable: add one, never rename one.
 */
export const KYRN_ERROR_CODES = [
  /** The files changed since they were loaded. */
  'stale',
  /** The context cap is out of range. Params: `min`, `max`. */
  'contextLimit',
  /** A key contains characters a key cannot have. */
  'credential',
  /** A judge names a variable no judge key may live in. Params: `name`. */
  'keyVariable',
  /** Two providers of one save map to the same key variable. Params: `providers` (ids). */
  'sharedKey',
  /** A startup provider without a model, or a model without a provider. */
  'pickBoth',
  /** models.json does not parse, so providers cannot be saved. */
  'modelsUnreadable',
  /** models.json has comments, which a save would remove. */
  'modelsCommented',
  /** An address a key must not be sent to. */
  'endpoint',
  /** A judge keyed for a service other than TypeSafe has no address of its own to send the key to. Params: `name`. */
  'judgeEndpoint',
  /** The harness has no manifest, so decisions and features cannot be saved. */
  'harnessOld',
  /** A feature option has a value it cannot take. Params: `feature`, `option`, `problem` (an `OptionProblem`). */
  'optionValue',
  /** A configuration file is not valid JSON. Params: `file` (its path). */
  'invalidJson',
  /** A configuration file exists but cannot be read. Params: `file` (its path). */
  'unreadable',
  /** A configuration file cannot be written (permissions, a full disk). Params: `file` (its path). */
  'unwritable',
  /** The health check says the mu runtime is not online. */
  'runtimeOffline',
  /** Another command is registered under mu's name. */
  'otherRegistration',
  /**
   * mu's launcher cannot be registered from where the app is installed (Windows): its path has spaces, which a command
   * the backend runs cannot have, it has no short name without them, and no launcher forwarding to it could be written.
   */
  'installPath',
  /** The local backend answered with an HTTP error. Params: `status`. */
  'backend',
  /** This mu cannot import Claude Code or Codex conversations: it is older than `mu import`. */
  'importMissing',
  /** `mu import` failed or answered with something else than its JSON: the message says what it printed. */
  'importFailed',
  /** The folder chosen as a skill has no SKILL.md with a description. */
  'skillInvalid',
  /** A skill's name cannot be a folder name (lowercase letters, digits and hyphens). Params: `name`. */
  'skillName',
  /** mu already has a skill of that name. Params: `name`. */
  'skillExists',
  /** The folder chosen as a skill holds far more files than a skill would. */
  'skillTooLarge',
  /** No skill or MCP server of that name is in the list. Params: `name`. */
  'notFound',
  /**
   * The skill or MCP server comes from somewhere mu does not change (Claude Code, Codex, Cursor, a folder agents
   * share, mu itself). Params: `name`, `source` (a `SkillSource` or `McpSource`).
   */
  'notMine',
  /** An MCP server's name has characters other than letters, digits, `_` and `-`. Params: `name`. */
  'mcpName',
  /** mu already has an MCP server of that name. Params: `name`. */
  'mcpExists',
  /** An MCP server's command, address, variables or headers are not usable. Params: `field`. */
  'mcpInvalid',
  /** A value the screen never sends: the message says which. */
  'invalid',
  'unknown',
] as const;
export type KyrnErrorCode = (typeof KYRN_ERROR_CODES)[number];
export const isKyrnErrorCode = (value: unknown): value is KyrnErrorCode =>
  KYRN_ERROR_CODES.includes(value as KyrnErrorCode);

export type KyrnErrorParams = Record<string, string | number | string[]>;

/** Thrown in the main process; `kyrnBridge` passes the code and params on to the renderer, and `unwrap` rethrows it. */
export class KyrnError extends Error {
  readonly code: KyrnErrorCode;
  readonly params: KyrnErrorParams;
  constructor(code: KyrnErrorCode, message: string, params: KyrnErrorParams = {}) {
    super(message);
    this.code = code;
    this.params = params;
  }
}

/** What a failed bridge call answers: the plain message, and the code the screen translates. */
export type KyrnFailure = { ok: false; error: string; code?: KyrnErrorCode; params?: KyrnErrorParams };
export type KyrnResult<T> = { ok: true; data: T } | KyrnFailure;

/** `BackendHttpError` (common/adapter/httpBridge) by its shape, so this module stays free of imports. */
function backendStatus(error: unknown): { status: number; message: string } | undefined {
  if (!(error instanceof Error) || error.name !== 'BackendHttpError') return undefined;
  const { status, backendMessage } = error as Error & { status?: unknown; backendMessage?: unknown };
  if (typeof status !== 'number') return undefined;
  return { status, message: typeof backendMessage === 'string' && backendMessage ? backendMessage : error.message };
}

/**
 * A failure as the renderer gets it: a stable code it translates, and the plain message as the detail. The backend's
 * own message stands in for its long "Backend GET … failed (500): {…}" line.
 */
export function kyrnFailure(error: unknown): KyrnFailure {
  if (error instanceof KyrnError) return { ok: false, error: error.message, code: error.code, params: error.params };
  const backend = backendStatus(error);
  if (backend) return { ok: false, error: backend.message, code: 'backend', params: { status: backend.status } };
  return { ok: false, error: error instanceof Error ? error.message : String(error), code: 'unknown' };
}
