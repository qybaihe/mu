/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The recipe core (common/chat/team/recipes/recipeCore.ts): the three
 * built-ins' contracts, the custom-document round trip (parse and build are
 * inverses; a hand-edited file gets truncated fields, never a crash),
 * merging built-ins with customs, mapping roles onto a roster, the drafts
 * missing roles fill, and reading a group back as a recipe.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_RECIPES,
  MODEL_HINT_DIFFER,
  buildRecipeDocument,
  draftPositionFromRole,
  mergeRecipes,
  parseRecipeDocument,
  recipeFromTeam,
  resolveRecipeRoles,
  type TeamRecipe,
} from '@/common/chat/team/recipes/recipeCore';

const roster = [
  { name: 'planner', displayName: '规划', description: '拆题定计划' },
  { name: 'scout', displayName: '侦察', description: '搜集素材' },
  { name: 'worker', displayName: '执行', description: '汇总产出' },
  { name: 'reviewer', displayName: '评审', description: '核验结论' },
];

describe('BUILTIN_RECIPES', () => {
  it('ships the three starter lineups with unique slug ids', () => {
    expect(BUILTIN_RECIPES.map((recipe) => recipe.id)).toEqual(['marketing-pipeline', 'research-crew', 'content-crew']);
    for (const recipe of BUILTIN_RECIPES) {
      expect(recipe.source).toBe('builtin');
      expect(recipe.roles.length).toBeGreaterThanOrEqual(3);
      expect(recipe.roles[0]?.roleName).toBeTruthy();
      expect(recipe.pipeline).toContain('→');
    }
  });

  it('gates the marketing pipeline: copy and media never publish, the reviewer is the only gate', () => {
    const marketing = BUILTIN_RECIPES[0]!;
    const copywriter = marketing.roles[1]!;
    const mediaBuyer = marketing.roles[3]!;
    expect(copywriter.antiJob?.[0]).toContain('严禁未经用户确认对外发布');
    expect(mediaBuyer.antiJob?.[0]).toContain('严禁未经用户确认对外发布');
    expect(marketing.roles[4]?.positionId).toBe('reviewer'); // the only seat a library usually answers
    expect(marketing.roles[0]?.thinkingLevel).toBe('high');
  });

  it('marks every built-in review seat with the cross-model hint, and no producing seat', () => {
    for (const recipe of BUILTIN_RECIPES) {
      for (const role of recipe.roles) {
        const isReview = /审核|评审/.test(role.roleName);
        expect(role.modelHint === MODEL_HINT_DIFFER).toBe(isReview);
      }
    }
  });

  it('reuses the ecosystem generic positions for research', () => {
    const research = BUILTIN_RECIPES[1]!;
    expect(research.roles.map((role) => role.positionId)).toEqual(['planner', 'scout', 'worker', 'reviewer']);
  });

  it('fences the producer against deleting source material', () => {
    const producer = BUILTIN_RECIPES[2]!.roles[1]!;
    expect(producer.antiJob?.[0]).toContain('严禁删除或覆盖原始素材');
  });
});

