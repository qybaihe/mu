/**
 * Bringing Claude Code and Codex conversations into the app (see common/kyrn/importChats.ts).
 *
 * The harness does the reading and the writing: `mu import --list --json` finds the transcripts on this computer and
 * `mu import --json <file>…` writes each one as a mu session. This module runs that command the way the app runs mu
 * (its launcher, through `launchCommand`), makes every imported session an app conversation in its project folder,
 * and leaves the conversation a record: `<mu home>/acp-sessions/imports/<conversation>.json`, which names the session
 * file. The adapter reads it when the conversation starts for the first time and opens that file instead of a new
 * session (`KyrnAgent.newSession`). The record stays, marked with the adapter session that took the file: a
 * conversation that is reset later starts afresh, and the list knows which transcripts already have a conversation.
 */
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { KyrnError } from '../../../common/kyrn/errors';
import {
  IMPORT_EXTRA_KEY,
  IMPORT_TOOL_NAMES,
  isImportTool,
  type FoundChat,
  type ImportedHistory,
  type ImportedHistoryItem,
  type ImportFailure,
  type ImportList,
  type ImportOutcome,
  type ImportTool,
} from '../../../common/kyrn/importChats';
import { launcherOf, type Harness } from './harness';
import { array, asRecord, launchCommand, text } from './piRpc';
import type { BackendRequest } from './product';

// ---------------------------------------------------------------------------------------------------------------
// Running `mu import`
// ---------------------------------------------------------------------------------------------------------------

/**
 * The file `mu import` runs, where the harness's launcher looks for it (`planImport` in `kyrn/bin/mu.mjs`): the
 * sources of a checkout, or the built layer of the npm package. A mu without it is older than the command, and its
 * launcher would take `import` for a message to the model.
 */
export function importEntryOf(harness: Pick<Harness, 'root' | 'layout'>, platform: NodeJS.Platform): string {
  const { join } = platform === 'win32' ? path.win32 : path.posix;
  return harness.layout === 'package'
    ? join(harness.root, 'judge', 'dist', 'import.js')
    : join(harness.root, 'packages', 'kyrn-judge', 'src', 'import', 'cli.ts');
}

/** What `mu import` printed, whatever its exit code: it answers in JSON also when a transcript failed. */
export type CliOutput = { code: number | null; stdout: string; stderr: string };

/** Runs `mu import <args>`. */
export type ImportCli = (args: string[], timeoutMs: number) => Promise<CliOutput>;

const MAX_STDOUT = 64 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;

/** One run of a command without a shell, so nothing in a path is ever read as a command. */
export function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env
): Promise<CliOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outSize = 0;
    let errSize = 0;
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
    };
    const fail = (message: string): void => {
      child.kill('SIGKILL');
      finish(() => reject(new KyrnError('importFailed', message)));
    };
    const timer = setTimeout(() => fail('mu import did not finish in time'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      outSize += chunk.length;
      if (outSize > MAX_STDOUT) return fail('mu import printed more than it ever should');
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errSize >= MAX_STDERR) return;
      errSize += chunk.length;
      err.push(chunk);
    });
    child.on('error', (error) =>
      finish(() => reject(new KyrnError('importFailed', `mu import did not start: ${error.message}`)))
    );
    child.on('close', (code) =>
      finish(() =>
        resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
      )
    );
  });
}

export type ImportCliDeps = {
  platform?: NodeJS.Platform;
  exists?: (file: string) => boolean;
  run?: (command: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv) => Promise<CliOutput>;
};

/**
 * `mu import` through mu's launcher, started as the adapter and the sign-in start mu (`launchCommand`): the bash
 * forwarder of a checkout picks its own Node; the Node launcher (Windows, the npm package, the copy inside the
 * packaged app) runs on `MU_NODE` or on the app's own binary as Node.
 */
export function importCli(harness: Pick<Harness, 'root' | 'layout'>, deps: ImportCliDeps = {}): ImportCli {
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? existsSync;
  const run = deps.run ?? runCommand;
  return async (args, timeoutMs) => {
    const entry = importEntryOf(harness, platform);
    if (!exists(entry)) throw new KyrnError('importMissing', `This mu has no import command: ${entry} is missing`);
    const start = launchCommand(launcherOf(harness, platform), ['import', ...args]);
    return run(start.command, start.args, timeoutMs, { ...process.env, ...start.env });
  };
}

