/**
 * Why an update step failed. The main process puts this code in the update state (the raw message goes to the log);
 * the renderer shows the translated `update.errors.*` sentence for it, in the current app language.
 */
export type UpdateErrorCode =
  /** The update server could not be reached (offline, DNS, refused, reset…). */
  | 'network'
  /** The update server did not answer in time. */
  | 'timeout'
  /**
   * The newest release cannot update this system automatically: its update feed or update file answers 404 (a
   * release built without them, or without this architecture). Shown beside the offer of the release's installer.
   */
  | 'noUpdateInfo'
  /** The update server answered with an HTTP error (`status`). */
  | 'serverError'
  /** The update information could not be read. */
  | 'invalidMetadata'
  /** A check failed for another reason. */
  | 'checkFailed'
  /** The update or its installer could not be downloaded, a download the host allowlist refused included. */
  | 'downloadFailed'
  /** The downloaded update could not be handed over to be installed. */
  | 'prepareInstallFailed'
  /** macOS did not get the downloaded update ready in time. */
  | 'prepareInstallTimeout';

export type UpdateErrorInfo = {
  code: UpdateErrorCode;
  /** HTTP status, for `serverError`. */
  status?: number;
};

/** An error that already knows its code; its message is the plain English detail for logs. */
export class UpdateError extends Error {
  readonly info: UpdateErrorInfo;

  constructor(info: UpdateErrorInfo, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UpdateError';
    this.info = info;
  }
}

const NETWORK_PATTERN =
  /net::ERR_|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ECONNABORTED|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EPIPE|fetch failed|socket hang up|getaddrinfo|network (?:error|is unreachable)/i;
// Checked before NETWORK_PATTERN: Chromium's net::ERR_TIMED_OUT and net::ERR_CONNECTION_TIMED_OUT are timeouts.
const TIMEOUT_PATTERN = /AbortError|ETIMEDOUT|ESOCKETTIMEDOUT|_TIMED_OUT|timed? ?out/i;
const HTTP_STATUS_PATTERN = /HttpError:\s*(\d{3})|status(?:Code)?[ :=]+(\d{3})/i;

/** Everything an error says about itself, including the causes Node's fetch hides the real reason in. */
function describe(error: unknown, depth = 0): string {
  if (depth > 4 || error === null || error === undefined) return '';
  if (typeof error !== 'object') return String(error);
  const { name, message, code, cause } = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    cause?: unknown;
  };
  const own = [name, code, message].filter((part) => typeof part === 'string').join(' ');
  return `${own} ${describe(cause, depth + 1)}`.trim();
}

/**
 * The code for any error an update step can meet (our own UpdateError, electron-updater's, Node's fetch). `fallback`
 * names the step that failed, for an error that says nothing more specific.
 */
export function classifyUpdateError(error: unknown, fallback: UpdateErrorCode): UpdateErrorInfo {
  if (error instanceof UpdateError) return error.info;
  const text = describe(error);
  const statusMatch = HTTP_STATUS_PATTERN.exec(text);
  const status = statusMatch ? Number(statusMatch[1] ?? statusMatch[2]) : undefined;
  if (status === 404) return { code: 'noUpdateInfo' };
  if (TIMEOUT_PATTERN.test(text)) return { code: 'timeout' };
  if (NETWORK_PATTERN.test(text)) return { code: 'network' };
  // electron-updater wraps every channel-file failure in "Cannot find channel …": only now, with network and
  // timeout ruled out, does it mean the file is missing.
  if (/Cannot find (?:channel )?"?[\w.-]+\.ya?ml/i.test(text)) return { code: 'noUpdateInfo' };
  if (status !== undefined && status >= 400) return { code: 'serverError', status };
  return { code: fallback };
}

/** The raw message of an error, for logs. */
export function updateErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
