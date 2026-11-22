import type { TMessage } from '@/common/chat/chatLib';

/**
 * The teaching card of a turn (`turn.teaching`), as the bridge wrote it into the conversation: a tool call whose id
 * starts with `mu:teaching:` and whose input carries the card. Shown as one folded row the reader can open — the why
 * of the turn's choice, and the options that were ruled out — never as a tool call, and never as part of the reply.
 */
export const TEACHING_KINDS = ['product_tradeoff', 'arch_weighing', 'counterintuitive_pitfall'] as const;
export type TeachingKind = (typeof TEACHING_KINDS)[number];

export type TeachingCard = {
  kind: TeachingKind;
  why: string;
  ruledOut: string[];
  /** The turn the card belongs to, as the judge line's id names it (`runtime:turn`). */
  turn?: string;
};

const TEACHING_ID = /^mu:teaching:/;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const isKind = (value: string): value is TeachingKind => (TEACHING_KINDS as readonly string[]).includes(value);

/** The card a message stands for, or undefined for any other message. A card without a why shows nothing. */
export function teachingCard(message: TMessage): TeachingCard | undefined {
  if (message.type !== 'acp_tool_call') return undefined;
  const update = record(message.content?.update);
  const id = str(update.tool_call_id) || str(update.toolCallId);
  if (!TEACHING_ID.test(id)) return undefined;
  // The relay snake-cases the keys it passes on.
  const input = record(update.raw_input ?? update.rawInput);
  const kind = str(input.teaching);
  const why = str(input.why).trim();
  if (!isKind(kind) || !why) return undefined;
  const ruledOut = Array.isArray(input.ruledOut)
    ? input.ruledOut.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 2)
    : [];
  const turn = str(input.turn).trim();
  return { kind, why, ruledOut, ...(turn ? { turn } : {}) };
}