/** The list under `key` of what `mu import --json` printed; anything else is a failure that shows what it said. */
function cliList(output: CliOutput, key: 'conversations' | 'results'): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.stdout);
  } catch {
    parsed = undefined;
  }
  const list = asRecord(parsed)[key];
  if (Array.isArray(list)) return list;
  const said = (output.stderr.trim() || output.stdout.trim()).split('\n').slice(-8).join('\n');
  throw new KyrnError('importFailed', said || `mu import ended with code ${output.code ?? 'none'}`);
}

/** One conversation of the list, as far as it is well formed. */
export function parseFound(value: unknown): FoundChat | undefined {
  const row = asRecord(value);
  const file = text(row.path);
  if (!isImportTool(row.tool) || !file) return undefined;
  const cwd = text(row.cwd);
  const importedAs = text(row.importedAs);
  return {
    tool: row.tool,
    path: file,
    ...(cwd ? { cwd } : {}),
    title: text(row.title),
    modified: text(row.modified),
    size: typeof row.size === 'number' && Number.isFinite(row.size) ? row.size : 0,
    ...(importedAs ? { importedAs } : {}),
  };
}

/** The harness's reasons (`importTranscripts` in the MU repository) as the codes the screen translates. */
const HARNESS_FAILURES: Record<string, ImportFailure> = {
  'no such file': 'missing',
  'not a file': 'notFile',
  'not a Claude Code or Codex transcript': 'notTranscript',
  'no messages in this transcript': 'empty',
};

// ---------------------------------------------------------------------------------------------------------------
// The records the adapter reads
// ---------------------------------------------------------------------------------------------------------------

/** An app conversation made from an imported session. */
export type ImportRecord = {
  version: 1;
  /** The mu session file the conversation goes on with. */
  file: string;
  /** Its project folder with links resolved: the adapter holds it against the conversation's. */
  cwd: string;
  tool: ImportTool;
  /** The transcript it was made from. */
  source: string;
  /** The adapter session that opened the file, once one has: a later new session starts afresh. */
  session?: string;
};

/** The ids the backend gives conversations; anything else never becomes part of a path. */
export const isConversationId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);

export const importRecordsDir = (store: string): string => path.join(store, 'imports');

const recordFile = (store: string, conversationId: string): string =>
  path.join(importRecordsDir(store), `${conversationId}.json`);

export function parseImportRecord(value: unknown): ImportRecord | undefined {
  const row = asRecord(value);
  const file = text(row.file);
  const cwd = text(row.cwd);
  if (row.version !== 1 || !file || !cwd || !isImportTool(row.tool)) return undefined;
  const session = text(row.session);
  return { version: 1, file, cwd, tool: row.tool, source: text(row.source), ...(session ? { session } : {}) };
}

/** The record of a conversation; undefined for a conversation that was not imported, or a record that is broken. */
export function readImportRecord(store: string, conversationId: string): ImportRecord | undefined {
  if (!isConversationId(conversationId)) return undefined;
  try {
    return parseImportRecord(JSON.parse(readFileSync(recordFile(store, conversationId), 'utf8')));
  } catch {
    return undefined;
  }
}

