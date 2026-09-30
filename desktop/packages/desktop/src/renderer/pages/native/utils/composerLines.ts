/**
 * What the native send box shows about the conversation besides the text: mu's goal in the line above it, and how full
 * the model's context is in the ring beside the send button. Read from the view alone, as the classic mu conversation
 * reads them from its activity and usage reports (`GoalLine`, `ContextUsageIndicator`). Pure.
 */
import type { TokenUsageData } from '@/common/config/storage';
import type { NativeHostStatus } from '@/common/kyrn/nativeBridge';
import { asNumber, type NativeView, type ViewUsage } from '@/common/utils/nativeHost';
import { goalIsLive, type GoalSnapshot } from '@/renderer/pages/conversation/platforms/acp/Composer/goalState';

/** Hosts whose mu runs: only there does a goal that says it runs go on by itself. */
const RUNNING: ReadonlySet<NativeHostStatus['phase']> = new Set(['running', 'needs-model']);

/**
 * The goal the line above the send box shows: one that runs or waits (`active`, `paused`), none once it is met or
 * cleared. With no mu running, a goal the session file says runs waits for the next message: mu, resuming the session,
 * pauses it and goes on when the person writes, so the line says it is paused.
 */
export function goalOnScreen(view: NativeView, host: NativeHostStatus): GoalSnapshot | null {
  const goal = view.goal;
  if (!goal) return null;
  const shown: GoalSnapshot =
    goal.status === 'active' && !RUNNING.has(host.phase) ? { ...goal, status: 'paused' } : goal;
  return goalIsLive(shown) ? shown : null;
}

/** What the context ring shows: the classic ring's usage report and the context window it is measured against. */
export type ContextUsageShown = { tokenUsage: TokenUsageData; contextLimit: number };

/** The token counts of the latest reply that has them. */
function lastUsage(view: NativeView): ViewUsage | undefined {
  for (let index = view.messages.length - 1; index >= 0; index--) {
    const message = view.messages[index];
    if (message.role === 'assistant' && message.usage) return message.usage;
  }
  return undefined;
}

/**
 * The context ring's numbers, from what pi last said while a host ran (`get_state`, `get_session_stats`): the
 * context's tokens against its window, the latest reply's counts, and what the session cost when it cost anything (a
 * subscription's model says 0). Nothing while pi has not said how full the context is: no host ran since the
 * conversation was opened, or a compaction just emptied it (pi then says `tokens: null`).
 */
export function contextUsageOf(view: NativeView): ContextUsageShown | undefined {
  const session = view.host.session;
  const tokens = asNumber(session?.contextUsage?.tokens);
  if (tokens === undefined || tokens < 0) return undefined;
  const window = asNumber(session?.contextUsage?.contextWindow) ?? 0;
  const usage = lastUsage(view);
  const cost = session?.cost;
  return {
    tokenUsage: {
      total_tokens: tokens,
      ...(usage
        ? {
            breakdown: {
              input_tokens: usage.input,
              output_tokens: usage.output,
              cached_read_tokens: usage.cacheRead,
              cached_write_tokens: usage.cacheWrite,
            },
          }
        : {}),
      ...(cost !== undefined && cost > 0 ? { cost: { amount: cost, currency: 'USD' } } : {}),
    },
    contextLimit: window > 0 ? window : 0,
  };
}
