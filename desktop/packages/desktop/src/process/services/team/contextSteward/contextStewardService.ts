/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The context steward's main-process half: after a finished turn of a
 * position, supervisor or team conversation, read the session's live token
 * count from the adapter's telemetry (`context.usage` events), and when it
 * stands at the check line, ask the quick-decision engine once and act.
 *
 * compact = one hidden `/compact` message through the backend (pi's own
 * command; no agent turn, no visible row). switch = a NEW conversation with
 * the same assistant, workspace and position marker — a fresh session, the
 * lossless move: the old conversation keeps every message, renamed
 * `(part N)`, and the roster's "latest conversation with the marker" rule
 * makes the new part the position's conversation. The backend's fork API is
 * NOT used: it refuses team conversations outright (403), mu's agent
 * declares no fork capability, and an ACP session fork is HEAD-only — a
 * full-context copy, which is no relief at all (see SPEC-P6 and HANDOFF).
 *
 * Team-bound conversations never switch — their slots point at one
 * conversation each, and a fresh unbound part would strand the team — so
 * their steward actions are compact only, and their undecidable cases fall
 * to compact, not switch.
 */
import { httpRequest } from '@/common/adapter/httpBridge';
import { activityPage } from '@process/agent/kyrn/telemetry';
import { muActivityStore, muSessionOf } from '@process/bridge/kyrnBridge';
import {
  STEWARD_COMPACT_MESSAGE,
  checkLineTokens,
  conservativeDecision,
  freshStewardMemory,
  partNamingFor,
  standsAtLine,
  type StewardMemory,
  type StewardUsage,
} from '@/common/chat/team/contextSteward/contextStewardCore';
import { contextStewardDecision, type ContextStewardEngineResult } from '@process/services/team/quickDecision';
import type { ContextStewardRunResult } from '@/common/chat/team/contextSteward/contextStewardBridge';

/** One conversation as the steward needs it. */
export type StewardConversation = {
  name: string;
  assistantId?: string;
  /** The position marker (position or supervisor conversations) — the steward's main constituency. */
  position?: string;
  /** Set on team-bound conversations (lead and member threads): compact only, never switch. */
  teamId?: string;
  workspace?: string;
};

/** Everything injectable, so tests run no HTTP, no telemetry and no model. */
export type ContextStewardDeps = {
  now: () => number;
  /** Reads `tools.contextStewardEnabled`; undefined (or a throw) = the feature is ON (the default). */
  readEnabled: () => Promise<boolean | undefined>;
  /** Reads `tools.contextStewardCheckRatio`; undefined = the built-in 0.8 default. Test/E2E knob, not a user setting. */
  readRatio: () => Promise<number | undefined>;
  /** One conversation as the steward needs it, or undefined when it is gone. */
  getConversation: (conversationId: string) => Promise<StewardConversation | undefined>;
  /** The session's latest usage and the new tail cursor; undefined when the session has none yet. */
  readUsage: (conversationId: string, cursor: number) => Promise<{ usage: StewardUsage | undefined; cursor: number }>;
  /** The tail of the last assistant reply, the one signal a small model can read for "mid-work or settled". */
  lastAssistantExcerpt: (conversationId: string) => Promise<string>;
  /** The engine's one question. The service never sees HOW it was answered. */
  askEngine: (params: {
    goal: string;
    percent: number;
    tokens: number;
    contextWindow: number;
    checkLine: number;
    compactions: number;
    midWorkHint: 'mid-work' | 'settled' | 'unclear';
    lastExcerpt: string;
  }) => Promise<ContextStewardEngineResult>;
  /** Delivers the hidden `/compact` (backend message → pi's own command). */
  sendCompact: (conversationId: string) => Promise<void>;
  /** Creates the next part: a fresh conversation carrying the same assistant, workspace and marker. */
  createPart: (conversationId: string, title: string) => Promise<{ id: string }>;
  /** Marks the old part by name (`(part N)`), an explicit user-grade rename. */
  renameConversation: (conversationId: string, name: string) => Promise<void>;
  log: (...args: unknown[]) => void;
};

