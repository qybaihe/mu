/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createBrowserNotificationController,
  truncateConversationName,
  CONVERSATION_NAME_MAX_LENGTH,
} from '@/renderer/hooks/system/notification/browserNotificationCore';

describe('truncateConversationName', () => {
  it('returns a short name unchanged (trimmed)', () => {
    expect(truncateConversationName('  My chat  ')).toBe('My chat');
  });

  it('keeps a name exactly at the limit', () => {
    const exact = 'a'.repeat(CONVERSATION_NAME_MAX_LENGTH);
    expect(truncateConversationName(exact)).toBe(exact);
  });

  it('truncates from the end and appends an ellipsis when over the limit', () => {
    const long = 'a'.repeat(CONVERSATION_NAME_MAX_LENGTH + 5);
    expect(truncateConversationName(long)).toBe(`${'a'.repeat(CONVERSATION_NAME_MAX_LENGTH)}…`);
  });

  it('honors a custom max length', () => {
    expect(truncateConversationName('abcdef', 3)).toBe('abc…');
  });
});

describe('createBrowserNotificationController.onStreamMessage', () => {
  const makeDeps = (allowed = true) => {
    const show = vi.fn();
    const bodyFor = vi.fn((kind: string) => kind);
    const controller = createBrowserNotificationController({
      shouldShow: () => allowed,
      show,
      bodyFor,
    });
    return { show, bodyFor, controller };
  };

  it('shows a turn-completed notification on a finish stream message', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({ type: 'finish', conversation_id: 'c1', turn_id: 't1' });
    expect(show).toHaveBeenCalledWith({ body: 'turnCompleted', conversationId: 'c1', kind: 'turnCompleted' });
  });

  it('passes the conversation id to bodyFor so the body can name the conversation', () => {
    const { bodyFor, controller } = makeDeps();
    controller.onStreamMessage({ type: 'finish', conversation_id: 'c1', turn_id: 't1' });
    expect(bodyFor).toHaveBeenCalledWith('turnCompleted', 'c1');
  });

  it('shows a confirmation notification on an acp_permission stream message', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({ type: 'acp_permission', conversation_id: 'c2' });
    expect(show).toHaveBeenCalledWith({ body: 'confirmation', conversationId: 'c2', kind: 'confirmation' });
  });

  it('shows a confirmation notification on a permission stream message (built-in agent)', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({ type: 'permission', conversation_id: 'c3' });
    expect(show).toHaveBeenCalledWith({ body: 'confirmation', conversationId: 'c3', kind: 'confirmation' });
  });

  it('shows a confirmation notification on an ask stream message', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({ type: 'ask', conversation_id: 'c4', msg_id: 'm4' });
    expect(show).toHaveBeenCalledWith({ body: 'confirmation', conversationId: 'c4', kind: 'confirmation' });
  });

  it('dedups repeated confirmation frames carrying the same message id', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({ type: 'acp_permission', conversation_id: 'c1', msg_id: 'm1' });
    controller.onStreamMessage({ type: 'acp_permission', conversation_id: 'c1', msg_id: 'm1' });
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('notifies again for a different confirmation message id', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({ type: 'permission', conversation_id: 'c1', msg_id: 'm1' });
    controller.onStreamMessage({ type: 'permission', conversation_id: 'c1', msg_id: 'm2' });
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('ignores non-terminal stream message types', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({ type: 'thinking', conversation_id: 'c1', turn_id: 't1' });
    controller.onStreamMessage({ type: 'text', conversation_id: 'c1', turn_id: 't1' });
    controller.onStreamMessage({ type: 'start', conversation_id: 'c1', turn_id: 't1' });
    expect(show).not.toHaveBeenCalled();
  });

  it('does not show when the gate is closed', () => {
    const { show, controller } = makeDeps(false);
    controller.onStreamMessage({ type: 'finish', conversation_id: 'c1', turn_id: 't1' });
    controller.onStreamMessage({ type: 'acp_permission', conversation_id: 'c1' });
    expect(show).not.toHaveBeenCalled();
  });

  it('dedups repeated finish for the same turn_id', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({ type: 'finish', conversation_id: 'c1', turn_id: 't1' });
    controller.onStreamMessage({ type: 'finish', conversation_id: 'c1', turn_id: 't1' });
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('ignores messages without a type', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({ conversation_id: 'c1' });
    expect(show).not.toHaveBeenCalled();
  });
});
