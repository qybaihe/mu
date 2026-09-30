import type { PermissionOptionKind, SessionConfigOption, ToolCallUpdate, ToolKind } from '@agentclientprotocol/sdk';
import { readPresentation } from '../../../common/utils/nativeHost/presentation.ts';
import { array, asRecord, text, type JsonRecord } from './piRpc.ts';

/*
 * mu's permission modes in the app (the harness's kyrn/docs/features/permissions.md). The send box's permission
 * picker is an ACP `mode` option built from mu's `permissions.mode` event; picking a mode sends mu's own
 * `/permissions <id> --here`, which switches that conversation only (the mode new conversations start in is set in
 * the settings); mu's question before a call becomes a card whose buttons say what each answer does.
 */

export type PermissionModes = {
  /** The mode this conversation is in. */
  mode: string;
  /** Every mode, with its name and what it lets mu do, in the language mu speaks (MU_LANG). */
  modes: { id: string; label: string; description: string }[];
  /**
   * mu understands `/permissions <id> --here`, which switches this conversation only. An older mu would read
   * `--here` as an unknown word, so it only gets the plain command.
   */
  conversationSwitch: boolean;
};

/** What mu said just before it asks about a call: the picker that follows offers `answers`. */
export type PermissionRequest = {
  /** edit, shell, run, outside, delegate or other. */
  kind: string;
  /** The call: a command, `edit <path>`, `<tool> <target>`. */
  summary: string;
  answers: string[];
  /**
   * The same answers by id, in the same order (`once`, `session` when offered, `deny`), from a mu that sends them.
   * The desktop words the buttons by these; the answers themselves are only in Chinese or English.
   */
  answerIds?: string[];
  /**
   * Why mu asks: `ask`, `unsure`, `beyond`, `unrelated`, `flagged`, `protected`, `nojudge` (no judge could be asked)
   * or `judgedown` (the judge did not answer).
   */
  reason?: string;
  /** For a flagged command, what makes it risky, as a code (`force_push`, `runs_as_root`, …). */
  flagCode?: string;
  /** What "for this conversation" would cover: a command's first words, `edit`, a path or a tool. Data, not words. */
  grantLabel?: string;
  /** The tool call mu asks about, from a mu that names it: the conversation shows the card above that call. */
  toolCallId?: string;
};

/** The codes a permission card carries for the desktop to word it: under `rawInput.mu`, beside the call. */
export type PermissionCodes = Pick<PermissionRequest, 'kind' | 'reason' | 'flagCode' | 'grantLabel' | 'toolCallId'>;

/** What mu says once a question is answered: the answer by id (`once`, `session`, `deny`) and the call it was about. */
export type PermissionResolved = { answer?: string; toolCallId?: string };

/** Codes are lowercase words joined by underscores; anything else is not passed on as one. */
const CODE = /^[a-z][a-z_]{0,47}$/;
const code = (value: unknown): string | undefined =>
  typeof value === 'string' && CODE.test(value) ? value : undefined;
/** A tool call's id is pi's (the provider's) own: any short line of text. */
const callId = (value: unknown): string | undefined =>
  typeof value === 'string' && value && value.length <= 256 && !/[\r\n]/.test(value) ? value : undefined;

/** A presentation event mu sends on its status channel, or undefined for any other event. */
export function presentation(event: JsonRecord): { kind: string; payload: JsonRecord } | undefined {
  const frame = readPresentation(event);
  return frame ? { kind: frame.kind, payload: frame.payload } : undefined;
}

/** Mode ids are words (`full`, `jev`, `ask`): anything else is not sent on as a command. */
const MODE_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const isModeId = (value: string): boolean => MODE_ID.test(value);

export function readModes(payload: JsonRecord): PermissionModes | undefined {
  const modes = array(payload.modes)
    .map(asRecord)
    .map((mode) => ({
      id: text(mode.id),
      label: text(mode.label) || text(mode.id),
      description: text(mode.description),
    }))
    .filter((mode) => MODE_ID.test(mode.id));
  const mode = text(payload.mode);
  return modes.some((each) => each.id === mode)
    ? { mode, modes, conversationSwitch: payload.conversationSwitch === true }
    : undefined;
}

