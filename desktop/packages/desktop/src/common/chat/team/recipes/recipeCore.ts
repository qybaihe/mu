/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Team recipes, pure: the three built-in lineups (one card each in the
 * new-group dialog's recipe mode), the custom-recipe documents under
 * `positions/_shared/recipes/` (the same line-based frontmatter style the
 * position library reads — a hand-edited file gets truncated fields, never a
 * parse crash), merging the two sources, mapping a recipe's roles onto the
 * user's roster (a role whose suggested id the library answers is ready to
 * seat; anything else is drafted as a new position), and reading an existing
 * group back as a recipe (the member manager's save button). No IO here —
 * the service owns the folder.
 */
import {
  parsePositionThinkingField,
  type PositionThinkingLevel,
} from '@/common/chat/team/thinkingLevel/thinkingLevelCore';

/** The marker a review role's model hint carries: the seat should run a different model than the producing seats. */
export const MODEL_HINT_DIFFER = '应异于产出岗';

/** One role of a recipe: what the slot does, and which position it wants. */
export type RecipeRole = {
  /**
   * The suggested existing position id. Empty (or missing from the roster)
   * means the recipe drafts a new position for the role before seating it.
   */
  positionId?: string;
  /** The Chinese role name: the slot's (and a drafted position's) face. */
  roleName: string;
  /** One line: what this role owes the pipeline. */
  duty: string;
  /** Taboos a drafted position for this role starts with (frontmatter `anti_job`). */
  antiJob?: readonly string[];
  /** The thinking level the slot (and a drafted position) starts on. */
  thinkingLevel?: PositionThinkingLevel;
  /**
   * Frontmatter `model`: an advisory hint for the seat's model pick — the
   * {@link MODEL_HINT_DIFFER} marker on review roles, or a concrete
   * `provider/model` id. Purely advisory: the group dialog shows it beside
   * the seat's model dropdown; nothing is applied without the person's pick.
   */
  modelHint?: string;
};

/** One recipe: a named, ordered lineup a group chat can be built from in one click. */
export type TeamRecipe = {
  /** Stable id: a slug for built-ins, the file stem for customs. */
  id: string;
  /** Where the card comes from: shipped, or saved under `_shared/recipes/`. */
  source: 'builtin' | 'custom';
  displayName: string;
  description: string;
  /** The pipeline in one sentence — the order roles hand work along. */
  pipeline: string;
  /** The ordered roles; the first seated position becomes the lead. */
  roles: readonly RecipeRole[];
};

/**
 * The built-in recipes. Why these three: they are the three shapes a small
 * mu crew actually takes — a gated publishing pipeline (produce, but never
 * publish unreviewed), a research relay over the ecosystem's generic
 * positions (planner/scout/worker/reviewer ship in most libraries, so the
 * card costs nothing), and a maker line where the one irreversible mistake
 * (deleting source material) is fenced off before it can happen.
 */
export const BUILTIN_RECIPES: readonly TeamRecipe[] = [
  {
    id: 'marketing-pipeline',
    source: 'builtin',
    displayName: '营销团队',
    description: '从目标到发布的完整营销流水线，发布权收口到审核官。',
    pipeline: '策略官定方向 → 文案官初稿 → 内容官成稿 → 投放官投放 → 审核官终审放行',
    roles: [
      {
        positionId: 'strategist',
        roleName: '策略官',
        duty: '拆解营销目标，定方向、受众与信息主线',
        thinkingLevel: 'high',
      },
      {
        positionId: 'copywriter',
        roleName: '文案官',
        duty: '按策略主线写营销文案初稿',
        antiJob: ['严禁未经用户确认对外发布任何内容（发帖/评论/点赞/关注）'],
        thinkingLevel: 'medium',
      },
      {
        positionId: 'content-editor',
        roleName: '内容官',
        duty: '把文案加工成各渠道成品素材',
        thinkingLevel: 'low',
      },
      {
        positionId: 'media-buyer',
        roleName: '投放官',
        duty: '按渠道规则排期投放并盯回收数据',
        antiJob: ['严禁未经用户确认对外发布任何内容（发帖/评论/点赞/关注）'],
        thinkingLevel: 'low',
      },
      {
        positionId: 'reviewer',
        roleName: '审核官',
        duty: '终审一切对外内容，把关事实与口径，唯一放行口',
        thinkingLevel: 'medium',
        modelHint: MODEL_HINT_DIFFER,
      },
    ],
  },
  {
    id: 'research-crew',
    source: 'builtin',
    displayName: '调研团队',
    description: '规划拆题、侦察搜集、执行汇总、评审核验，复用现成通用岗。',
    pipeline: '规划拆题 → 侦察搜集 → 执行汇总 → 评审核验',
    roles: [
      { positionId: 'planner', roleName: '规划', duty: '把调研问题拆成提纲与检索计划', thinkingLevel: 'high' },
      { positionId: 'scout', roleName: '侦察', duty: '按计划检索收集来源与素材', thinkingLevel: 'low' },
      { positionId: 'worker', roleName: '执行', duty: '汇总素材成调研产出', thinkingLevel: 'medium' },
      {
        positionId: 'reviewer',
        roleName: '评审',
        duty: '核对来源、数据与结论',
        antiJob: ['严禁编造来源、数据与结论；未核实的一律显式标注'],
        thinkingLevel: 'medium',
        modelHint: MODEL_HINT_DIFFER,
      },
    ],
  },
  {
    id: 'content-crew',
    source: 'builtin',
    displayName: '内容产出团队',
    description: '创意出 brief、制作出成品、审核验收；素材只增不删。',
    pipeline: '创意官出 brief → 制作官产出 → 审核官验收',
    roles: [
      { positionId: 'creative-lead', roleName: '创意官', duty: '定选题与创意 brief', thinkingLevel: 'high' },
      {
        positionId: 'producer',
        roleName: '制作官',
        duty: '按 brief 产出成品（图文/视频等）',
        antiJob: ['严禁删除或覆盖原始素材；产出只新增'],
        thinkingLevel: 'low',
      },
      {
        positionId: 'reviewer',
        roleName: '审核官',
        duty: '验收成品与 brief 的一致性',
        thinkingLevel: 'medium',
        modelHint: MODEL_HINT_DIFFER,
      },
    ],
  },
];

// --- the custom-recipe document (same style as the position library) ---

/** Frontmatter delimiters, as the position library reads them. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
/** A frontmatter line: `key: value`. */
const FRONTMATTER_LINE_RE = /^([A-Za-z_-]+):\s*(.*)$/;

/** How many roles one recipe may carry (a group caps at six seats; headroom for hand edits). */
const RECIPE_ROLE_CAP = 8;
/** How long one text field may run; longer is truncated, not rejected. */
const RECIPE_TEXT_CAP = 200;
/** How many taboos one role may carry. */
const RECIPE_ANTI_JOB_ITEM_CAP = 4;

const oneLineOf = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > RECIPE_TEXT_CAP ? `${flat.slice(0, RECIPE_TEXT_CAP - 1)}…` : flat;
};