describe('parseRecipeDocument', () => {
  it('parses a hand-written document: fields, role pairs, taboos split on ；, thinking tiers', () => {
    const doc = [
      '---',
      'name: my-crew',
      'display_name: 我的调研队',
      'description: 三岗现成一岗新建',
      'pipeline: 规划 → 评审',
      'roles:',
      '  - position: planner | name: 规划 | duty: 拆题 | thinking: high',
      '  - name: 评审官 | duty: 核验 | anti_job: 严禁编造来源；未经确认不外发 | thinking: medium',
      '---',
      '正文随便写。',
    ].join('\n');
    const recipe = parseRecipeDocument('my-crew.md', doc);
    expect(recipe).toBeDefined();
    expect(recipe?.id).toBe('my-crew');
    expect(recipe?.source).toBe('custom');
    expect(recipe?.displayName).toBe('我的调研队');
    expect(recipe?.roles).toHaveLength(2);
    expect(recipe?.roles[0]).toMatchObject({
      positionId: 'planner',
      roleName: '规划',
      duty: '拆题',
      thinkingLevel: 'high',
    });
    expect(recipe?.roles[1]).toMatchObject({
      roleName: '评审官',
      duty: '核验',
      antiJob: ['严禁编造来源', '未经确认不外发'],
      thinkingLevel: 'medium',
    });
    expect(recipe?.roles[1]?.positionId).toBeUndefined();
  });

  it('parses a role model hint — the differ marker and a concrete provider/model id alike', () => {
    const doc = [
      '---',
      'name: model-crew',
      'roles:',
      '  - position: worker | name: 执行 | duty: 干活',
      `  - position: reviewer | name: 评审 | duty: 核验 | model: ${MODEL_HINT_DIFFER}`,
      '  - name: 备用 | duty: 待命 | model: openai/gpt-5',
      '---',
    ].join('\n');
    const recipe = parseRecipeDocument('model-crew.md', doc);
    expect(recipe?.roles[0]?.modelHint).toBeUndefined();
    expect(recipe?.roles[1]?.modelHint).toBe(MODEL_HINT_DIFFER);
    expect(recipe?.roles[2]?.modelHint).toBe('openai/gpt-5');
  });

  it('refuses files that are not recipes: no frontmatter, no roles, or README', () => {
    expect(parseRecipeDocument('readme.md', '---\nname: x\nroles:\n---\n')).toBeUndefined();
    expect(parseRecipeDocument('note.md', 'just a note')).toBeUndefined();
    expect(parseRecipeDocument('empty.md', '---\nname: x\ndescription: y\n---\n')).toBeUndefined();
    expect(parseRecipeDocument('half.md', '---\nroles:\n  - duty: 没有名字\n---\n')).toBeUndefined();
  });

  it('falls back to the file stem for id and joins role names into a pipeline when fields are absent', () => {
    const recipe = parseRecipeDocument(
      'saved-team.md',
      '---\ndisplay_name: 存的队\nroles:\n  - position: scout | name: 侦察\n  - name: 执行\n---\n'
    );
    expect(recipe?.id).toBe('saved-team');
    expect(recipe?.description).toBe('');
    expect(recipe?.pipeline).toBe('侦察 → 执行');
  });

  it('caps roles and drops unknown thinking tiers', () => {
    const roles = Array.from({ length: 12 }, (_, index) => `  - name: 角色${index}`).join('\n');
    const recipe = parseRecipeDocument('big.md', `---\nname: big\nroles:\n${roles}\n---\n`);
    expect(recipe?.roles).toHaveLength(8);
    const odd = parseRecipeDocument('odd.md', '---\nname: odd\nroles:\n  - name: X | thinking: turbo\n---\n');
    expect(odd?.roles[0]?.thinkingLevel).toBeUndefined();
  });

  it('reads CRLF documents like LF ones', () => {
    const doc = '---\r\nname: crlf\r\nroles:\r\n  - position: scout | name: 侦察\r\n---\r\n';
    expect(parseRecipeDocument('crlf.md', doc)?.roles[0]?.positionId).toBe('scout');
  });
});

describe('buildRecipeDocument / round trip', () => {
  it('is the inverse of parse: a built document parses back to the same recipe', () => {
    const recipe: Omit<TeamRecipe, 'source'> = {
      id: 'round-trip',
      displayName: '回环队',
      description: '序列化再解析',
      pipeline: 'A → B',
      roles: [
        { positionId: 'scout', roleName: '侦察', duty: '搜', thinkingLevel: 'low' },
        { roleName: '评审官', duty: '核', antiJob: ['严禁编造', '严禁外发'], thinkingLevel: 'high' },
      ],
    };
    const parsed = parseRecipeDocument('round-trip.md', buildRecipeDocument(recipe));
    expect(parsed).toMatchObject({ ...recipe, source: 'custom' });
  });

  it('keeps every field on one line, so frontmatter never wraps', () => {
    const doc = buildRecipeDocument({
      id: 'multiline',
      displayName: '多行\n名字',
      description: '两行\n描述',
      pipeline: 'A\n→ B',
      roles: [{ roleName: '角\n色', duty: '职\n责' }],
    });
    for (const line of doc.split('\n')) expect(line).not.toMatch(/\n/);
  });
});

const customRecipe = (id: string): TeamRecipe => ({
  id,
  source: 'custom',
  displayName: id,
  description: '',
  pipeline: '',
  roles: [{ roleName: '角色' }],
});

describe('mergeRecipes', () => {
  const builtin = BUILTIN_RECIPES;
  it('keeps built-ins in shipped order, then customs in id order', () => {
    const merged = mergeRecipes(builtin, [customRecipe('zeta'), customRecipe('alpha')]);
    expect(merged.slice(0, 3).map((recipe) => recipe.id)).toEqual(builtin.map((recipe) => recipe.id));
    expect(merged.slice(3).map((recipe) => recipe.id)).toEqual(['alpha', 'zeta']);
  });

  it('drops a custom that collides with a built-in id (the built-in stays authoritative)', () => {
    const shadow = { ...builtin[0]!, source: 'custom' as const, displayName: '影子' };
    const merged = mergeRecipes(builtin, [shadow]);
    expect(merged).toHaveLength(builtin.length);
    expect(merged[0]?.displayName).toBe(builtin[0]!.displayName);
  });
});

