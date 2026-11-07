import type { TMessage } from '@/common/chat/chatLib';
import { readReason } from '@/renderer/pages/conversation/KyrnPanel/Judge/activity';
import { isPreflightHintId, type PreflightHintId } from '@/renderer/pages/conversation/KyrnPanel/Judge/wording';
import { readJudgePreflightRow } from '@/renderer/utils/chat/judgePreflight';

/**
 * How the judge's classification of a message shows in the conversation: one line, not a tool call. The mu adapter
 * (`process/agent/kyrn/events.ts`) sends it as a tool call with the id `jev:<runtime>:<turn>` and marks its stage in
 * `rawOutput.preflight` (pending, verdict with the verdict's fields, fallback). Conversations recorded before that
 * carry only the English title ("Jev · Classifying", "Jev · <turn type>", "Jev · Fallback"), which is read instead.
 *
 * `hints` are the hints the main model was given with the verdict (`hintIds`, see the harness's
 * kyrn/docs/features/presentation-codes.md), in their order; present only when there are some. The harness sends the
 * verdict again once the turn has started, with them; a rule's hint (`answered`) can come with no class at all.
 *
 * `judge` names the judge that was asked or answered (the verdict's `by`, the wait's `judge`): `jev-latest`, `mude`,
 * a cascade such as `mude>jev-latest`. It is empty for rows that never named one; those were Jev's.
 */
export type JudgeLine =
  | { stage: 'classifying'; judge: string }
  /** A class it answered with; `state` as the harness names it (applied, shadow, late), `byRule` when no judge had to read it. */
  | { stage: 'classified'; turnType: string; state: string; byRule: boolean; judge: string; hints?: PreflightHintId[] }
  /**
   * No class this time: the turn goes on as it would without a judge. `unanswered` when the judge did not answer (it
   * failed, or took too long), `unsure` when it answered without a clear class.
   */
  | { stage: 'fallback'; why: 'unanswered' | 'unsure'; judge: string; hints?: PreflightHintId[] }
  /**
   * No judge could be asked at all (no key, or a refused one: `error:auth`). Said once in a conversation, with the way
   * to set one up, not under every message.
   */
  | { stage: 'noJudge'; hints?: PreflightHintId[] }
  /** Nothing worth a line: the classification is switched off, or the person skipped it. */
  | { stage: 'quiet' };

/** The preflight row's tool call id: `jev:` is the prefix stored conversations have always had. */
const PREFLIGHT_ID = /^jev:/;

/**
 * The classes the harness's preflight answers with (`TurnType` of kyrn-judge's input preflight). Each has a name in
 * `common.kyrn.judgeView.values`; a class a newer harness adds is shown as "other" until it has one, never as its id.
 */
export const TURN_TYPES = [
  'chat',
  'chat_question',
  'quick_lookup',
  'single_edit',
  'multi_step_task',
  'research',
  'design_discussion',
] as const;
export type TurnType = (typeof TURN_TYPES)[number];

export const isTurnType = (value: string): value is TurnType => (TURN_TYPES as readonly string[]).includes(value);

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The judge a label names, as the app calls it: Jev or CLM by the label's start (`jev-latest` is Jev), the first tier
 * of a cascade (`mude>jev-latest` asks mude first), and a label the app does not know as it is (`mude`, or `laya` in a
 * conversation from before mu dropped that judge). Empty, it is Jev, the only judge there was before judges were named.
 */
export function judgeName(label: string | undefined): string {
  const first = (label ?? '').split('>')[0].trim();
  // A model id may come with its provider in front (`openrouter/jev-latest`).
  const lower = (first.split('/').at(-1) ?? '').toLowerCase();
  if (!first || lower.startsWith('jev')) return 'Jev';
  if (lower.startsWith('clm')) return 'CLM';
  return first;
}

/**
 * Why a classification came to nothing, from its reason code: no judge at all, the judge not answering, nothing worth
 * a line, or an answer without a clear class.
 */
export function fallbackKind(reason: string): 'noJudge' | 'unanswered' | 'quiet' | 'unsure' {
  if (reason === 'error:auth') return 'noJudge';
  if (reason === 'off' || reason === 'skipped') return 'quiet';
  if (reason === 'no_answer' || reason === 'timeout' || reason.startsWith('error:')) return 'unanswered';
  return 'unsure';
}

/**
 * The hints a verdict names, each once and in its order. Only the ids this build has words for: the conversation shows
 * no raw code, and the judge tab still lists an id a newer harness adds. The relay may have snake_cased the key.
 */
function hintsOf(verdict: Record<string, unknown>): { hints?: PreflightHintId[] } {
  const ids = verdict.hintIds ?? verdict.hint_ids;
  if (!Array.isArray(ids)) return {};
  const hints = [
    ...new Set(ids.filter((id): id is PreflightHintId => typeof id === 'string' && isPreflightHintId(id))),
  ];
  return hints.length ? { hints } : {};
}

export function judgeLine(message: TMessage): JudgeLine | undefined {
  if (message.type !== 'acp_tool_call') return undefined;
  const update = record(message.content?.update);
  const id = str(update.tool_call_id) || str(update.toolCallId);
  if (!PREFLIGHT_ID.test(id)) return undefined;
  const raw = update.rawOutput ?? update.raw_output;
  const verdict = record(raw);
  // The verdict names who answered; a wait names who was asked.
  const judge = str(verdict.by) === 'rule' ? '' : str(verdict.by) || str(verdict.judge);
  if (update.status === 'pending' || update.status === 'in_progress') return { stage: 'classifying', judge };
  const row = readJudgePreflightRow(id, update.title, raw);
  if (row?.state === 'pending') return { stage: 'classifying', judge };
  const turnType = row?.state === 'verdict' ? (row.turnType ?? '') : '';
  const state = str(verdict.state) || 'applied';
  if (!turnType || turnType === 'unknown' || state === 'none') {
    // A wait that ran out has no reason of its own: the judge did not answer in time.
    const reason =
      row?.state === 'fallback'
        ? 'no_answer'
        : readReason(verdict.reason, verdict.reasonCode ?? verdict.reason_code, verdict.reasonParams).code;
    const kind = fallbackKind(reason);
    if (kind === 'quiet') return { stage: 'quiet' };
    if (kind === 'noJudge') return { stage: 'noJudge', ...hintsOf(verdict) };
    return { stage: 'fallback', why: kind, judge, ...hintsOf(verdict) };
  }
  return { stage: 'classified', turnType, state, byRule: verdict.by === 'rule', judge, ...hintsOf(verdict) };
}
