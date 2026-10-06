/**
 * Conversations people had in Claude Code or Codex, brought into mu to go on with them here.
 *
 * The harness reads the transcripts and writes each one as a mu session (`mu import`, `packages/kyrn-judge/src/import`
 * in the MU repository). With the native host on, that session is the conversation: the sidebar lists mu's sessions.
 * Otherwise the main process makes every imported session an app conversation (`process/agent/kyrn/importChats.ts`)
 * and the adapter hands the session to its conversation the first time the conversation starts
 * (`KyrnAgent.newSession`). This module holds what the processes pass each other and the screens show: no Node, no
 * DOM.
 */

export const IMPORT_TOOLS = ['claude-code', 'codex'] as const;
export type ImportTool = (typeof IMPORT_TOOLS)[number];
export const isImportTool = (value: unknown): value is ImportTool => IMPORT_TOOLS.includes(value as ImportTool);

/** The tools' own names, the same in every language. */
export const IMPORT_TOOL_NAMES: Record<ImportTool, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

/** One conversation `mu import --list` found on this computer. */
export type FoundChat = {
  tool: ImportTool;
  /** The transcript. */
  path: string;
  /** The project folder it ran in; unset when the transcript does not say. */
  cwd?: string;
  /** Its first message, on one line; empty when none was found. */
  title: string;
  /** When the transcript last changed, ISO. */
  modified: string;
  /** The transcript's size in bytes. */
  size: number;
  /** The mu session made from it before, if any. */
  importedAs?: string;
  /** The app conversation that holds that session, if there is one. */
  conversationId?: string;
  /**
   * `conversationId` is a native conversation's (the session's own id): the app runs mu itself and every mu session
   * is a conversation of its own, with no app conversation made for it.
   */
  native?: true;
};

export type ImportList = { conversations: FoundChat[] };

/**
 * Why a transcript was not brought in: the file is gone, is no file, is not a transcript of either tool, holds no
 * message, or its project folder no longer exists (a conversation runs in its folder). `other` keeps the harness's
 * own words as the detail.
 */
export const IMPORT_FAILURES = ['missing', 'notFile', 'notTranscript', 'empty', 'folderMissing', 'other'] as const;
export type ImportFailure = (typeof IMPORT_FAILURES)[number];

/**
 * What became of one transcript: a new app conversation, the conversation that already holds it, or why it was left
 * out. `source` is the transcript's path.
 */
export type ImportOutcome =
  | { status: 'imported'; source: string; tool: ImportTool; conversationId: string; name: string; native?: true }
  | { status: 'listed'; source: string; conversationId: string; name: string; native?: true }
  | { status: 'failed'; source: string; reason: ImportFailure; detail: string };

/** The key of `conversation.extra` an imported conversation carries its origin under. */
export const IMPORT_EXTRA_KEY = 'mu_import';

/** Where an imported conversation came from and how much of it came along: the notice at its top reads this. */
export type ImportMark = {
  tool: ImportTool;
  /** The transcript it was made from. */
  source: string;
  /** Messages from the person, answers and tool calls brought in. */
  user: number;
  assistant: number;
  toolCalls: number;
};

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

/** The mark of an imported conversation, read from its `extra`; undefined for any other conversation. */
export function importMarkOf(extra: unknown): ImportMark | undefined {
  if (extra === null || typeof extra !== 'object') return undefined;
  const mark = (extra as Record<string, unknown>)[IMPORT_EXTRA_KEY];
  if (mark === null || typeof mark !== 'object') return undefined;
  const { tool, source, user, assistant, toolCalls } = mark as Record<string, unknown>;
  if (!isImportTool(tool) || typeof source !== 'string') return undefined;
  return { tool, source, user: count(user), assistant: count(assistant), toolCalls: count(toolCalls) };
}

/**
 * One step of the imported part of a conversation, as the app reads it back: something the person said, what the
 * assistant answered up to their next message (its text and the tools it called, in order), or the summary a
 * compaction left in place of what came before it.
 */
export type ImportedHistoryItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; tools: string[] }
  | { kind: 'summary'; text: string };

/** The imported part of a conversation; `earlier` steps before the first one shown were left out. */
export type ImportedHistory = { tool: ImportTool; source: string; items: ImportedHistoryItem[]; earlier: number };

export type ChatGroup = { tool: ImportTool; chats: FoundChat[] };

/**
 * The conversations under their tool, Claude Code first, each in the order the list came in (newest first). A query
 * keeps the conversations whose first message or folder contains every word of it, in any case.
 */
export function groupChats(chats: readonly FoundChat[], query = ''): ChatGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (chat: FoundChat): boolean => {
    if (words.length === 0) return true;
    const haystack = `${chat.title}\n${chat.cwd ?? ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  };
  return IMPORT_TOOLS.map((tool) => ({
    tool,
    chats: chats.filter((chat) => chat.tool === tool && matches(chat)),
  })).filter((group) => group.chats.length > 0);
}

/** The tools an assistant step called, each once, with how many times: `Bash ×3`. */
export function toolTally(tools: readonly string[]): { name: string; times: number }[] {
  const tally = new Map<string, number>();
  for (const name of tools) tally.set(name, (tally.get(name) ?? 0) + 1);
  return [...tally].map(([name, times]) => ({ name, times }));
}
