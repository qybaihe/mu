/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The recipe panel's per-role model pick (batch L ①): every kept role row
 * carries a model dropdown (default or one of the configured models), a role
 * whose recipe declares the cross-model hint shows it as a badge, and the
 * picks ride the plan the dialog creates from.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamRecipe } from '@/common/chat/team/recipes/recipeCore';

const state = vi.hoisted(() => {
  const worker = { name: 'worker', displayName: '执行', description: '干活', body: '' };
  const reviewer = { name: 'reviewer', displayName: '评审', description: '核验', body: '' };
  const recipes: TeamRecipe[] = [
    {
      id: 'model-crew',
      source: 'custom',
      displayName: '模型队',
      description: '两席',
      pipeline: '执行 → 评审',
      roles: [
        { positionId: 'worker', roleName: '执行', duty: '干活' },
        { positionId: 'reviewer', roleName: '评审', duty: '核验', modelHint: '应异于产出岗' },
      ],
    },
  ];
  return { recipes, positions: [worker, reviewer] };
});

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
vi.mock('@/renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({ theme: 'light', fontScale: 1 }),
}));
vi.mock('@/renderer/pages/positions/usePositionRoster', () => ({
  usePositionRoster: () => ({ positions: state.positions, isLoading: false }),
  refreshPositions: vi.fn(async () => undefined),
}));
vi.mock('@/common/chat/team/recipes/recipeBridge', () => ({
  recipeBridge: { list: { invoke: vi.fn(async () => ({ ok: true as const, data: state.recipes })) } },
}));
vi.mock('@/common/chat/team/positions/positionBridge', () => ({
  positionBridge: { createPosition: { invoke: vi.fn() } },
}));
import RecipePanel from '@renderer/pages/team/createGroupChat/RecipePanel';

describe('RecipePanel per-role model picks', () => {
  afterEach(() => cleanup());

  it('shows every role a default-or-configured model dropdown, the hinted role its badge, and hands the picks to the plan', async () => {
    const plans: unknown[] = [];
    render(
      <RecipePanel
        open
        onPlan={(plan) => plans.push(plan)}
        onReadyToCreate={() => {}}
        busy={false}
        models={['anthropic/claude-sonnet', 'openai/gpt-5']}
      />
    );
    fireEvent.click(await screen.findByTestId('recipe-card-model-crew'));
    // Both kept roles carry a model dropdown; the review role shows the hint badge.
    expect(screen.getByTestId('recipe-role-model-0')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-role-model-1')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-role-modelhint-1').textContent).toContain('应异于产出岗');
    expect(screen.queryByTestId('recipe-role-modelhint-0')).not.toBeInTheDocument();
    // The plan starts both seats on the default model.
    await waitFor(() => expect(plans.length).toBeGreaterThan(0));
    expect((plans.at(-1) as { modelsBySeat: string[] }).modelsBySeat).toEqual(['', '']);
    // Picking a model for the review seat rides the plan.
    fireEvent.click(screen.getByTestId('recipe-role-model-1'));
    fireEvent.click(await screen.findByText('openai/gpt-5'));
    await waitFor(() =>
      expect((plans.at(-1) as { modelsBySeat: string[] }).modelsBySeat).toEqual(['', 'openai/gpt-5'])
    );
  });
});