/** Per-conversation steward state; cursor drives incremental telemetry reads. */
type ConversationState = StewardMemory;

const state = new Map<string, ConversationState>();
/** One check per conversation at a time; the second turn-end waits out the first. */
const inFlight = new Map<string, Promise<ContextStewardRunResult>>();

const skip = (reason: string): ContextStewardRunResult => ({ action: 'skip', reason });

/**
 * One turn-end check. Always answers — a steward failure is a `skip` with a
 * reason, never a thrown error — and the answer's `skip` reasons are for the
 * dev log: the conversation flow the person sees is only ever the compact
 * itself or the part switch.
 */
export async function runContextStewardIn(
  deps: ContextStewardDeps,
  states: Map<string, ConversationState>,
  flights: Map<string, Promise<ContextStewardRunResult>>,
  conversationId: string
): Promise<ContextStewardRunResult> {
  const running = flights.get(conversationId);
  if (running) return running;
  const flight = runOnce(deps, states, conversationId)
    .catch((error): ContextStewardRunResult => skip(`steward-error ${String(error)}`))
    .finally(() => {
      if (flights.get(conversationId) === flight) flights.delete(conversationId);
    });
  flights.set(conversationId, flight);
  return flight;
}

async function runOnce(
  deps: ContextStewardDeps,
  states: Map<string, ConversationState>,
  conversationId: string
): Promise<ContextStewardRunResult> {
  let enabled: boolean | undefined;
  try {
    enabled = await deps.readEnabled();
  } catch {
    enabled = undefined; // An unreadable setting is the default, not an error surface.
  }
  if (enabled === false) return skip('disabled');

  const conversation = await deps.getConversation(conversationId).catch((): undefined => undefined);
  if (!conversation) return skip('conversation-gone');
  const stewarded = conversation.position !== undefined && conversation.position !== '';
  if (!stewarded && !conversation.teamId) return skip('not-stewarded');

  const memory = states.get(conversationId) ?? freshStewardMemory();
  states.set(conversationId, memory);
  const page = await deps.readUsage(conversationId, memory.cursor).catch((): undefined => undefined);
  if (!page) return skip('no-telemetry');
  memory.cursor = page.cursor;
  const usage = page.usage;
  // `tokens: null` is pi's post-compaction window: unknown, not low. Asking or
  // acting on it would be a guess; the next real usage decides.
  if (!usage || usage.tokens === null) return skip('tokens-unknown');

  let ratio: number | undefined;
  try {
    ratio = await deps.readRatio();
  } catch {
    ratio = undefined;
  }
  const standing = standsAtLine(usage, memory, ratio);
  if (standing !== 'over') return skip(standing === 'below' ? 'below-line' : 'tokens-unknown');

  // A team thread's slots point at this one conversation; a fresh unbound part
  // would strand them. Its lossless/lossy pair collapses to compact-only.
  const switchAllowed = !conversation.teamId;
  const decide = async (): Promise<{ action: 'compact' | 'switch' | 'none'; reason: string }> => {
    const excerpt = await deps.lastAssistantExcerpt(conversationId).catch((): string => '');
    // 'unclear' is honest: mid-work state is exactly what the excerpt lets the
    // model judge, and a wrong deterministic hint would be worse than none.
    const asked = await deps.askEngine({
      goal: conversation.name,
      percent: usage.percent ?? Number.NaN,
      tokens: usage.tokens ?? 0,
      contextWindow: usage.contextWindow,
      checkLine: checkLineTokens(usage.contextWindow, ratio),
      compactions: memory.compactions,
      midWorkHint: 'unclear',
      lastExcerpt: excerpt,
    });
    if (asked.answered) return { action: asked.action, reason: asked.reason };
    return conservativeDecision(switchAllowed);
  };
  let decision = await decide();
  if (decision.action === 'switch' && !switchAllowed) {
    decision = { action: 'compact', reason: 'switch-unavailable' };
  }
  if (decision.action === 'none') {
    // No action, but the line was crossed with intent: hold the watermark so
    // the very same turn does not re-ask on the next one.
    memory.watermark = usage.tokens;
    return { action: 'none', reason: decision.reason };
  }

  if (decision.action === 'compact') {
    try {
      await deps.sendCompact(conversationId);
    } catch (error) {
      deps.log(`[contextSteward] compact failed for ${conversationId}: ${String(error)}`);
      return skip('compact-failed'); // Watermark untouched: the next turn re-asks.
    }
    memory.compactions += 1;
    memory.watermark = usage.tokens;
    deps.log(
      `[contextSteward] compact ${conversationId} tokens=${usage.tokens}/${usage.contextWindow} reason=${decision.reason}`
    );
    return {
      action: 'compact',
      reason: decision.reason,
      tokens: usage.tokens ?? 0,
      contextWindow: usage.contextWindow,
      percent: usage.percent,
    };
  }

  // switch: the fresh part first (its creation is the point), the rename after
  // — a part that exists unnamed is recoverable, a name without a part is not.
  const naming = partNamingFor(conversation.name);
  let part: { id: string };
  try {
    part = await deps.createPart(conversationId, naming.newTitle);
  } catch (error) {
    deps.log(`[contextSteward] part creation failed for ${conversationId}: ${String(error)}`);
    return skip('part-creation-failed');
  }
  try {
    await deps.renameConversation(conversationId, naming.oldTitle);
  } catch (error) {
    // The part exists; only its predecessor's label failed. The chain holds.
    deps.log(`[contextSteward] renaming the old part failed for ${conversationId}: ${String(error)}`);
  }
  memory.watermark = usage.tokens;
  states.delete(part.id); // A fresh part starts with fresh memory.
  deps.log(
    `[contextSteward] switch ${conversationId} -> ${part.id} (part ${naming.part}) tokens=${usage.tokens}/${usage.contextWindow} reason=${decision.reason}`
  );
  return {
    action: 'switch',
    reason: decision.reason,
    oldConversationId: conversationId,
    newConversationId: part.id,
    oldTitle: naming.oldTitle,
    newTitle: naming.newTitle,
    part: naming.part,
    tokens: usage.tokens ?? 0,
    contextWindow: usage.contextWindow,
    percent: usage.percent,
  };
}

