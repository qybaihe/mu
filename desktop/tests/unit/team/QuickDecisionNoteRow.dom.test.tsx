/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One ⚡ receipt row: the marker names the team it reused or the position it
 * suggests, the receipt line under it, and the basis (model / duration /
 * confidence / cache) one click away. i18n is mocked to the key with
 * interpolations inlined, so the assertions read the composed strings.
 */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QuickDecisionNote } from '@renderer/pages/team/core/quickDecisionNotes';

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
import QuickDecisionNoteRow from '@renderer/pages/team/components/QuickDecisionNoteRow';

afterEach(cleanup);

const reuseNote: QuickDecisionNote = {
  id: 'n1',
  conversationId: 'c1',
  createdAt: 1,
  kind: 'reuse',
  input: '查一下 CNS 客户',
  teamName: '货代小队',
  teamId: 't1',
  leadConversationId: 'lead',
  reason: '同域任务',
  confidence: 0.95,
  model: 'cheap-model',
  durationMs: 800,
  cached: false,
};

const rejectNote: QuickDecisionNote = {
  id: 'n2',
  conversationId: 'c1',
  createdAt: 2,
  kind: 'reject',
  input: '做一个宣传视频',
  suggestLabel: '视频实验室(video-lab)',
  reason: '视频域',
  confidence: 0.93,
  model: 'cheap-model',
  durationMs: 400,
  cached: true,
};

describe('QuickDecisionNoteRow', () => {
  it('a reuse row names the team and quotes the task', () => {
    render(<QuickDecisionNoteRow note={reuseNote} />);
    expect(screen.getByTestId('quick-decision-title').textContent).toContain('team=货代小队');
    expect(screen.getByTestId('quick-decision-body').textContent).toContain('reason=同域任务');
    expect(screen.getByTestId('quick-decision-task').textContent).toContain('查一下 CNS 客户');
  });
  it('a reject row names the suggested position', () => {
    render(<QuickDecisionNoteRow note={rejectNote} />);
    expect(screen.getByTestId('quick-decision-title').textContent).toContain('quickDecision.reject.title');
    expect(screen.getByTestId('quick-decision-body').textContent).toContain('suggest=视频实验室(video-lab)');
  });
  it('the basis popover carries model, duration, confidence and the cache flag', async () => {
    const user = userEvent.setup();
    render(<QuickDecisionNoteRow note={reuseNote} />);
    await user.click(screen.getByTestId('quick-decision-basis-trigger'));
    expect(await screen.findByTestId('quick-decision-basis')).toBeTruthy();
    const basis = screen.getByTestId('quick-decision-basis').textContent ?? '';
    expect(basis).toContain('cheap-model');
    expect(basis).toContain('800ms');
    expect(basis).toContain('0.95');
    expect(basis).toContain('quickDecision.details.fresh');
  });
  it('a cached hit says so in the basis', async () => {
    const user = userEvent.setup();
    render(<QuickDecisionNoteRow note={rejectNote} />);
    await user.click(screen.getByTestId('quick-decision-basis-trigger'));
    const basis = screen.getByTestId('quick-decision-basis').textContent ?? '';
    expect(basis).toContain('quickDecision.details.cached');
  });
});
