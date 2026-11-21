/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITeamTaskItem, TeamAssistant } from '@/common/types/team/teamTypes';
import TeamTaskCard from '@/renderer/pages/conversation/Messages/components/TeamTaskCard';
import { clearTaskVerifications, recordTaskVerification } from '@renderer/pages/team/core/notes/taskVerificationNotes';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { files?: string }) => (params?.files ? `${key}:${params.files}` : key),
    i18n: { language: 'en-US' },
  }),
}));

const member = (slotId: string, name: string): TeamAssistant => ({
  slot_id: slotId,
  conversation_id: `conv-${slotId}`,
  role: 'teammate',
  assistant_backend: 'claude',
  icon: '/api/assets/logos/ai-major/claude.svg',
  assistant_name: name,
  status: 'idle',
  context_reset: { supported: true, availability: 'ready' },
});

const task = (overrides: Partial<ITeamTaskItem> = {}): ITeamTaskItem => ({
  id: 't1',
  team_id: 'team-1',
  subject: 'architecture review',
  description: 'Read the schema and report risks.',
  status: 'pending',
  owner: 'slot-a',
  blocked_by: [],
  blocks: [],
  created_at: 100,
  updated_at: 200,
  ...overrides,
});

const renderCard = (overrides: Partial<ITeamTaskItem> = {}, tasks: ITeamTaskItem[] = [], blockers: string[] = []) =>
  render(
    <TeamTaskCard
      task={task(overrides)}
      tasks={[task(overrides), ...tasks]}
      members={[member('slot-a', 'Captain'), member('slot-b', 'Scout')]}
      cyclicBlockerIds={new Set(blockers)}
    />
  );