/** Reads the session's latest `context.usage` telemetry, moving the cursor past everything read. */
const readUsageFromTelemetry = async (
  conversationId: string,
  cursor: number
): Promise<{ usage: StewardUsage | undefined; cursor: number }> => {
  const sessionId = await muSessionOf(conversationId);
  if (!sessionId) return { usage: undefined, cursor };
  const page = activityPage(muActivityStore(), sessionId, cursor, ['context.usage']);
  let usage: StewardUsage | undefined;
  for (const event of page.events) {
    const candidate = event.payload?.usage as Partial<StewardUsage> | undefined;
    if (
      candidate &&
      (typeof candidate.tokens === 'number' || candidate.tokens === null) &&
      typeof candidate.contextWindow === 'number'
    ) {
      // The latest count with a real number wins; a trailing null (post-compact
      // window) is remembered only as the last word, which reads as unknown.
      if (candidate.tokens !== null || usage === undefined)
        usage = {
          tokens: candidate.tokens,
          contextWindow: candidate.contextWindow,
          percent: candidate.percent ?? null,
        };
    }
  }
  return { usage, cursor: page.cursor };
};

/** The tail of the last assistant text row, the cheap "what was the session doing" signal. */
const lastAssistantExcerptFrom = async (conversationId: string): Promise<string> => {
  const rows = await httpRequest<unknown>('GET', `/api/conversations/${conversationId}/messages?limit=12`);
  const list = (rows as { messages?: unknown[] })?.messages ?? [];
  for (const row of [...list].reverse()) {
    const record = row as Record<string, unknown>;
    if (record.type !== 'text' || record.position !== 'left') continue;
    const content = record.content;
    const text =
      typeof content === 'string' ? content : ((content as { text?: unknown } | null)?.text as string | undefined);
    if (typeof text === 'string' && text.trim()) return text;
  }
  return '';
};

