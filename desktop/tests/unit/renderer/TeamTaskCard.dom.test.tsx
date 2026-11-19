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
});
