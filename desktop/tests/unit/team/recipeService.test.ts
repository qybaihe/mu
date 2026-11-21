/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The recipe service (process/services/team/recipes/recipeService.ts): the
 * custom folder under `_shared/recipes/`, the merged list (built-ins then
 * customs), and the save's slug, parse-back and collision-suffix semantics.
 * The folder is a temp dir; no test touches the real data dir.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listRecipesIn, recipesDirOf, saveRecipeIn } from '@process/services/team/recipes/recipeService';
import { BUILTIN_RECIPES } from '@/common/chat/team/recipes/recipeCore';

const dirs: string[] = [];
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mu-recipes-')));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const role = { positionId: 'scout', roleName: '侦察', duty: '搜集素材' };

describe('listRecipesIn', () => {
  it('answers the built-ins alone when the shared folder has no recipes dir yet', async () => {
    const dataDir = temp();
    const merged = await listRecipesIn(dataDir);
    expect(merged.map((recipe) => recipe.id)).toEqual(BUILTIN_RECIPES.map((recipe) => recipe.id));
    expect(merged.every((recipe) => recipe.source === 'builtin')).toBe(true);
  });

  it('appends customs in id order, skipping files that are not recipes', async () => {
    const dataDir = temp();
    await mkdir(recipesDirOf(dataDir), { recursive: true });
    await writeFile(join(recipesDirOf(dataDir), 'zeta.md'), '---\nname: zeta\nroles:\n  - name: Z\n---\n', 'utf8');
    await writeFile(join(recipesDirOf(dataDir), 'alpha.md'), '---\nname: alpha\nroles:\n  - name: A\n---\n', 'utf8');
    await writeFile(join(recipesDirOf(dataDir), 'note.md'), 'not a recipe', 'utf8');
    await writeFile(join(recipesDirOf(dataDir), 'readme.md'), '---\nname: readme\nroles:\n  - name: R\n---\n', 'utf8');
    const merged = await listRecipesIn(dataDir);
    expect(merged.map((recipe) => recipe.id)).toEqual([...BUILTIN_RECIPES.map((recipe) => recipe.id), 'alpha', 'zeta']);
  });
});

describe('saveRecipeIn', () => {
  it('writes one parseable document the next list answers', async () => {
    const dataDir = temp();
    const saved = await saveRecipeIn(dataDir, {
      id: 'my-crew',
      displayName: '我的队',
      description: '存的一手',
      pipeline: '侦察 → 评审',
      roles: [role, { roleName: '评审官', duty: '核验', antiJob: ['严禁编造'], thinkingLevel: 'medium' }],
    });
    expect(saved).toMatchObject({ id: 'my-crew', source: 'custom', displayName: '我的队' });
    const content = await readFile(join(recipesDirOf(dataDir), 'my-crew.md'), 'utf8');
    expect(content).toContain('position: scout');
    expect(content).toContain('anti_job: 严禁编造');
    const merged = await listRecipesIn(dataDir);
    expect(merged[merged.length - 1]?.id).toBe('my-crew');
    expect(merged[merged.length - 1]?.roles[1]?.antiJob).toEqual(['严禁编造']);
  });

  it('suffixes collisions: a taken file name, a custom id, and a built-in id', async () => {
    const dataDir = temp();
    await saveRecipeIn(dataDir, { id: 'crew', displayName: '一', description: '', pipeline: '', roles: [role] });
    const second = await saveRecipeIn(dataDir, {
      id: 'crew',
      displayName: '二',
      description: '',
      pipeline: '',
      roles: [role],
    });
    const builtinCollision = await saveRecipeIn(dataDir, {
      id: BUILTIN_RECIPES[0]!.id,
      displayName: '影子营销',
      description: '',
      pipeline: '',
      roles: [role],
    });
    expect(second.id).toBe('crew-2');
    expect(builtinCollision.id).toBe('marketing-pipeline-2');
    const files = (await readdir(recipesDirOf(dataDir))).toSorted();
    expect(files).toEqual(['crew-2.md', 'crew.md', 'marketing-pipeline-2.md']);
  });

  it('refuses an invalid slug, a multi-line name, and an empty roster', async () => {
    const dataDir = temp();
    await expect(
      saveRecipeIn(dataDir, { id: 'Not A Slug', displayName: 'x', description: '', pipeline: '', roles: [role] })
    ).rejects.toThrow(/slug/i);
    await expect(
      saveRecipeIn(dataDir, { id: 'ok', displayName: '两\n行', description: '', pipeline: '', roles: [role] })
    ).rejects.toThrow(/one non-empty line/i);
    await expect(
      saveRecipeIn(dataDir, { id: 'ok', displayName: 'x', description: '', pipeline: '', roles: [] })
    ).rejects.toThrow(/at least one role/i);
  });
});
