/**
 * The judge's preflight row the mu bridge adds at the top of every turn (`process/agent/kyrn/events.ts`): a tool call
 * whose id starts with `jev:` (the prefix the stored rows have always had). The bridge has no i18n and its title is
 * stored with the conversation, so the row is read from stable data, `rawOutput.preflight` and the verdict's turn
 * type, and named in the reader's language where it is shown (`Messages/acp/judgeLine.ts`). Conversations recorded
 * before the bridge sent that data carry only the English title (`Jev · Classifying`, `Jev · multi_step_task`, …, the
 * name in any capitalization; `Judge · …` in later titles), which is read instead.
 */
export type JudgePreflightRow = { state: 'pending' | 'verdict' | 'fallback'; turnType?: string };

const STATES = new Set<JudgePreflightRow['state']>(['pending', 'verdict', 'fallback']);
const OLD_TITLE = /^(?:jev|judge) · (.+)$/i;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export const isJudgePreflightId = (toolCallId: unknown): boolean =>
  typeof toolCallId === 'string' && toolCallId.startsWith('jev:');

/** The row a `jev:` tool call stands for, or undefined for any other tool call. */
export function readJudgePreflightRow(
  toolCallId: unknown,
  title: unknown,
  rawOutput: unknown
): JudgePreflightRow | undefined {
  if (!isJudgePreflightId(toolCallId)) return undefined;
  const output = record(rawOutput);
  const state = text(output.preflight) as JudgePreflightRow['state'];
  // The relay may have snake_cased the payload's keys.
  const turnType = text(output.turnType) || text(output.turn_type);
  if (STATES.has(state)) return state === 'verdict' && turnType ? { state, turnType } : { state };
  const label = OLD_TITLE.exec(text(title))?.[1]?.trim();
  if (!label) return turnType ? { state: 'verdict', turnType } : undefined;
  if (label === 'Classifying') return { state: 'pending' };
  if (label === 'Fallback') return { state: 'fallback' };
  if (turnType) return { state: 'verdict', turnType };
  if (label === 'Default') return { state: 'verdict' };
  return { state: 'verdict', turnType: label };
}
