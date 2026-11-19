/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPositionConversation, positionCreateParams } from '@renderer/pages/positions/openPosition';
import type { PositionInfo } from '@/common/chat/positions/positionLibraryCore';
import type { TChatConversation } from '@/common/config/storage';

const position: PositionInfo = { name: 'forwarder', displayName: '货代', description: '货代岗位', body: '正文' };

/** The bridge and the conversation create, as the app would answer them. */
const invokeEnsure = vi.hoisted(() => vi.fn());
const invokeCreate = vi.hoisted(() => vi.fn());
const invokeAssistantGet = vi.hoisted(() => vi.fn());

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: { create: { invoke: invokeCreate } },
    assistants: { get: { invoke: invokeAssistantGet } },
  },
}));
vi.mock('@/common/chat/positions/positionBridge', () => ({
  positionBridge: { ensureWorkspace: { invoke: invokeEnsure } },
}));
vi.mock('@renderer/pages/guid/utils/assistantDefaults', () => ({
  resolveGuidAssistantDefaults: (detail: unknown) => ({
    modelId: (detail as { defaults?: { model?: { value?: string } } }).defaults?.model?.value,
    skillIds: [],
    disabledBuiltinSkillIds: [],
    mcpIds: [],
  }),
}));
vi.mock('@renderer/utils/emitter', () => ({ emitter: { emit: vi.fn() } }));

/** Minimal conversations, as far as the open flow reads them. */
const conversationsWith = (extra?: Record<string, unknown>): TChatConversation[] =>
  [{ id: 'existing', modified_at: 2, extra }] as unknown as TChatConversation[];

describe('positionCreateParams', () => {
  it('binds the conversation to the position: display name outside, marker and workspace by the id', () => {
    expect(positionCreateParams(position, 'E:/data/positions/forwarder', { id: 'bare:1', modelId: 'zai/glm' })).toEqual(
      {
        name: '货代',
        assistant: { id: 'bare:1', conversation_overrides: { model: 'zai/glm' } },
        extra: { workspace: 'E:/data/positions/forwarder', custom_workspace: true, position: 'forwarder' },
      }
    );
  });

  it('omits the model override when the assistant has none resolved', () => {
    expect(positionCreateParams(position, 'E:/data/positions/forwarder', { id: 'bare:1' })).toEqual({
      name: '货代',
      assistant: { id: 'bare:1' },
      extra: { workspace: 'E:/data/positions/forwarder', custom_workspace: true, position: 'forwarder' },
    });
  });
});

describe('openPositionConversation', () => {
  const messages = { noAssistant: 'no-assistant', prepareFailed: 'prepare-failed', openFailed: 'open-failed' };
  const deps = (over: Record<string, unknown> = {}) => ({
    conversations: [] as TChatConversation[],
    assistantId: 'bare:1',
    navigate: vi.fn(),
    onError: vi.fn(),
    messages,
    ...over,
  });

  beforeEach(() => {
    invokeEnsure.mockReset();
    invokeCreate.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reuses the position’s existing conversation: navigate only, nothing created', async () => {
    const navigate = vi.fn();
    await openPositionConversation(
      position,
      deps({ conversations: conversationsWith({ position: 'forwarder' }), navigate })
    );
    expect(invokeEnsure).not.toHaveBeenCalled();
    expect(invokeCreate).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/conversation/existing');
  });

  it('creates on first open: workspace prepared before the conversation, then navigate', async () => {
    invokeEnsure.mockResolvedValue({ ok: true, data: { workspace: 'E:/data/positions/forwarder', changed: true } });
    invokeAssistantGet.mockResolvedValue({ defaults: { model: { mode: 'fixed', value: 'zai/glm' } } });
    invokeCreate.mockResolvedValue({ id: 'fresh' });
    const navigate = vi.fn();
    await openPositionConversation(position, deps({ navigate }));
    expect(invokeEnsure).toHaveBeenCalledWith({ name: 'forwarder' });
    expect(invokeEnsure.mock.invocationCallOrder[0]).toBeLessThan(invokeCreate.mock.invocationCallOrder[0]);
    expect(invokeCreate.mock.calls[0][0].assistant).toEqual({
      id: 'bare:1',
      conversation_overrides: { model: 'zai/glm' },
    });
    expect(invokeCreate.mock.calls[0][0].extra).toEqual({
      workspace: 'E:/data/positions/forwarder',
      custom_workspace: true,
      position: 'forwarder',
    });
    expect(navigate).toHaveBeenCalledWith('/conversation/fresh');
  });

  it('reports a missing assistant and prepares nothing', async () => {
    await openPositionConversation(position, deps({ assistantId: null }));
    expect(invokeEnsure).not.toHaveBeenCalled();
  });

  it('reports a failed workspace preparation without creating the conversation', async () => {
    invokeEnsure.mockResolvedValue({ ok: false, error: { code: 'failed', message: 'boom' } });
    const onError = vi.fn();
    await openPositionConversation(position, deps({ onError }));
    expect(onError).toHaveBeenCalledWith('prepare-failed');
    expect(invokeCreate).not.toHaveBeenCalled();
  });

  it('creates without a model when the assistant detail cannot be read', async () => {
    invokeEnsure.mockResolvedValue({ ok: true, data: { workspace: 'E:/data/positions/forwarder', changed: true } });
    invokeAssistantGet.mockRejectedValue(new Error('detail down'));
    invokeCreate.mockResolvedValue({ id: 'fresh' });
    const navigate = vi.fn();
    await openPositionConversation(position, deps({ navigate }));
    expect(invokeCreate.mock.calls[0][0].assistant).toEqual({ id: 'bare:1' });
    expect(navigate).toHaveBeenCalledWith('/conversation/fresh');
  });

  it('reports a failed conversation create and does not navigate', async () => {
    invokeEnsure.mockResolvedValue({ ok: true, data: { workspace: 'E:/data/positions/forwarder', changed: true } });
    invokeCreate.mockRejectedValue(new Error('backend down'));
    const navigate = vi.fn();
    const onError = vi.fn();
    await openPositionConversation(position, deps({ navigate, onError }));
    expect(onError).toHaveBeenCalledWith('open-failed');
    expect(navigate).not.toHaveBeenCalled();
  });
});