const asTrimmed = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** One role line's `key: value` pairs: `- position: x | name: 規劃 | duty: …`. */
const ROLE_FIELD_RE = /^\s*([A-Za-z_-]+):\s*(.*)$/;

/**
 * The role lines under `roles:`: each `- ` item carries `position`/`name`/
 * `duty`/`anti_job`/`thinking`/`model` pairs separated by ` | `. `anti_job` items
 * split on `；`. A line without a `name` pair is skipped, not fatal — a
 * hand-edited half-line loses one role, not the recipe.
 */
function parseRoleLines(frontmatterLines: readonly string[]): RecipeRole[] {
  const roles: RecipeRole[] = [];
  let inList = false;
  for (const line of frontmatterLines) {
    if (!inList) {
      if (/^roles:\s*$/.test(line)) inList = true;
      continue;
    }
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (!item) break; // the list ended; anything after is another field's
    const fields = new Map<string, string>();
    for (const part of item[1].split('|')) {
      const match = ROLE_FIELD_RE.exec(part);
      if (match) {
        const key = match[1];
        const value = asTrimmed(match[2]);
        if (value && !fields.has(key)) fields.set(key, value);
      }
    }
    const roleName = fields.get('name');
    if (!roleName) continue;
    const positionId = asTrimmed(fields.get('position'));
    const antiJob = (fields.get('anti_job') ?? '')
      .split('；')
      .map((entry) => oneLineOf(entry))
      .filter((entry) => entry.length > 0)
      .slice(0, RECIPE_ANTI_JOB_ITEM_CAP);
    const thinkingLevel = parsePositionThinkingField(fields.get('thinking'));
    const modelHint = oneLineOf(fields.get('model') ?? '');
    roles.push({
      ...(positionId ? { positionId } : {}),
      roleName,
      duty: oneLineOf(fields.get('duty') ?? ''),
      ...(antiJob.length > 0 ? { antiJob } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(modelHint ? { modelHint } : {}),
    });
  }
  return roles.slice(0, RECIPE_ROLE_CAP);
}

/**
 * One custom-recipe file as a recipe, or undefined when the file is not one:
 * a recipe needs a name and at least one role that parses. The file stem is
 * the id; the doc's own `name`, when present, wins (a moved or renamed file
 * keeps its identity).
 */
export function parseRecipeDocument(fileName: string, content: string): TeamRecipe | undefined {
  if (fileName.toLowerCase() === 'readme.md') return undefined;
  const frontmatter = FRONTMATTER_RE.exec(content);
  if (!frontmatter) return undefined;
  const frontmatterLines = frontmatter[1].split(/\r?\n/);
  const fields = new Map<string, string>();
  for (const line of frontmatterLines) {
    const match = FRONTMATTER_LINE_RE.exec(line);
    if (match) fields.set(match[1], match[2]);
  }
  const name = asTrimmed(fields.get('name')) ?? fileName.replace(/\.md$/i, '');
  const roles = parseRoleLines(frontmatterLines);
  if (!name || roles.length === 0) return undefined;
  const pipeline = oneLineOf(fields.get('pipeline') ?? '');
  return {
    id: name,
    source: 'custom',
    displayName: asTrimmed(fields.get('display_name')) ?? name,
    description: oneLineOf(fields.get('description') ?? ''),
    ...(pipeline ? { pipeline } : { pipeline: roles.map((role) => role.roleName).join(' → ') }),
    roles,
  };
}

/** One text as an md-safe single line (frontmatter values never wrap). */
const mdLine = (text: string): string => text.replace(/\r?\n/g, ' ').trim();

/**
 * The recipe as a custom-recipe document: the inverse of
 * {@link parseRecipeDocument} — `roles:` list items with ` | `-separated
 * pairs, taboos joined with `；` — so a saved recipe survives a round trip.
 */
export function buildRecipeDocument(recipe: Omit<TeamRecipe, 'source'>): string {
  const roleLines = recipe.roles.map((role) => {
    const parts = [
      role.positionId ? `position: ${mdLine(role.positionId)}` : '',
      `name: ${mdLine(role.roleName)}`,
      role.duty ? `duty: ${mdLine(role.duty)}` : '',
      role.antiJob && role.antiJob.length > 0 ? `anti_job: ${mdLine(role.antiJob.join('；'))}` : '',
      role.thinkingLevel ? `thinking: ${role.thinkingLevel}` : '',
      role.modelHint ? `model: ${mdLine(role.modelHint)}` : '',
    ].filter((part) => part.length > 0);
    return `  - ${parts.join(' | ')}`;
  });
  return [
    '---',
    `name: ${mdLine(recipe.id)}`,
    `display_name: ${mdLine(recipe.displayName)}`,
    `description: ${mdLine(recipe.description)}`,
    `pipeline: ${mdLine(recipe.pipeline)}`,
    'roles:',
    ...roleLines,
    '---',
    '',
  ].join('\n');
}

/** The customs' card order: id ascending, deterministic across reads. */
const byRecipeId = (a: TeamRecipe, b: TeamRecipe): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The card list one source pair answers: the built-ins in their shipped
 * order, then the customs in id order. A custom that collides with a
 * built-in id is skipped — the built-in stays authoritative (the save path
 * suffixes collisions, so this only catches hand-edited files).
 */
export function mergeRecipes(builtins: readonly TeamRecipe[], customs: readonly TeamRecipe[]): TeamRecipe[] {
  const builtinIds = new Set(builtins.map((recipe) => recipe.id));
  const keptCustoms = customs.filter((recipe) => !builtinIds.has(recipe.id));
  return [...builtins, ...[...keptCustoms].toSorted(byRecipeId)];
}

// --- mapping a recipe onto the roster ---

/** The roster entry shape the mapping needs (PositionInfo satisfies it). */
type RosterPosition = { name: string; displayName: string; description: string };

/**
 * A recipe's roles against the roster, in pipeline order: a suggested id the
 * library answers seats that position; anything else (empty suggestion, or
 * an id no library carries) is a role to draft. The roster is the user's
 * live library — the same mapping runs again after drafts are created.
 * Generic over the roster's own entry type, so a PositionInfo roster answers
 * PositionInfo seats.
 */
export function resolveRecipeRoles<P extends RosterPosition>(
  recipe: TeamRecipe,
  roster: readonly P[]
): { role: RecipeRole; position: P | undefined }[] {
  const byId = new Map(roster.map((position) => [position.name, position]));
  return recipe.roles.map((role) => ({ role, position: role.positionId ? byId.get(role.positionId) : undefined }));
}

/** The draft a missing role becomes: what the review step edits and the create call sends. */
export type RecipePositionDraft = {
  id: string;
  displayName: string;
  description: string;
  antiJob: string[];
  thinkingLevel: PositionThinkingLevel | undefined;
  body: string;
};

/** A legal position id, as the wizard and the template drafts require. */
const POSITION_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The id a drafted position starts from: the role's own suggestion when it
 * is a legal, unused slug; otherwise a deterministic `${recipe.id}-rN` (CJK
 * role names cannot seed a slug, and the review step edits it anyway).
 */
export const draftIdForRole = (recipe: TeamRecipe, roleIndex: number, takenIds: ReadonlySet<string>): string => {
  const suggested = recipe.roles[roleIndex]?.positionId;
  if (suggested && POSITION_ID_RE.test(suggested) && !takenIds.has(suggested)) return suggested;
  const base = `${recipe.id}-r${roleIndex + 1}`.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return POSITION_ID_RE.test(base) ? base : `role-${roleIndex + 1}`;
};

/**
 * The position draft one missing role fills the review step with: identity
 * and taboos from the role, a body that says which recipe and pipeline slot
 * the position was born for — everything editable before the write.
 */
export function draftPositionFromRole(
  recipe: TeamRecipe,
  roleIndex: number,
  takenIds: ReadonlySet<string>
): RecipePositionDraft {
  const role = recipe.roles[roleIndex];
  const id = draftIdForRole(recipe, roleIndex, takenIds);
  const antiJob = [...(role.antiJob ?? [])];
  return {
    id,
    displayName: role.roleName,
    description: role.duty || `${recipe.displayName}配方·${role.roleName}`,
    antiJob,
    thinkingLevel: role.thinkingLevel,
    body: [
      `你是「${role.roleName}」岗位的常设负责 Bot（岗位即项目，跨任务常设，持续积累本岗记忆）。本岗位由团队配方「${recipe.displayName}」创建，请在首次任务中结合实际工作核实并补全职责。`,
      '',
      '## 岗位职责（来自配方，可改）',
      `- ${role.duty || '（配方未给出职责，请补充）'}`,
      '',
      '## 流水线位置',
      `- 配方流水线：${recipe.pipeline}`,
      `- 本岗是其中的「${role.roleName}」环节${roleIndex === 0 ? '（领队）' : ''}。`,
      '',
    ].join('\n'),
  };
}

// --- reading a group back as a recipe ---

/** The team shape the reader needs (TTeam satisfies it). */
type TeamLike = { name: string; assistants: { assistant_name: string; role: string }[] };

const asSlug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * An existing group as a recipe (the member manager's save button): one role
 * per seat, lead first, each carrying the seated position's id, duty,
 * taboos and declared thinking level — so re-running the recipe rebuilds
 * the same crew with the same fences. A seat no roster answers keeps its
 * name as a to-draft role.
 */
export function recipeFromTeam(
  team: TeamLike,
  roster: readonly {
    name: string;
    displayName: string;
    description: string;
    antiJob?: readonly string[];
    thinkingLevel?: PositionThinkingLevel;
  }[],
  now: Date = new Date()
): Omit<TeamRecipe, 'source'> {
  const byFace = new Map<string, (typeof roster)[number]>();
  for (const position of roster) {
    byFace.set(position.name, position);
    byFace.set(position.displayName, position);
  }
  const roles: RecipeRole[] = [];
  for (const agent of team.assistants.slice(0, RECIPE_ROLE_CAP)) {
    const position = byFace.get(agent.assistant_name);
    const role: RecipeRole = { roleName: agent.assistant_name, duty: position?.description ?? '' };
    if (position) role.positionId = position.name;
    if (position?.antiJob && position.antiJob.length > 0) role.antiJob = [...position.antiJob];
    if (position?.thinkingLevel) role.thinkingLevel = position.thinkingLevel;
    roles.push(role);
  }
  const ascii = asSlug(team.name);
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return {
    id: ascii ? `team-${ascii}` : `team-${stamp}`,
    displayName: team.name,
    description: `保存自群聊「${team.name}」（${now.toLocaleDateString('zh-CN')}）`,
    pipeline: team.assistants.map((agent) => agent.assistant_name).join(' → '),
    roles,
  };
}
