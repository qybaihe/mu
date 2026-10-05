import type { TMessage } from '@/common/chat/chatLib';

/**
 * A notice the mu bridge adds to a conversation (`MU_NOTICES` in `process/agent/kyrn/KyrnAgent.ts`): a tool call whose
 * id starts with `mu:notice:` and whose input carries the notice's code. It is shown as one line in the reader's
 * language, not as a tool call; a code this build has no words for shows the bridge's English title.
 *
 * What mu notified itself (a command's answer, a warning) comes the same way with no code, only its level: mu wrote it
 * in the app's language already, and the line shows it as it is.
 */
export const MU_NOTICE_CODES = [
  'answer_lost',
  'bash_missing',
  'checkpoint_off',
  'free_jev',
  'free_jev_unavailable',
  'stopped',
] as const;
export type MuNoticeCode = (typeof MU_NOTICE_CODES)[number];
export type MuNoticeLevel = 'info' | 'warning' | 'error';
export type MuNotice = {
  code?: MuNoticeCode;
  title: string;
  /** How a notice of mu's own reads; a coded one has its own look. */
  level?: MuNoticeLevel;
  /** Why checkpoints are off (`checkpoint_off`), or why the free Jev stopped (`free_jev_unavailable`): mu's code. */
  reason?: string;
  params?: Record<string, number>;
};

/** The i18n key of each notice's line. */
export const MU_NOTICE_KEYS: Readonly<Record<MuNoticeCode, string>> = {
  answer_lost: 'mu.notices.answerLost',
  bash_missing: 'mu.notices.bashMissing',
  checkpoint_off: 'mu.notices.checkpointOff',
  free_jev: 'mu.notices.freeJev',
  free_jev_unavailable: 'mu.notices.freeJevUnavailable.paid',
  stopped: 'mu.notices.stopped',
};

/** Why the free Jev stopped, by mu's reason (`paid`: it asks for a key or payment; `gone`: no longer offered). */
export const FREE_JEV_UNAVAILABLE_KEYS: Readonly<Record<string, string>> = {
  paid: 'mu.notices.freeJevUnavailable.paid',
  gone: 'mu.notices.freeJevUnavailable.gone',
};

/** A page the line ends with, where the person can act on it: the same address in every language. */
export const MU_NOTICE_LINKS: Readonly<Partial<Record<MuNoticeCode, string>>> = {
  bash_missing: 'https://git-scm.com/download/win',
};

/**
 * Why a conversation goes without checkpoints, by mu's code (the harness's `checkpoint.off`), and the key of the
 * sentence that says it in the app's words: what happened and what the person can do, never a setting's name.
 */
export const CHECKPOINT_OFF_KEYS: Readonly<Record<string, string>> = {
  git_missing: 'mu.notices.checkpointOffWhy.gitMissing',
  home_folder: 'mu.notices.checkpointOffWhy.homeFolder',
  mu_folder: 'mu.notices.checkpointOffWhy.muFolder',
  too_many_files: 'mu.notices.checkpointOffWhy.tooManyFiles',
  too_many_bytes: 'mu.notices.checkpointOffWhy.tooManyBytes',
  too_slow: 'mu.notices.checkpointOffWhy.tooSlow',
  xcode_license: 'mu.notices.checkpointOffWhy.xcodeLicense',
  developer_tools_missing: 'mu.notices.checkpointOffWhy.developerToolsMissing',
};

/** The numbers each reason's sentence names; a reason whose numbers did not come is said in mu's own words. */
const CHECKPOINT_PARAMS: Readonly<Record<string, readonly string[]>> = {
  too_many_files: ['limit'],
  too_many_bytes: ['limitMb'],
  too_slow: ['seconds'],
};

const NOTICE_ID = /^mu:notice:/;
const LEVELS: ReadonlySet<string> = new Set(['info', 'warning', 'error']);

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const isCode = (value: string): value is MuNoticeCode => (MU_NOTICE_CODES as readonly string[]).includes(value);
/** `limitMb` as the bridge sent it, or `limit_mb` as the relay passed it on. */
const snake = (name: string): string => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** The numbers a checkpoint notice names (`limit`, `limitMb`, `seconds`), in either spelling; anything else is dropped. */
export function readCheckpointParams(value: unknown): Record<string, number> {
  const given = record(value);
  const read: Record<string, number> = {};
  for (const name of ['limit', 'limitMb', 'seconds']) {
    const found = given[name] ?? given[snake(name)];
    if (typeof found === 'number' && Number.isFinite(found)) read[name] = found;
  }
  return read;
}

/** The notice a message stands for, or undefined for any other message. */
export function muNotice(message: TMessage): MuNotice | undefined {
  if (message.type !== 'acp_tool_call') return undefined;
  const update = record(message.content?.update);
  const id = str(update.tool_call_id) || str(update.toolCallId);
  if (!NOTICE_ID.test(id)) return undefined;
  // The relay snake-cases the keys it passes on.
  const input = record(update.raw_input ?? update.rawInput);
  const code = str(input.notice);
  const level = str(input.level);
  const title = str(update.title);
  if (!isCode(code)) return { title, ...(LEVELS.has(level) ? { level: level as MuNoticeLevel } : {}) };
  const reason = str(input.code);
  if (code === 'free_jev_unavailable') return { code, title, ...(reason ? { reason } : {}) };
  if (code !== 'checkpoint_off') return { code, title };
  return { code, title, ...(reason ? { reason } : {}), params: readCheckpointParams(input.params) };
}

/**
 * The i18n key and values of a checkpoint notice's sentence, or undefined when this build has no words for its reason
 * (or the numbers it names did not come): the line then shows mu's own, already in the app's language.
 */
export function checkpointOffWords(notice: MuNotice): { key: string; values: Record<string, number> } | undefined {
  const key = notice.reason ? CHECKPOINT_OFF_KEYS[notice.reason] : undefined;
  if (!key || !notice.reason) return undefined;
  const values = notice.params ?? {};
  const named = CHECKPOINT_PARAMS[notice.reason] ?? [];
  return named.every((name) => values[name] !== undefined) ? { key, values } : undefined;
}
