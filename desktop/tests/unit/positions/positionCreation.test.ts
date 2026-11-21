/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The creation wizard's main-process half: the directory analysis over real
 * temp trees (the four project shapes the user's machines carry), and the
 * safe write — a position is added, never overwritten, and only in a shape
 * the library scan reads back.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeProjectDirectory, createPositionIn, scanPositionLibrary } from '@process/services/team/positions';

const dirs: string[] = [];
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mu-position-creation-')));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fullProject = (root: string): void => {
  writeFileSync(
    join(root, 'AGENTS.md'),
    ['# freight-lab — 货代实验室', '', '## 红线', '- **禁止**未脱敏外发客户资料', ''].join('\n'),
    'utf8'
  );
  writeFileSync(
    join(root, 'HANDOFF.md'),
    [
      '# HANDOFF — freight-lab',
      '',
      '## 2026-11-20 · 报价表解析管线',
      '- 细节',
      '',
      '## 当前目标',
      '报价表自动解析与核价',
      '',
    ].join('\n'),
    'utf8'
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'freight-lab', dependencies: { fastify: '^5', vitest: '^3' } }),
    'utf8'
  );
};

describe('analyzeProjectDirectory', () => {
  it('reads a full project into a profile and a draft', async () => {
    const root = temp();
    fullProject(root);
    const { profile, draft } = await analyzeProjectDirectory(root);
    expect(profile.projectName).toBe('freight-lab');
    expect(profile.goal).toBe('报价表自动解析与核价');
    expect(profile.constraints).toEqual(['禁止未脱敏外发客户资料']);
    expect(profile.techStack).toEqual(['fastify', 'vitest']);
    expect(profile.empty).toBe(false);
    expect(draft.id).toBe('freight-lab');
    expect(draft.displayNameCandidates[0]).toBe('报价表自动解析与核价');
    expect(draft.body).toContain(`项目根：\`${root.replace(/\\/g, '/')}\``);
  });

  it('answers a bare package.json without a goal, and an empty directory as empty', async () => {
    const bare = temp();
    writeFileSync(join(bare, 'package.json'), JSON.stringify({ name: 'tiny-tool' }), 'utf8');
    const bareAnalysis = await analyzeProjectDirectory(bare);
    expect(bareAnalysis.profile.goal).toBe('');
    expect(bareAnalysis.profile.empty).toBe(false);
    expect(bareAnalysis.draft.id).toBe('tiny-tool');

    const empty = temp();
    const emptyAnalysis = await analyzeProjectDirectory(empty);
    expect(emptyAnalysis.profile.empty).toBe(true);
    expect(emptyAnalysis.draft.displayNameCandidates).toHaveLength(1); // the folder name alone
  });

  it('caps what it reads at the first screen of each file', async () => {
    const root = temp();
    const goalLine = '目标行'.repeat(200);
    writeFileSync(join(root, 'HANDOFF.md'), `# HANDOFF\n\n## 当前目标\n${goalLine}\n`, 'utf8');
    const { profile } = await analyzeProjectDirectory(root);
    // The cap keeps the read bounded; the parser saw only the first screen.
    expect(profile.goal.length).toBeLessThanOrEqual(1200);
  });
});

const creationParams = {
  id: 'freight-lab',
  displayName: '货代实验室',
  description: '货代实验室常设岗位——报价表自动解析；涉及 freight-lab 相关任务时交给它',
  body: `# 说明书\n\n- 项目根：\`E:/Projects/freight-lab\`\n- 负责报价表解析管线。`,
};

describe('createPositionIn (the safe write)', () => {
  const params = creationParams;

  it('adds a position the scan reads back, with the project root from the body line', async () => {
    const library = temp();
    const created = await createPositionIn({ libraryDir: library }, params);
    expect(created).toMatchObject({ name: 'freight-lab', displayName: '货代实验室' });
    expect(created.projectRoot).toBe('E:/Projects/freight-lab');
    expect(existsSync(join(library, 'freight-lab.md'))).toBe(true);
    const roster = await scanPositionLibrary(library);
    expect(roster.map((position) => position.name)).toEqual(['freight-lab']);
  });

  it('refuses an id that exists as a file, and one that exists as a position under another file name', async () => {
    const library = temp();
    await createPositionIn({ libraryDir: library }, params);
    await expect(createPositionIn({ libraryDir: library }, params)).rejects.toMatchObject({ code: 'invalid' });

    // The same id under another file name is still the same position key.
    writeFileSync(
      join(library, 'renamed.md'),
      '---\nname: freight-lab\ndisplay_name: 货代实验室\ndescription: 另一份\n---\n正文',
      'utf8'
    );
    await expect(createPositionIn({ libraryDir: library }, { ...params, id: 'freight-lab' })).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('refuses a non-slug id and a multi-line name, without writing anything', async () => {
    const library = temp();
    await expect(createPositionIn({ libraryDir: library }, { ...params, id: '货代' })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(createPositionIn({ libraryDir: library }, { ...params, displayName: '两\n行' })).rejects.toMatchObject(
      { code: 'invalid' }
    );
    expect(await scanPositionLibrary(library)).toEqual([]);
    expect(existsSync(join(library, '货代.md'))).toBe(false);
  });

  it('refuses a multi-line description instead of silently folding it', async () => {
    const library = temp();
    await expect(
      createPositionIn({ libraryDir: library }, { ...params, description: '第一行\n第二行' })
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(await scanPositionLibrary(library)).toEqual([]);
  });

  it('writes the optional anti_job taboos in a shape the scan parses back, and refuses a multi-line taboo', async () => {
    const library = temp();
    const created = await createPositionIn(
      { libraryDir: library },
      { ...params, antiJob: ['严禁未经用户确认对外发布任何内容', '严禁删改用户文件'] }
    );
    expect(created.antiJob).toEqual(['严禁未经用户确认对外发布任何内容', '严禁删改用户文件']);
    // The file carries the list form; the next scan reads the same taboos.
    const roster = await scanPositionLibrary(library);
    expect(roster[0]?.antiJob).toEqual(created.antiJob);

    await expect(
      createPositionIn({ libraryDir: library }, { ...params, id: 'tabooed', antiJob: ['两\n行'] })
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(existsSync(join(library, 'tabooed.md'))).toBe(false);
  });

  it('creates the library directory when the user has none yet', async () => {
    const library = join(temp(), 'agents');
    await createPositionIn({ libraryDir: library }, params);
    expect(existsSync(join(library, 'freight-lab.md'))).toBe(true);
  });
});

describe('createPositionIn cache honesty', () => {
  it('sees a just-created position on the next scan of the same directory', async () => {
    const library = temp();
    mkdirSync(library, { recursive: true });
    await scanPositionLibrary(library); // warm the cache
    await createPositionIn({ libraryDir: library }, creationParams);
    const roster = await scanPositionLibrary(library);
    expect(roster.some((position) => position.name === 'freight-lab')).toBe(true);
  });
});
