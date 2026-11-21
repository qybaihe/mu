/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The recipe service: the custom-recipe folder under the shared area
 * (`<dataDir>/positions/_shared/recipes/` — the same shared folder TEAMS.md
 * lives in), the merged card list the new-group dialog asks for, and the
 * one write path (saving a group as a recipe, which only ever adds files,
 * like the position wizard's write). Pure decisions live in recipeCore.
 */
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SHARED_TEAMS_FOLDER } from '@/common/chat/team/supervisor/supervisorCore';
import {
  BUILTIN_RECIPES,
  buildRecipeDocument,
  mergeRecipes,
  parseRecipeDocument,
  type TeamRecipe,
} from '@/common/chat/team/recipes/recipeCore';
import type { SaveRecipeParams } from '@/common/chat/team/recipes/recipeBridge';
import { KyrnError } from '@/common/kyrn/errors';

/** A recipe id is a lowercase slug, like a position id. */
const RECIPE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** The custom-recipe folder of one data dir. */
export const recipesDirOf = (dataDir: string): string => join(dataDir, 'positions', SHARED_TEAMS_FOLDER, 'recipes');

/** True when the file exists; anything but a clean miss rethrows. */
async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}

/**
 * The custom recipes on disk, id order: every `*.md` that parses as one. A
 * missing folder answers empty — no library has saved a recipe yet. One
 * unreadable or malformed file is skipped, never fatal to the list.
 */
export async function listCustomRecipesIn(dataDir: string): Promise<TeamRecipe[]> {
  let files: string[];
  try {
    files = await readdir(recipesDirOf(dataDir));
  } catch {
    return []; // no folder yet: nothing custom
  }
  const parsed: TeamRecipe[] = [];
  for (const file of files.toSorted()) {
    if (!file.toLowerCase().endsWith('.md')) continue;
    try {
      const recipe = parseRecipeDocument(file, await readFile(join(recipesDirOf(dataDir), file), 'utf8'));
      if (recipe) parsed.push(recipe);
    } catch {
      // unreadable: not a card, not a failure of the list
    }
  }
  return parsed;
}

/** The merged card list: built-ins in shipped order, then customs in id order. */
export async function listRecipesIn(dataDir: string): Promise<TeamRecipe[]> {
  return mergeRecipes(BUILTIN_RECIPES, await listCustomRecipesIn(dataDir));
}

/**
 * The one write: a new custom-recipe document, added and nothing else. A
 * colliding id (a file, or a built-in card) gets a `-2`/`-3`… suffix — the
 * save stays one click, never a dialog about names. The document parses
 * back before the write, so the folder only ever gains files it can read
 * again (the same invariant the position wizard's write keeps).
 */
export async function saveRecipeIn(dataDir: string, params: SaveRecipeParams): Promise<TeamRecipe> {
  const base = params.id.trim();
  if (!RECIPE_ID_RE.test(base)) throw new KyrnError('invalid', 'A recipe id is a lowercase slug', { id: params.id });
  const displayName = params.displayName.trim();
  if (!displayName || /[\r\n]/.test(displayName))
    throw new KyrnError('invalid', 'A recipe name is one non-empty line', { displayName });
  if (params.roles.length === 0) throw new KyrnError('invalid', 'A recipe needs at least one role', {});
  const taken = new Set(BUILTIN_RECIPES.map((recipe) => recipe.id));
  for (const existing of await listCustomRecipesIn(dataDir)) taken.add(existing.id);

  const dir = recipesDirOf(dataDir);
  await mkdir(dir, { recursive: true });
  let id = base;
  for (let n = 2; ; n += 1) {
    if (!taken.has(id) && !(await fileExists(join(dir, `${id}.md`)))) break;
    id = `${base}-${n}`;
  }
  const recipe: TeamRecipe = {
    id,
    source: 'custom',
    displayName,
    description: params.description.replace(/[\r\n]+/g, ' ').trim(),
    pipeline: params.pipeline.replace(/[\r\n]+/g, ' ').trim(),
    roles: params.roles,
  };
  const content = buildRecipeDocument(recipe);
  const parsed = parseRecipeDocument(`${id}.md`, content);
  if (!parsed) throw new KyrnError('invalid', 'The generated recipe document does not parse', { id });
  await writeFile(join(dir, `${id}.md`), content, 'utf8');
  return parsed;
}
