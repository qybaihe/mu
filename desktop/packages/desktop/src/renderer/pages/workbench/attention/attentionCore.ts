/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure core of the Team Workbench "Needs your attention" list.
 *
 * Mirrors DS Bot's attention semantics: live items (approvals and questions) exist only
 * while the conversation waits on the person — answered or aborted turns drop them; failed
 * runs persist until the person marks them handled, one reminder per conversation, so a
 * stale clear can never remove a newer failure and opening the chat removes nothing.
 */

export type AttentionLiveKind = 'approval' | 'question';
export type AttentionKind = AttentionLiveKind | 'failure';

/** One pending approval/question frame: which confirmation id, in which conversation, seen when. */
export type AttentionWaitingItem = { id: string; kind: AttentionLiveKind; at: number };

/** One persisted failure reminder: destination and time only — error details stay in the conversation. */
export type AttentionFailure = { id: string; conversationId: string; at: number; teamId?: string; slotId?: string };

/** The whole derived state the panel renders: live waits per conversation plus the persisted failures. */
export type AttentionCoreState = {
  waiting: ReadonlyMap<string, ReadonlyMap<string, AttentionWaitingItem>>;
  failures: readonly AttentionFailure[];
};

export type AttentionItem = {
  /** Stable row key: `kind:conversation:id` for live items, `failure:id` for failures. */
  key: string;
  kind: AttentionKind;
  conversationId: string;
  at: number;
};

export const ATTENTION_FAILURES_LIMIT = 100;

export const emptyAttentionState = (): AttentionCoreState => ({ waiting: new Map(), failures: [] });

const setWaiting = (
  state: AttentionCoreState,
  conversationId: string,
  ids: Map<string, AttentionWaitingItem>
): AttentionCoreState => {
  const waiting = new Map(state.waiting);
  waiting.set(conversationId, ids);
  return { ...state, waiting };
};

/** A permission/acp_permission (approval) or ask (question) frame began waiting on the person. */
export const applyWaitingFrame = (
  state: AttentionCoreState,
  conversationId: string,
  kind: AttentionLiveKind,
  confirmationId: string,
  at: number
): AttentionCoreState => {
  if (!conversationId || !confirmationId) return state;
  const current = state.waiting.get(conversationId) ?? new Map<string, AttentionWaitingItem>();
  const existing = current.get(confirmationId);
  if (existing && existing.kind === kind) return state;
  const next = new Map(current);
  next.set(confirmationId, { id: confirmationId, kind, at });
  return setWaiting(state, conversationId, next);
};

/** The turn ended (answered, aborted or errored): nothing in this conversation waits any more. */
export const clearWaitingForConversation = (state: AttentionCoreState, conversationId: string): AttentionCoreState => {
  if (!state.waiting.has(conversationId)) return state;
  const waiting = new Map(state.waiting);
  waiting.delete(conversationId);
  return { ...state, waiting };
};

/** One confirmation was answered: drop exactly it, keeping any sibling pending confirmations. */
export const clearWaitingById = (
  state: AttentionCoreState,
  conversationId: string,
  confirmationId: string
): AttentionCoreState => {
  const current = state.waiting.get(conversationId);
  if (!current?.has(confirmationId)) return state;
  const next = new Map(current);
  next.delete(confirmationId);
  return setWaiting(state, conversationId, next);
};

/**
 * Records a failure. One reminder per conversation: a newer failure for the same conversation
 * replaces the older one (fresh identity), so a stale "mark handled" click cannot clear it.
 */
export const recordFailure = (state: AttentionCoreState, failure: AttentionFailure): AttentionCoreState => {
  if (!failure.conversationId || !failure.id) return state;
  const kept = state.failures.filter((item) => item.conversationId !== failure.conversationId);
  return { ...state, failures: [...kept, failure].slice(-ATTENTION_FAILURES_LIMIT) };
};

/** The person marked a failure handled. False when the id is gone (already cleared or replaced). */
export const clearFailureById = (state: AttentionCoreState, id: string): AttentionCoreState => {
  if (!id) return state;
  const failures = state.failures.filter((item) => item.id !== id);
  if (failures.length === state.failures.length) return state;
  return { ...state, failures };
};

/** Deleted conversations do not appear: drop every failure whose destination is gone. */
export const pruneFailures = (
  state: AttentionCoreState,
  keepConversationIds: ReadonlySet<string>
): AttentionCoreState => {
  const failures = state.failures.filter((item) => keepConversationIds.has(item.conversationId));
  if (failures.length === state.failures.length) return state;
  return { ...state, failures };
};

/**
 * The flat item list the panel renders: approvals first, then questions (both oldest first —
 * the thing waiting longest is the thing to answer first), then failures newest first (the
 * latest failure of each conversation is the reminder that replaced any older one).
 */
export const deriveAttentionItems = (state: AttentionCoreState): AttentionItem[] => {
  const approvals: AttentionItem[] = [];
  const questions: AttentionItem[] = [];
  for (const [conversationId, items] of state.waiting) {
    for (const item of items.values()) {
      const bucket = item.kind === 'approval' ? approvals : questions;
      bucket.push({ key: `${item.kind}:${conversationId}:${item.id}`, kind: item.kind, conversationId, at: item.at });
    }
  }
  approvals.sort((a, b) => a.at - b.at);
  questions.sort((a, b) => a.at - b.at);
  const failures = state.failures
    .filter((item) => item.conversationId)
    .map<AttentionItem>((item) => ({
      key: `failure:${item.id}`,
      kind: 'failure',
      conversationId: item.conversationId,
      at: item.at,
    }))
    .sort((a, b) => b.at - a.at);
  return [...approvals, ...questions, ...failures];
};

/** The sidebar badge: every attention item counts, handled failures are already gone. */
export const attentionBadgeCount = (state: AttentionCoreState): number => deriveAttentionItems(state).length;