describe('resolveRecipeRoles', () => {
  it('seats suggested ids the roster answers, drafts everything else', () => {
    const research = BUILTIN_RECIPES[1]!;
    const resolved = resolveRecipeRoles(research, roster);
    expect(resolved.map((entry) => entry.position?.name)).toEqual(['planner', 'scout', 'worker', 'reviewer']);
  });

  it('marks unknown suggestions and empty suggestions as drafts', () => {
    const marketing = BUILTIN_RECIPES[0]!;
    const resolved = resolveRecipeRoles(marketing, roster);
    expect(resolved[0]?.position).toBeUndefined(); // strategist not in roster
    expect(resolved[4]?.position?.name).toBe('reviewer');
    const noSuggestion = parseRecipeDocument('x.md', '---\nname: x\nroles:\n  - name: 自由角色\n---\n')!;
    expect(resolveRecipeRoles(noSuggestion, roster)[0]?.position).toBeUndefined();
  });
});

describe('draftPositionFromRole', () => {
  it("takes the suggested slug when it is legal and unused, with the role's taboos and tier", () => {
    const marketing = BUILTIN_RECIPES[0]!;
    const draft = draftPositionFromRole(marketing, 1, new Set(['strategist']));
    expect(draft.id).toBe('copywriter');
    expect(draft.displayName).toBe('文案官');
    expect(draft.description).toBe(marketing.roles[1]!.duty);
    expect(draft.antiJob).toEqual(marketing.roles[1]!.antiJob);
    expect(draft.thinkingLevel).toBe('medium');
    expect(draft.body).toContain('营销团队');
    expect(draft.body).toContain('文案官');
  });

  it('falls back to a deterministic recipe-scoped id when the suggestion is taken or absent', () => {
    const research = BUILTIN_RECIPES[1]!;
    const taken = draftPositionFromRole(research, 0, new Set(['planner']));
    expect(taken.id).toBe('research-crew-r1');
    const custom = parseRecipeDocument('custom.md', '---\nname: custom\nroles:\n  - name: 中文角色\n---\n')!;
    expect(draftPositionFromRole(custom, 0, new Set()).id).toBe('custom-r1');
  });
});

describe('recipeFromTeam', () => {
  const richRoster = [
    ...roster,
    {
      name: 'copywriter',
      displayName: '文案官',
      description: '写文案',
      antiJob: ['严禁私自发布'],
      thinkingLevel: 'medium' as const,
    },
  ];

  it('reads a group back as a recipe: one role per seat, lead first, taboos and tiers carried', () => {
    const recipe = recipeFromTeam(
      {
        name: '营销一组',
        assistants: [
          { assistant_name: '文案官', role: 'leader' },
          { assistant_name: '评审', role: 'teammate' },
          { assistant_name: '神秘客座', role: 'teammate' },
        ],
      },
      richRoster,
      new Date('2026-11-23T08:00:00Z')
    );
    expect(recipe.id).toBe('team-20261123'); // a CJK-only name has no ascii slug; the date stamp is the base
    expect(recipe.displayName).toBe('营销一组');
    expect(recipe.roles).toHaveLength(3);
    expect(recipe.roles[0]).toMatchObject({
      positionId: 'copywriter',
      roleName: '文案官',
      duty: '写文案',
      antiJob: ['严禁私自发布'],
      thinkingLevel: 'medium',
    });
    expect(recipe.roles[1]).toMatchObject({ positionId: 'reviewer', roleName: '评审' });
    expect(recipe.roles[2]).toMatchObject({ roleName: '神秘客座', duty: '' });
    expect(recipe.roles[2]?.positionId).toBeUndefined();
    expect(recipe.pipeline).toBe('文案官 → 评审 → 神秘客座');
    expect(recipe.description).toContain('营销一组');
  });

  it('round-trips through the document: what the save writes, the list parses back', () => {
    const recipe = recipeFromTeam(
      {
        name: 'research-2',
        assistants: [
          { assistant_name: 'scout', role: 'leader' },
          { assistant_name: 'worker', role: 'teammate' },
        ],
      },
      roster,
      new Date('2026-11-23T08:00:00Z')
    );
    const parsed = parseRecipeDocument(`${recipe.id}.md`, buildRecipeDocument(recipe));
    expect(parsed).toMatchObject({ ...recipe, source: 'custom' });
  });

  it('round-trips a model hint: the built document carries the model pair, the parse reads it back', () => {
    const recipe: Omit<TeamRecipe, 'source'> = {
      id: 'hint-crew',
      displayName: '提示队',
      description: '模型提示往返',
      pipeline: '执行 → 评审',
      roles: [
        { positionId: 'worker', roleName: '执行', duty: '干活' },
        { positionId: 'reviewer', roleName: '评审', duty: '核验', modelHint: MODEL_HINT_DIFFER },
      ],
    };
    const doc = buildRecipeDocument(recipe);
    expect(doc).toContain('model: 应异于产出岗');
    const parsed = parseRecipeDocument('hint-crew.md', doc);
    expect(parsed?.roles[1]?.modelHint).toBe(MODEL_HINT_DIFFER);
    expect(parsed?.roles[0]?.modelHint).toBeUndefined();
  });
});
