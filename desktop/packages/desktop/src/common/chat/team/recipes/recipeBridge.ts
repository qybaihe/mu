/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Team recipes between the window and the main process
 * (process/services/team/recipes/). The window asks for the merged card list
 * (built-ins plus the custom documents under `positions/_shared/recipes/`)
 * and saves an existing group back as a custom recipe.
 */
import { bridge } from '../../../platform/bridge';
import type { KyrnResult } from '../../../kyrn/errors';
import type { RecipeRole, TeamRecipe } from './recipeCore';

/** What the member manager's save sends: the recipe a group becomes. */
export type SaveRecipeParams = {
  id: string;
  displayName: string;
  description: string;
  pipeline: string;
  roles: readonly RecipeRole[];
};

export const recipeBridge = {
  /** The merged recipe list: built-ins first, customs after, in id order. */
  list: bridge.buildProvider<KyrnResult<TeamRecipe[]>, void>('recipes.list'),
  /** Saves one custom recipe document (a colliding id gets a numeric suffix). */
  save: bridge.buildProvider<KyrnResult<TeamRecipe>, SaveRecipeParams>('recipes.save'),
};