/** The production wiring: backend settings and conversations, adapter telemetry, the quick-decision engine. */
const prodDeps = (): ContextStewardDeps => ({
  now: Date.now,
  readEnabled: async () => {
    const data = await httpRequest<Record<string, boolean | undefined>>(
      'GET',
      `/api/settings/client?keys=${encodeURIComponent('tools.contextStewardEnabled')}`
    );
    return data?.['tools.contextStewardEnabled'];
  },
  readRatio: async () => {
    const data = await httpRequest<Record<string, number | undefined>>(
      'GET',
      `/api/settings/client?keys=${encodeURIComponent('tools.contextStewardCheckRatio')}`
    );
    return data?.['tools.contextStewardCheckRatio'];
  },
  getConversation: async (conversationId): Promise<StewardConversation | undefined> => {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(conversationId)) return undefined;
    const raw = await httpRequest<Record<string, unknown>>('GET', `/api/conversations/${conversationId}`).catch(
      (): undefined => undefined
    );
    if (!raw) return undefined;
    const extra = (raw.extra ?? {}) as Record<string, unknown>;
    const assistant = (raw.assistant ?? {}) as Record<string, unknown>;
    return {
      name: typeof raw.name === 'string' ? raw.name : conversationId,
      assistantId: typeof assistant.id === 'string' && assistant.id ? assistant.id : undefined,
      position: typeof extra.position === 'string' && extra.position ? extra.position : undefined,
      teamId: typeof extra.team_id === 'string' && extra.team_id ? extra.team_id : undefined,
      workspace: typeof extra.workspace === 'string' && extra.workspace ? extra.workspace : undefined,
    };
  },
  readUsage: readUsageFromTelemetry,
  lastAssistantExcerpt: lastAssistantExcerptFrom,
  askEngine: contextStewardDecision,
  sendCompact: async (conversationId) => {
    // Hidden: persisted and delivered to the agent, but no row in the flow —
    // the person sees the steward's own line, not the plumbing. The adapter
    // answers this marker with pi's compact RPC (contextStewardCore).
    await httpRequest('POST', `/api/conversations/${conversationId}/messages`, {
      content: STEWARD_COMPACT_MESSAGE,
      files: [],
      hidden: true,
    });
  },
  createPart: async (conversationId, title) => {
    const conversation = await httpRequest<Record<string, unknown>>('GET', `/api/conversations/${conversationId}`);
    const extra = (conversation.extra ?? {}) as Record<string, unknown>;
    const assistant = (conversation.assistant ?? {}) as Record<string, unknown>;
    if (typeof assistant.id !== 'string' || !assistant.id) throw new Error('conversation has no assistant to carry');
    const workspace = typeof extra.workspace === 'string' ? extra.workspace : undefined;
    const position = typeof extra.position === 'string' && extra.position ? extra.position : undefined;
    const body = {
      name: title,
      assistant: { id: assistant.id },
      extra: {
        ...(workspace ? { workspace, custom_workspace: true } : {}),
        ...(position ? { position } : {}),
      },
    };
    const created = await httpRequest<Record<string, unknown>>('POST', '/api/conversations', body);
    if (typeof created.id !== 'string' || !created.id) throw new Error('conversation create returned no id');
    return { id: created.id };
  },
  renameConversation: async (conversationId, name) => {
    await httpRequest('PATCH', `/api/conversations/${conversationId}`, { name, name_source: 'user' });
  },
  log: (...args) => console.log(...args),
});

/** The bridge entry: one finished turn, one check. */
export const runContextSteward = (conversationId: string): Promise<ContextStewardRunResult> =>
  runContextStewardIn(prodDeps(), state, inFlight, conversationId);

/** Test-only: wipes per-conversation state. */
export const resetContextStewardStateForTest = (): void => {
  state.clear();
  inFlight.clear();
};