export function readRequest(payload: JsonRecord): PermissionRequest | undefined {
  const answers = array(payload.answers).map(text);
  if (answers.length < 2 || answers.some((answer) => !answer)) return undefined;
  // Ids count only as a full, distinct set in the answers' order; an older mu sends none.
  const ids = array(payload.answerIds).map(code);
  const answerIds =
    ids.length === answers.length && ids.every(Boolean) && new Set(ids).size === ids.length
      ? (ids as string[])
      : undefined;
  const reason = code(payload.reason);
  const flagCode = code(payload.flagCode);
  const grantLabel = text(asRecord(payload.grant).label);
  const toolCallId = callId(payload.toolCallId);
  return {
    kind: text(payload.kind),
    summary: text(payload.summary),
    answers,
    ...(answerIds ? { answerIds } : {}),
    ...(reason ? { reason } : {}),
    ...(flagCode ? { flagCode } : {}),
    ...(grantLabel ? { grantLabel } : {}),
    ...(toolCallId ? { toolCallId } : {}),
  };
}

/** mu's `permissions.resolved`: how the question was answered, and about which call (a mu that names it). */
export function readResolved(payload: JsonRecord): PermissionResolved {
  const answer = code(payload.answer);
  const toolCallId = callId(payload.toolCallId);
  return { ...(answer ? { answer } : {}), ...(toolCallId ? { toolCallId } : {}) };
}

/** The send box's permission picker. The category is what the app looks for; the names are mu's. */
export const modeOption = ({ mode, modes }: PermissionModes): SessionConfigOption => ({
  id: 'mode',
  category: 'mode',
  name: 'Permissions',
  type: 'select',
  currentValue: mode,
  options: modes.map((each) => ({
    value: each.id,
    name: each.label,
    ...(each.description ? { description: each.description } : {}),
  })),
});

/** Whether a picker offers exactly what mu said it would ask. */
export const asks = (request: PermissionRequest, choices: string[]): boolean =>
  request.answers.length === choices.length && request.answers.every((answer, i) => answer === choices[i]);

const TOOL_KIND: Record<string, ToolKind> = { edit: 'edit', outside: 'edit', shell: 'execute', run: 'execute' };

/**
 * mu's picker as the call a permission card shows. The picker's title is three lines: what mu wants to do, the call,
 * and why it asks. The card gets the first as its title, the reason under it and the call where a command goes. The
 * call is taken from the request, not the title, because a command can itself run over several lines.
 */
export function permissionCall(request: PermissionRequest, title: string): Omit<ToolCallUpdate, 'toolCallId'> {
  const lines = title.split('\n');
  const why = lines.length > 2 ? (lines.at(-1) ?? '').trim() : '';
  const codes: PermissionCodes = {
    kind: request.kind,
    ...(request.reason ? { reason: request.reason } : {}),
    ...(request.flagCode ? { flagCode: request.flagCode } : {}),
    ...(request.grantLabel ? { grantLabel: request.grantLabel } : {}),
    ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
  };
  return {
    title: lines[0] || request.summary,
    kind: TOOL_KIND[request.kind] ?? 'other',
    // mu's own sentences stay the fallback; a desktop that knows the codes words the card in the reader's language.
    rawInput: { command: request.summary, ...(why ? { description: why } : {}), mu: codes },
    content: [{ type: 'content', content: { type: 'text', text: title } }],
  };
}

/** mu's answers are "once", then "for this conversation" when offered, then "don't allow". */
export function answerKind(index: number, count: number): PermissionOptionKind {
  if (index === count - 1) return 'reject_once';
  return index === 0 ? 'allow_once' : 'allow_always';
}

/** Option ids of mu's answers the desktop can word: `mu:once`, `mu:session`, `mu:deny`. */
export const MU_ANSWER_PREFIX = 'mu:';

/** The option id of answer `index`: by its id when mu sent ids, else its position. */
export const answerOptionId = (request: PermissionRequest | undefined, index: number): string =>
  request?.answerIds ? `${MU_ANSWER_PREFIX}${request.answerIds[index]}` : String(index);

/** The answer an option id stands for, or -1 for an id no answer has. */
export function answerIndex(request: PermissionRequest | undefined, optionId: string, count: number): number {
  if (request?.answerIds && optionId.startsWith(MU_ANSWER_PREFIX))
    return request.answerIds.indexOf(optionId.slice(MU_ANSWER_PREFIX.length));
  // A position only as answerOptionId writes one: `Number` reads "" or " " as 0, and the first answer allows.
  if (request?.answerIds || !/^(?:0|[1-9]\d*)$/.test(optionId)) return -1;
  const index = Number(optionId);
  return index < count ? index : -1;
}