export function writeImportRecord(store: string, conversationId: string, record: ImportRecord): void {
  if (!isConversationId(conversationId)) throw new KyrnError('invalid', 'Invalid conversation');
  const file = recordFile(store, conversationId);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

export function listImportRecords(store: string): { conversationId: string; record: ImportRecord }[] {
  let names: string[];
  try {
    names = readdirSync(importRecordsDir(store));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const conversationId = name.endsWith('.json') ? name.slice(0, -'.json'.length) : '';
    const record = readImportRecord(store, conversationId);
    return record ? [{ conversationId, record }] : [];
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Imported sessions
// ---------------------------------------------------------------------------------------------------------------

/** What the harness wrote at the top of an imported session: its folder, its name and what came along. */
export type ImportedSession = {
  /** The session's id (its header's), by which the native host knows the conversation. */
  id: string;
  cwd: string;
  name: string;
  tool: ImportTool;
  source: string;
  user: number;
  assistant: number;
  toolCalls: number;
  /** The session's entries the import wrote; the lines after them are the conversation going on in mu. */
  entries: number;
};

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

const parseLine = (line: string | undefined): Record<string, unknown> => {
  try {
    return asRecord(JSON.parse(line ?? ''));
  } catch {
    return {};
  }
};

/** The first bytes of a file as lines; the last one may be cut. */
function headLines(file: string, limit: number): string[] {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    const read = readSync(fd, buffer, 0, limit, 0);
    return buffer.subarray(0, read).toString('utf8').split('\n');
  } finally {
    closeSync(fd);
  }
}

/**
 * The top of a session `mu import` wrote: the header, the marker naming its origin (`mu.import`), the name. Undefined
 * for a file that is not one.
 */
export function readImportedSession(file: string): ImportedSession | undefined {
  let lines: string[];
  try {
    lines = headLines(file, 256 * 1024);
  } catch {
    return undefined;
  }
  const [header, marker, info] = lines.slice(0, 3).map(parseLine);
  const cwd = text(header.cwd);
  if (header.type !== 'session' || !cwd) return undefined;
  if (marker.type !== 'custom_message' || marker.customType !== 'mu.import') return undefined;
  const origin = asRecord(marker.details);
  if (!isImportTool(origin.tool)) return undefined;
  const counts = asRecord(origin.counts);
  return {
    id: text(header.id),
    cwd,
    name: info.type === 'session_info' ? text(info.name) : '',
    tool: origin.tool,
    source: text(origin.source),
    user: count(counts.user),
    assistant: count(counts.assistant),
    toolCalls: count(counts.toolCalls),
    entries: count(counts.entries),
  };
}

/** Steps of an imported conversation the app reads back at most, and characters of one. */
export const HISTORY_ITEMS = 400;
export const HISTORY_TEXT = 4000;

const clip = (value: string): string =>
  value.length > HISTORY_TEXT ? `${value.slice(0, HISTORY_TEXT).trimEnd()} …` : value;

/** The text of a message's content: a string, or its text parts. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  return array(content)
    .map(asRecord)
    .filter((part) => part.type === 'text')
    .map((part) => text(part.text))
    .join('\n')
    .trim();
}

/**
 * The part of a session the import wrote, as steps to read: what the person said, what came back up to their next
 * message (answers joined, the tools in order), and each compaction's summary. Tool results and the notes kept for
 * the model only are left out. The last {@link HISTORY_ITEMS} steps are kept.
 */
export function readImportedHistory(file: string): ImportedHistory {
  const session = readImportedSession(file);
  if (!session) throw new KyrnError('importFailed', `Not a session mu import wrote: ${file}`);
  const lines = readFileSync(file, 'utf8').split('\n');
  // The header, then the entries the import wrote; a session from before the count was kept is read whole.
  const end = session.entries > 0 ? Math.min(lines.length, session.entries + 1) : lines.length;
  const items: ImportedHistoryItem[] = [];
  for (let index = 1; index < end; index++) {
    const entry = parseLine(lines[index]);
    if (entry.type === 'compaction') {
      const summary = text(entry.summary).trim();
      if (summary) items.push({ kind: 'summary', text: summary });
      continue;
    }
    if (entry.type !== 'message') continue;
    const message = asRecord(entry.message);
    const said = contentText(message.content);
    if (message.role === 'user') {
      if (said) items.push({ kind: 'user', text: said });
      continue;
    }
    if (message.role !== 'assistant') continue;
    const tools = array(message.content)
      .map(asRecord)
      .filter((part) => part.type === 'toolCall')
      .map((part) => text(part.name))
      .filter(Boolean);
    const previous = items.at(-1);
    if (previous?.kind === 'assistant') {
      if (said) previous.text = previous.text ? `${previous.text}\n\n${said}` : said;
      previous.tools.push(...tools);
    } else if (said || tools.length > 0) items.push({ kind: 'assistant', text: said, tools });
  }
  const earlier = Math.max(0, items.length - HISTORY_ITEMS);
  const kept = items.slice(earlier);
  for (const item of kept) item.text = clip(item.text);
  return { tool: session.tool, source: session.source, items: kept, earlier };
}

// ---------------------------------------------------------------------------------------------------------------
// The service the bridge answers with
// ---------------------------------------------------------------------------------------------------------------

export type ImportServiceDeps = {
  cli: ImportCli;
  /** The local backend. A conversation that is gone answers 404. */
  request: BackendRequest;
  /** `<mu home>/acp-sessions`, the adapter's records; the import records live in it too. */
  store: string;
  /** The assistant new mu conversations are made with. */
  assistant: () => Promise<string>;
  /** Whether a folder exists; its path with links resolved. */
  folder?: { exists: (dir: string) => boolean; real: (dir: string) => string };
};

export type ImportService = {
  /** `native`: the app runs mu itself, and a mu session is a conversation of its own. */
  list(cwd?: string, native?: boolean): Promise<ImportList>;
  run(paths: string[], locale: string, native?: boolean): Promise<ImportOutcome[]>;
  history(conversationId: string): Promise<ImportedHistory>;
};

const LIST_TIMEOUT = 2 * 60 * 1000;
/** A rollout can be a gigabyte; a hundred of them take a while. */
const RUN_TIMEOUT = 30 * 60 * 1000;
/** Transcripts one import takes at most. */
export const MAX_IMPORT = 500;

const isNotFound = (error: unknown): boolean =>
  error instanceof Error && (error as Error & { status?: unknown }).status === 404;

const defaultFolder = {
  exists: (dir: string): boolean => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  },
  real: (dir: string): string => {
    try {
      return realpathSync(dir);
    } catch {
      return dir;
    }
  },
};

export function importService(deps: ImportServiceDeps): ImportService {
  const folder = deps.folder ?? defaultFolder;

  /**
   * The app conversation that holds a session, if one still does: the records say which were made for it, the backend
   * which of them still exist. One lookup per conversation and call; a conversation made in this call is known.
   */
  const holderOf = (records: { conversationId: string; record: ImportRecord }[]) => {
    const seen = new Map<string, { conversationId: string; name: string } | undefined>();
    const find = async (file: string): Promise<{ conversationId: string; name: string } | undefined> => {
      for (const { conversationId, record } of records) {
        if (record.file !== file) continue;
        if (!seen.has(conversationId)) {
          try {
            // eslint-disable-next-line no-await-in-loop
            const conversation = asRecord(await deps.request('GET', `/api/conversations/${conversationId}`));
            seen.set(conversationId, { conversationId, name: text(conversation.name) });
          } catch (error) {
            if (!isNotFound(error)) throw error;
            seen.set(conversationId, undefined);
          }
        }
        const found = seen.get(conversationId);
        if (found) return found;
      }
      return undefined;
    };
    const made = (conversationId: string, name: string, record: ImportRecord): void => {
      records.push({ conversationId, record });
      seen.set(conversationId, { conversationId, name });
    };
    return { find, made };
  };

  const list = async (cwd?: string, native = false): Promise<ImportList> => {
    if (cwd !== undefined && (typeof cwd !== 'string' || !path.isAbsolute(cwd)))
      throw new KyrnError('invalid', 'Invalid folder');
    const output = await deps.cli(['--list', '--json', ...(cwd ? ['--cwd', cwd] : [])], LIST_TIMEOUT);
    const conversations = cliList(output, 'conversations')
      .map(parseFound)
      .filter((chat): chat is FoundChat => chat !== undefined);
    if (native) {
      // The session made from it is the conversation, while its file is there.
      for (const chat of conversations) {
        const id = chat.importedAs ? readImportedSession(chat.importedAs)?.id : undefined;
        if (id) Object.assign(chat, { conversationId: id, native: true });
      }
      return { conversations };
    }
    const holder = holderOf(listImportRecords(deps.store));
    for (const chat of conversations) {
      if (!chat.importedAs) continue;
      // eslint-disable-next-line no-await-in-loop
      const held = await holder.find(chat.importedAs);
      if (held) chat.conversationId = held.conversationId;
    }
    return { conversations };
  };

  /** A new app conversation for an imported session, and the record that hands it the session. */
  const conversationFor = async (
    source: string,
    file: string,
    locale: string,
    assistant: () => Promise<string>
  ): Promise<{ outcome: ImportOutcome; record?: ImportRecord }> => {
    const failed = (reason: ImportFailure, detail: string) => ({
      outcome: { status: 'failed', source, reason, detail } as const,
    });
    const session = readImportedSession(file);
    if (!session) return failed('other', `mu import wrote no session at ${file}`);
    if (!folder.exists(session.cwd)) return failed('folderMissing', session.cwd);
    const name = session.name || IMPORT_TOOL_NAMES[session.tool];
    const created = asRecord(
      await deps.request('POST', '/api/conversations', {
        name,
        assistant: { id: await assistant(), locale },
        extra: {
          workspace: session.cwd,
          custom_workspace: true,
          [IMPORT_EXTRA_KEY]: {
            tool: session.tool,
            source: session.source || source,
            user: session.user,
            assistant: session.assistant,
            toolCalls: session.toolCalls,
          },
        },
      })
    );
    const conversationId = text(created.id);
    if (!isConversationId(conversationId)) return failed('other', 'The app made no conversation');
    const record: ImportRecord = {
      version: 1,
      file,
      cwd: folder.real(session.cwd),
      tool: session.tool,
      source: session.source || source,
    };
    writeImportRecord(deps.store, conversationId, record);
    return { outcome: { status: 'imported', source, tool: session.tool, conversationId, name }, record };
  };

  /**
   * With the native host on, the session `mu import` wrote is the conversation: it is listed with mu's others, and no
   * app conversation is made. Its folder must still exist, as a conversation runs in it.
   */
  const nativeOutcome = (result: Record<string, unknown>, source: string, file: string): ImportOutcome => {
    const session = readImportedSession(file);
    if (!session?.id)
      return { status: 'failed', source, reason: 'other', detail: `mu import wrote no session at ${file}` };
    if (!folder.exists(session.cwd)) return { status: 'failed', source, reason: 'folderMissing', detail: session.cwd };
    const name = session.name || IMPORT_TOOL_NAMES[session.tool];
    return result.status === 'already-imported'
      ? { status: 'listed', source, conversationId: session.id, name, native: true }
      : { status: 'imported', source, tool: session.tool, conversationId: session.id, name, native: true };
  };

  const run = async (paths: string[], locale: string, native = false): Promise<ImportOutcome[]> => {
    if (
      !Array.isArray(paths) ||
      paths.length === 0 ||
      paths.length > MAX_IMPORT ||
      !paths.every((file) => typeof file === 'string' && path.isAbsolute(file) && !file.includes('\0'))
    )
      throw new KyrnError('invalid', 'Invalid transcripts');
    // The language the assistant's snapshot is taken in, as the home page passes it; a tag the app never sends is not.
    const language =
      typeof locale === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale) ? locale : 'en-US';
    const output = await deps.cli(['--json', ...paths], RUN_TIMEOUT);
    const results = cliList(output, 'results').map(asRecord);
    const holder = holderOf(listImportRecords(deps.store));
    let assistantId: Promise<string> | undefined;
    const assistant = (): Promise<string> => (assistantId ??= deps.assistant());
    const outcomes: ImportOutcome[] = [];
    for (const result of results) {
      const source = text(result.source);
      if (result.status === 'failed') {
        const error = text(result.error);
        outcomes.push({ status: 'failed', source, reason: HARNESS_FAILURES[error] ?? 'other', detail: error });
        continue;
      }
      const file = text(result.sessionFile);
      if (!file) {
        outcomes.push({ status: 'failed', source, reason: 'other', detail: 'mu import named no session' });
        continue;
      }
      if (native) {
        outcomes.push(nativeOutcome(result, source, file));
        continue;
      }
      try {
        // In order: two transcripts never race for one conversation.
        // eslint-disable-next-line no-await-in-loop
        const held = await holder.find(file);
        if (held) {
          outcomes.push({ status: 'listed', source, ...held });
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const { outcome, record } = await conversationFor(source, file, language, assistant);
        if (outcome.status === 'imported' && record) holder.made(outcome.conversationId, outcome.name, record);
        outcomes.push(outcome);
      } catch (error) {
        // The session is in mu already: importing it again makes the conversation.
        const detail = error instanceof Error ? error.message : String(error);
        outcomes.push({ status: 'failed', source, reason: 'other', detail });
      }
    }
    return outcomes;
  };

  const history = async (conversationId: string): Promise<ImportedHistory> => {
    const record = readImportRecord(deps.store, conversationId);
    if (!record) throw new KyrnError('invalid', 'This conversation was not imported');
    if (!existsSync(record.file)) throw new KyrnError('importFailed', `The session file is gone: ${record.file}`);
    return readImportedHistory(record.file);
  };

  return { list, run, history };
}
