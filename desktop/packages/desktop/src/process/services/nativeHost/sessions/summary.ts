import { asList, asNumber, asObject, asText, type JsonObject } from '../../../../common/utils/nativeHost/records.ts';
import { withoutHostPreamble } from '../../../../common/utils/nativeHost/words.ts';

/**
 * What the conversation list shows of a pi session, from lines of its file (session-format.md in the harness): the
 * header's id, project and time, the latest `session_info` name, the first user message and the latest message time.
 * No I/O here: SessionStore decides which lines are read.
 */

/** How many characters of the first user message make a title. */
export const TITLE_LENGTH = 100;

/** The first line of a session file. */
export type SessionHeader = {
  id: string;
  cwd: string;
  /** Milliseconds since the epoch; NaN when the header's time does not parse. */
  timestamp: number;
  /** The session this one was forked or cloned from. */
  parentSession?: string;
};

export type SessionSummary = {
  header: SessionHeader;
  /** The latest `session_info` name read; undefined when there is none, or the latest one cleared it. */
  name?: string;
  /** The first user message's text, once read. */
  firstMessage?: string;
  /** The latest user or assistant message time read. */
  lastActivity?: number;
  /** The `message` entries read (every role, as pi's session list counts them). */
  messageCount?: number;
};

/** One line of a session file as an entry, or undefined when it is not one (a partial or corrupt line). */
export function parseEntry(line: string): JsonObject | undefined {
  if (!line.trim()) return undefined;
  try {
    const entry = asObject(JSON.parse(line));
    return typeof entry.type === 'string' ? entry : undefined;
  } catch {
    return undefined;
  }
}

/** The header an entry is, or undefined when it is none (the file is then no session). */
export function readHeader(entry: JsonObject | undefined): SessionHeader | undefined {
  if (!entry || entry.type !== 'session' || typeof entry.id !== 'string' || !entry.id) return undefined;
  return {
    id: entry.id,
    cwd: asText(entry.cwd),
    timestamp: typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN,
    ...(typeof entry.parentSession === 'string' && entry.parentSession ? { parentSession: entry.parentSession } : {}),
  };
}

/** A message's text as pi's session list takes it: a string, or its text blocks joined. */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  return asList(content)
    .map(asObject)
    .filter((block) => block.type === 'text')
    .map((block) => asText(block.text))
    .join(' ');
}

/**
 * Folds one more entry (after the header) into a summary, which is changed in place. `firstMessage`: a user message
 * may be the first one (every line before it was read). Returns the entry's message time, for a user or an assistant
 * message.
 */
export function addEntry(
  summary: SessionSummary,
  entry: JsonObject,
  options: { firstMessage: boolean }
): number | undefined {
  if (entry.type === 'session_info') {
    // The latest wins, an empty one included: it clears the name.
    summary.name = asText(entry.name).trim() || undefined;
    return undefined;
  }
  if (entry.type !== 'message') return undefined;
  summary.messageCount = (summary.messageCount ?? 0) + 1;
  const message = asObject(entry.message);
  if (message.role !== 'user' && message.role !== 'assistant') return undefined;
  if (message.role === 'user' && options.firstMessage && summary.firstMessage === undefined) {
    const text = messageText(message.content);
    if (text.trim()) summary.firstMessage = text;
  }
  const time =
    asNumber(message.timestamp) ?? (typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN);
  if (!Number.isFinite(time)) return undefined;
  summary.lastActivity = Math.max(summary.lastActivity ?? time, time);
  return time;
}

/**
 * Files the person attached with `@"path"`, `@'path'` or `@path` (a name with a `/` or a `.` in it: `@claude` is a
 * handle, not a file) at the start of a message: not what they said.
 */
const LEADING_MENTIONS = /^(?:@(?:"[^"]*"|'[^']*'|[^\s"']*[/.]\S*)\s+)+/;

/**
 * Keys and tokens as tools hand them out (and private keys as ssh does), each with the part to keep. A title is shown in the sidebar, the palette, a
 * notification and a screenshot, so a message that opens with a pasted token must not put the token there. (A `\` may
 * sit before the `_` of a token copied out of markdown.)
 */
const SECRETS: readonly (readonly [RegExp, string])[] = [
  // A private key pasted in: everything after its header, to the end line or, when there is none, to the end of the text.
  [
    /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----)[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    '$1',
  ],
  [/\b(gh[pousr]\\?_)[A-Za-z0-9]{20,}/g, '$1'],
  [/\b(github_pat_)[A-Za-z0-9_]{20,}/g, '$1'],
  [/\b(sk-(?:ant-|proj-|or-v1-)?)(?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{20,}/g, '$1'],
  [/\b(AIza)[0-9A-Za-z_-]{30,}/g, '$1'],
  [/\b(AKIA)[0-9A-Z]{16}\b/g, '$1'],
  [/\b(xox[abprs]-)[A-Za-z0-9-]{10,}/g, '$1'],
  [/\b(eyJ)[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '$1'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi, '$1'],
];

/** The text with the tokens in it masked: what a token starts with stays, the rest becomes `••••`. */
export function maskSecrets(text: string): string {
  return SECRETS.reduce((masked, [pattern, keep]) => masked.replace(pattern, `${keep}••••`), text);
}

/**
 * The start of a message as a title: its first line with text, spaces collapsed, at most TITLE_LENGTH characters. A
 * host's preamble and the files attached in front of the message are left out (when nothing else is left, they are the
 * title), and a token in it is masked.
 */
export function clip(text: string): string {
  const said = withoutHostPreamble(text);
  const words = said.replace(LEADING_MENTIONS, '');
  const line = maskSecrets(words.trim() ? words : said)
    .split(/\r?\n/)
    .map((each) => each.replace(/\s+/g, ' ').trim())
    .find(Boolean);
  if (!line) return '';
  const characters = Array.from(line);
  return characters.length > TITLE_LENGTH ? characters.slice(0, TITLE_LENGTH).join('').trimEnd() : line;
}

/**
 * What the list shows for a session: its name (whoever wrote it: the person, or a tool from the first message it read,
 * which may have been a pasted token), else the start of its first user message, else ''.
 */
export const titleFrom = (name: string | undefined, firstMessage: string | undefined): string =>
  name !== undefined ? maskSecrets(name) : clip(firstMessage ?? '');

export const titleOf = (summary: Pick<SessionSummary, 'name' | 'firstMessage'>): string =>
  titleFrom(summary.name, summary.firstMessage);