describe('TeamTaskCard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    clearTaskVerifications();
  });

  it('renders the compact single line: subject, status pill, owner avatar alt', () => {
    renderCard();
    const card = screen.getByTestId('team-task-card');
    expect(card).toHaveTextContent('architecture review');
    expect(card).toHaveTextContent('team.taskCard.status.todo');
    expect(card.getAttribute('data-task-status')).toBe('todo');
    expect(screen.queryByTestId('team-task-card-body')).toBeNull();
  });

  it('expands on the header click and shows owner, times and description', async () => {
    renderCard();
    await userEvent.click(screen.getByTestId('team-task-card-header'));
    const body = screen.getByTestId('team-task-card-body');
    expect(body).toHaveTextContent('Read the schema and report risks.');
    expect(body).toHaveTextContent('team.taskCard.owner');
    expect(body).toHaveTextContent('Captain');
    expect(body).toHaveTextContent('team.taskCard.createdAt');
    expect(body).toHaveTextContent('team.taskCard.updatedAt');
  });

  it('stays one quiet line for a finished task but still opens on demand', async () => {
    renderCard({ id: 't-done', status: 'done' });
    const card = screen.getByTestId('team-task-card');
    expect(card.getAttribute('data-task-status')).toBe('done');
    expect(card).toHaveTextContent('team.taskCard.status.done');
    await userEvent.click(screen.getByTestId('team-task-card-header'));
    expect(screen.getByTestId('team-task-card-body')).toBeTruthy();
  });

  it('labels cancelled and failed terminals separately', () => {
    const { rerender } = renderCard({ status: 'cancelled' });
    expect(screen.getByTestId('team-task-card')).toHaveTextContent('team.taskCard.cancelled');
    rerender(
      <TeamTaskCard
        task={task({ id: 't1', status: 'failed' })}
        tasks={[task({ id: 't1', status: 'failed' })]}
        members={[member('slot-a', 'Captain')]}
        cyclicBlockerIds={new Set()}
      />
    );
    expect(screen.getByTestId('team-task-card')).toHaveTextContent('team.taskCard.failed');
  });

  it('marks a task with an open blocker as blocked and shows the blocker chip', async () => {
    const blocker = task({ id: 't0', subject: 'release prep', status: 'pending' });
    const blocked = task({ id: 't-blocked', blocked_by: ['t0'] });
    render(
      <TeamTaskCard
        task={blocked}
        tasks={[blocker, blocked]}
        members={[member('slot-a', 'Captain')]}
        cyclicBlockerIds={new Set()}
      />
    );
    expect(screen.getByTestId('team-task-card').getAttribute('data-task-status')).toBe('blocked');
    await userEvent.click(screen.getByTestId('team-task-card-header'));
    expect(screen.getByTestId('team-task-blocker')).toHaveTextContent('release prep');
  });

  it('flags cyclic dependencies on the blocker chip', async () => {
    const a = task({ id: 'ta', blocked_by: ['tb'] });
    const b = task({ id: 'tb', subject: 'cycle partner', blocked_by: ['ta'] });
    render(
      <TeamTaskCard
        task={a}
        tasks={[a, b]}
        members={[member('slot-a', 'Captain')]}
        cyclicBlockerIds={new Set(['tb'])}
      />
    );
    await userEvent.click(screen.getByTestId('team-task-card-header'));
    expect(screen.getByTestId('team-task-blocker')).toHaveTextContent('team.taskCard.cyclic');
  });

  it('says unassigned when the task has no owner', async () => {
    renderCard({ id: 't-unowned', owner: undefined });
    await userEvent.click(screen.getByTestId('team-task-card-header'));
    expect(screen.getByTestId('team-task-card-body')).toHaveTextContent('team.taskCard.unassigned');
  });

  it('labels an ownerless open task as claimable 待领', () => {
    renderCard({ id: 't-free', owner: undefined });
    const card = screen.getByTestId('team-task-card');
    expect(card).toHaveTextContent('team.taskCard.status.claimable');
    expect(card.getAttribute('data-claimable')).toBe('true');
    expect(card).not.toHaveTextContent('team.taskCard.blockedClaim');
  });

  it('dims an ownerless blocked task and says it is not claimable yet', async () => {
    const blocker = task({ id: 't-blk', subject: 'blocker source', status: 'pending' });
    const held = task({ id: 't-held', owner: undefined, blocked_by: ['t-blk'] });
    render(
      <TeamTaskCard
        task={held}
        tasks={[blocker, held]}
        members={[member('slot-a', 'Captain')]}
        cyclicBlockerIds={new Set()}
      />
    );
    const card = screen.getByTestId('team-task-card');
    expect(card.getAttribute('data-task-status')).toBe('blocked');
    expect(card.getAttribute('data-claimable')).toBe(null);
    expect(card).toHaveTextContent('team.taskCard.status.blocked');
    await userEvent.click(screen.getByTestId('team-task-card-header'));
    expect(screen.getByTestId('task-claim-blocked')).toHaveTextContent('team.taskCard.blockedClaim');
  });

  it('a done task without a verdict carries the ⚠ pending badge (batch L ②)', () => {
    renderCard({ id: 't-done-unchecked', status: 'completed' });
    const badge = screen.getByTestId('task-verification-badge');
    expect(badge.getAttribute('data-state')).toBe('pending');
    expect(badge).toHaveTextContent('team.taskVerification.pending');
  });

  it('the badge follows the store: ✅ verified once the file check passed, ⚠ again when a re-done task fails it', async () => {
    renderCard({ id: 't-badge', status: 'completed' });
    const badge = screen.getByTestId('task-verification-badge');
    expect(badge.getAttribute('data-state')).toBe('pending');
    recordTaskVerification({
      taskId: 't-badge',
      teamId: 'team-1',
      state: 'verified',
      checkedAt: 1,
      pathCount: 2,
      verifiedCount: 2,
    });
    const verified = await screen.findByTestId('task-verification-badge');
    expect(verified.getAttribute('data-state')).toBe('verified');
    expect(verified).toHaveTextContent('✅');
    expect(verified).toHaveTextContent('team.taskVerification.verified');
    // A task re-done past the last check re-verifies: back to ⚠ until the new check lands.
    recordTaskVerification({
      taskId: 't-badge',
      teamId: 'team-1',
      state: 'pending',
      checkedAt: 2,
      pathCount: 2,
      verifiedCount: 1,
    });
    const pending = await screen.findByTestId('task-verification-badge');
    expect(pending.getAttribute('data-state')).toBe('pending');
  });

  it('a cancelled task never claimed completion: no badge at all', () => {
    renderCard({ id: 't-cancelled', status: 'cancelled' });
    expect(screen.queryByTestId('task-verification-badge')).toBeNull();
  });
});
