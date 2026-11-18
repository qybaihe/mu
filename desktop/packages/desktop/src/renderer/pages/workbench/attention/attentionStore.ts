/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The attention store: subscribes to the same backend wire the sidebar waiting-icon uses
 * (message.stream permission/ask frames, confirmation.remove, turn.completed) plus the team
 * wire (team.runFailed), keeps the DS-Bot-derived core state (`attentionCore.ts`), persists
 * failures in localStorage (they survive a restart and only a person's click removes them)
 * and names every destination from the raw conversation list — team member rows included,
 * which the sidebar filters out of its own list.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { ipcBridge } from '@/common';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';
import type { ITeamRunEvent } from '@/common/types/team/teamTypes';
import {
  extractConfirmationId,
  isWaitingConfirmationStreamMessage,
} from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';
import {
  applyWaitingFrame,
  attentionBadgeCount,
  clearFailureById,
  clearWaitingById,
  clearWaitingForConversation,
  deriveAttentionItems,
  emptyAttentionState,
  pruneFailures,
  recordFailure,
  type AttentionCoreState,
  type AttentionFailure,
  type AttentionItem,
  type AttentionLiveKind,
} from './attentionCore';

const STORAGE_KEY = 'mu.workbench.attention.failures';

export type AttentionSnapshot = AttentionCoreState & {
  items: readonly AttentionItem[];
  badgeCount: number;
  conversationNames: ReadonlyMap<string, string>;
};

type AttentionListener = () => void;

const listeners = new Set<AttentionListener>();
let coreState: AttentionCoreState = emptyAttentionState();
let conversationNamesState = new Map<string, string>();
let conversationIdsState = new Set<string>();
let initialized = false;
let snapshotState: AttentionSnapshot = buildSnapshot();

function buildSnapshot(): AttentionSnapshot {
  return {
    ...coreState,
    items: deriveAttentionItems(coreState),
    badgeCount: attentionBadgeCount(coreState),
    conversationNames: conversationNamesState,
  };
}

const emitChange = () => {
  snapshotState = buildSnapshot();
  listeners.forEach((listener) => listener());
};

const setCoreState = (next: AttentionCoreState) => {
  if (next === coreState) return;
  coreState = next;
  persistFailures();
  emitChange();
};

const subscribeAttention = (listener: AttentionListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getAttentionSnapshot = (): AttentionSnapshot => snapshotState;

// --- persistence (failures only; live waits are re-derived from the wire) ---

const isFailureShape = (value: unknown): value is AttentionFailure => {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<AttentionFailure>;
  return typeof item.id === 'string' && typeof item.conversationId === 'string' && typeof item.at === 'number';
};

const loadPersistedFailures = (): readonly AttentionFailure[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isFailureShape);
  } catch {
    return [];
  }
};

const persistFailures = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(coreState.failures));
  } catch {
    // Storage may be unavailable (private mode, quota): failures simply don't survive a restart.
  }
};

