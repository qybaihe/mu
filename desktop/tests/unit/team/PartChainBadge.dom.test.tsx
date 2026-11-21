/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The part-chain badge (M2): it appears exactly when partChainOf can prove a
 * chain, names the current part, and its dropdown jumps between the chain's
 * conversations. i18n mocked to keys with interpolations inlined.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params === undefined) return key;
      return `${key}:${Object.entries(params)
        .map(([name, value]) => `${name}=${value}`)
        .join(',')}`;
    },
  }),
}));
const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
let knownConversations: Array<{ id: string; name: string; modified_at?: number; extra?: unknown }> = [];
vi.mock('@renderer/hooks/context/ConversationHistoryContext', () => ({
  useConversationHistoryContext: () => ({ conversations: knownConversations }),
}));
import PartChainBadge from '@renderer/pages/team/components/PartChainBadge';
import {
  appendContextStewardNote,
  resetContextStewardNotesForTest,
} from '@renderer/pages/team/core/notes/contextStewardNotes';

afterEach(() => {
  cleanup();
  navigate.mockClear();
  knownConversations = [];
  resetContextStewardNotesForTest();
});

const ONE_SWITCH = [
  { id: 'old', name: '货代 (part 1)', modified_at: 10, extra: { position: 'forwarder' } },
  { id: 'fresh', name: '货代', modified_at: 20, extra: { position: 'forwarder' } },
];

describe('PartChainBadge', () => {
  it('stays absent without a provable chain', () => {
    knownConversations = [{ id: 'plain', name: '普通会话' }];
    const { container } = render(<PartChainBadge conversationId='plain' />);
    expect(container.textContent).toBe('');
    expect(screen.queryByTestId('part-chain-badge')).toBeNull();
  });

  it('names the fresh part part 2 and drops a dropdown listing both parts', async () => {
    knownConversations = ONE_SWITCH;
    // The ⚡ receipt pair a real switch writes — the chain's exact edge.
    appendContextStewardNote('old', {
      action: 'switch',
      reason: 'r',
      oldConversationId: 'old',
      newConversationId: 'fresh',
      oldTitle: '货代 (part 1)',
      newTitle: '货代',
      part: 1,
      tokens: 1,
      contextWindow: 2,
      percent: 0.5,
    });
    render(<PartChainBadge conversationId='fresh' />);
    const badge = screen.getByTestId('part-chain-badge');
    expect(badge.textContent).toBe('contextSteward.partBadge.part:part=2');
    await userEvent.click(badge);
    const entries = await screen.findAllByTestId('part-chain-entry');
    expect(entries).toHaveLength(2);
    expect(entries[0].textContent).toContain('contextSteward.partBadge.part:part=1');
    expect(entries[0].textContent).toContain('货代 (part 1)');
    expect(entries[1].textContent).toContain('contextSteward.partBadge.part:part=2');
    expect(entries[1].textContent).toContain('contextSteward.partBadge.current');
  });

  it('jumps to the chosen part; the current one stays disabled', async () => {
    knownConversations = ONE_SWITCH;
    appendContextStewardNote('old', {
      action: 'switch',
      reason: 'r',
      oldConversationId: 'old',
      newConversationId: 'fresh',
      oldTitle: '货代 (part 1)',
      newTitle: '货代',
      part: 1,
      tokens: 1,
      contextWindow: 2,
      percent: 0.5,
    });
    render(<PartChainBadge conversationId='fresh' />);
    await userEvent.click(screen.getByTestId('part-chain-badge'));
    const entries = await screen.findAllByTestId('part-chain-entry');
    // fireEvent: an Arco menu item's div carries pointer-events styling userEvent refuses.
    fireEvent.click(entries[0]);
    expect(navigate).toHaveBeenCalledWith('/conversation/old');
    expect(navigate).toHaveBeenCalledTimes(1); // The disabled current entry never fires.
  });
});
