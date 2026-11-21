/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Answers `recipes.list` and `recipes.save` (common/chat/team/recipes/
 * recipeBridge.ts): the merged card list, and the member manager's save of
 * an existing group as a custom recipe.
 */
import { getPlatformServices } from '@/common/platform';
import { recipeBridge } from '@/common/chat/team/recipes/recipeBridge';
import type { SaveRecipeParams } from '@/common/chat/team/recipes/recipeBridge';
import { kyrnFailure, type KyrnResult } from '@/common/kyrn/errors';
import { listRecipesIn, saveRecipeIn } from './recipeService';

// Always answer IPC, including failure: the generic bridge otherwise only logs exceptions.
async function result<T>(work: () => T | Promise<T>): Promise<KyrnResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    return kyrnFailure(error);
  }
}

export function initRecipesBridge(): void {
  recipeBridge.list.provider(() => result(() => listRecipesIn(getPlatformServices().paths.getDataDir())));
  recipeBridge.save.provider((params: SaveRecipeParams) =>
    result(() => saveRecipeIn(getPlatformServices().paths.getDataDir(), params))
  );
}