const newFailureId = (): string => {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  return `f-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

// --- conversation list: names for every destination, team member rows included ---

const refreshConversations = () => {
  void ipcBridge.database.getUserConversations
    .invoke({ limit: 10000 })
    .then((result) => {
      const items = Array.isArray(result?.items) ? result.items : [];
      conversationIdsState = new Set(items.map((conversation) => conversation.id));
      conversationNamesState = new Map(
        items
          .map((conversation) => [conversation.id, conversation.name?.trim() || ''] as const)
          .filter((entry): entry is [string, string] => Boolean(entry[1]))
      );
      // Deleted chats do not appear; also drop live waits of conversations that are gone.
      let next = pruneFailures(coreState, conversationIdsState);
      for (const conversationId of coreState.waiting.keys()) {
        if (!conversationIdsState.has(conversationId)) next = clearWaitingForConversation(next, conversationId);
      }
      if (next !== coreState) {
        coreState = next;
        persistFailures();
      }
      emitChange();
    })
    .catch(() => {
      // The list stays as it was; the next listChanged event refreshes it.
    });
};

// --- the wire ---

const onStreamMessage = (message: IResponseMessage) => {
  if (!message.conversation_id) return;
  if (isWaitingConfirmationStreamMessage(message.type)) {
    const confirmationId = extractConfirmationId(message);
    if (!confirmationId) return;
    const kind: AttentionLiveKind = message.type === 'ask' ? 'question' : 'approval';
    setCoreState(
      applyWaitingFrame(coreState, message.conversation_id, kind, confirmationId, message.created_at ?? Date.now())
    );
    return;
  }
  // Terminal frames (finish / error) end the conversation's turn: whatever it asked for is
  // answered or aborted — the sidebar clears its waiting icon on the same signal.
  if (message.type === 'finish' || message.type === 'error') {
    setCoreState(clearWaitingForConversation(coreState, message.conversation_id));
  }
};

const onConfirmationRemove = (event: { conversation_id?: string; id?: string }) => {
  if (!event?.conversation_id || !event.id) return;
  setCoreState(clearWaitingById(coreState, event.conversation_id, event.id));
};

const onTurnCompleted = (event: { session_id?: string; state?: string }) => {
  if (!event?.session_id) return;
  // A terminal error ends the turn and records one failure reminder; whatever the
  // conversation was asking for is dead with it. A turn that completes INTO
  // waiting_confirmation keeps its live asks, of course.
  if (event.state === 'error') {
    let next = recordFailure(coreState, { id: newFailureId(), conversationId: event.session_id, at: Date.now() });
    next = clearWaitingForConversation(next, event.session_id);
    setCoreState(next);
    return;
  }
  if (event.state === 'ai_waiting_input' || event.state === 'stopped') {
    setCoreState(clearWaitingForConversation(coreState, event.session_id));
  }
};

const onTeamRunFailed = (event: ITeamRunEvent) => {
  if (!event?.team_id) return;
  // The run names its slot, not its conversation: resolve through the team record, then
  // record one failure per conversation (the same slot failing twice replaces its reminder).
  void ipcBridge.team.get
    .invoke({ id: event.team_id })
    .then((team) => {
      const conversationId = team?.assistants?.find(
        (assistant) => assistant.slot_id === event.target_slot_id
      )?.conversation_id;
      if (!conversationId) return;
      setCoreState(
        recordFailure(coreState, {
          id: newFailureId(),
          conversationId,
          at: Date.now(),
          teamId: event.team_id,
          slotId: event.target_slot_id,
        })
      );
    })
    .catch(() => {
      // The team record is gone (deleted mid-run): nothing to point at, nothing to record.
    });
};

const initializeAttentionStore = () => {
  if (initialized) return;
  initialized = true;
  coreState = { waiting: new Map(), failures: loadPersistedFailures() };
  emitChange(); // persisted failures render at once; names arrive when the list lands
  refreshConversations();
  ipcBridge.conversation.responseStream.on(onStreamMessage);
  ipcBridge.conversation.confirmation.remove.on(onConfirmationRemove);
  ipcBridge.conversation.turnCompleted.on(onTurnCompleted);
  ipcBridge.team.runFailed.on(onTeamRunFailed);
  ipcBridge.conversation.listChanged.on((event) => {
    // Prune only what the loaded list actually knew: an event racing the first
    // conversation fetch (empty id set) must not wipe every persisted failure —
    // the refresh right after reconciles against the authoritative list.
    if (event.action === 'deleted' && event.conversation_id && conversationIdsState.has(event.conversation_id)) {
      let next = pruneFailures(
        coreState,
        new Set([...conversationIdsState].filter((id) => id !== event.conversation_id))
      );
      next = clearWaitingForConversation(next, event.conversation_id);
      conversationIdsState.delete(event.conversation_id);
      conversationNamesState.delete(event.conversation_id);
      setCoreState(next);
    }
    refreshConversations();
  });
};

/** The attention snapshot for any component: the panel, the sidebar badge. */
export const useAttentionSnapshot = (): AttentionSnapshot => {
  useEffect(() => {
    initializeAttentionStore();
  }, []);
  return useSyncExternalStore(subscribeAttention, getAttentionSnapshot, getAttentionSnapshot);
};

/** Marks one failure handled. Live approvals/questions answer themselves through the wire. */
export const useDismissAttentionFailure = () => {
  useEffect(() => {
    initializeAttentionStore();
  }, []);
  return useCallback((failureKey: string) => {
    const id = failureKey.startsWith('failure:') ? failureKey.slice('failure:'.length) : '';
    if (!id) return;
    setCoreState(clearFailureById(coreState, id));
  }, []);
};

/** Test hook: reset the store to empty — initialization included, so the next mount re-subscribes and re-reads — and forget persistence, so each test starts clean. */
export const resetAttentionStoreForTest = () => {
  initialized = false;
  coreState = emptyAttentionState();
  conversationNamesState = new Map();
  conversationIdsState = new Set();
  snapshotState = buildSnapshot();
  listeners.forEach((listener) => listener());
};
