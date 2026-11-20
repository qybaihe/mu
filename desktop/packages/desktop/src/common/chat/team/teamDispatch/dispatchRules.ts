/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The team dispatch rules seeded into a team workspace's AGENTS.md, so a team
 * lead answers a goal ("查 X 客户，整理成表") with automatic dispatch — tasks
 * with owners — instead of a list of questions, and every member (the lead
 * included) wraps up by appending this task's record to the right HANDOFF.md —
 * the position's project root when the slot's position has one, the team
 * workspace otherwise — plus the new-project/new-position dedup gate. The v1
 * wording is the text validated live (2026-11-20 against a Claude Code lead
 * in CLAUDE.md, and 2026-11-21 against an all-mu team in AGENTS.md; see
 * tmp/dsbot-port/auto-dispatch/FINDINGS.md): rewording changes lead behaviour,
 * so the rules ship as a versioned block that is replaced whole, in place,
 * when the version rises. Everything outside the block is the user's and is
 * never touched.
 *
 * The file is AGENTS.md because a mu lead (pi's harness) reads exactly one
 * context file per directory, AGENTS.md first and CLAUDE.md only in its
 * absence (resource-loader.ts's candidates), so AGENTS.md is the name every
 * lead runtime still reads. The canonical tool names in the text work in both
 * transports: a Claude Code lead has them as MCP tools, a mu lead's prompt
 * maps them to the team CLI (`team members`, `team task create`, …).
 */

/** The seeded block's version. Raise it to replace older blocks on open. */
export const TEAM_DISPATCH_RULES_VERSION = 2;

/** Closes the app-managed block. */
export const TEAM_DISPATCH_RULES_END_MARKER = '<!-- /mu-team-dispatch -->';

/** The rules text, exactly as validated. Do not reword the v1 wording: see the module comment. */
export const TEAM_DISPATCH_RULES_BODY = `# 团队 Lead 自动分派守则（Team Lead Dispatch Rules）

第 1-3 节只约束团队的 Team Leader（lead）；「收尾落账」与「新项目/新岗位去重」两节约束全体成员（含 lead 自己执行的任务）。

## 目标型消息 → 立即自动分派（默认路径）

当用户消息给出的是一个目标或需求（例：「查 X 客户，整理成表」「调研 Y 并写摘要」），且没有点名任何成员时，这是你的默认执行路径，不许只回问题清单：

1. 先 \`team_members\` 拿最新 roster。
2. 把目标拆成至少 2 个可执行任务（天然单一的目标也拆成「执行」+「整合成表/复核」两步）。
3. 逐个 \`team_task_create\`，每个任务必须带 \`owner\`= 最合适成员的 slot_id（按成员名字与 assistant 能力匹配；成员间难分时按任务量均衡分配）。\`owner\` 不许留空，也不许设为你自己。
4. 回复用户一句话分派说明（列出 任务×负责人），格式：「已分派：任务A→成员X，任务B→成员Y。结果回来后我汇总。」不要问「要不要开始」。
5. 依赖链遵守系统提示词的顺序分派规则（先派 A，等 A 的 idle_notification 再派 B）。

澄清只允许一种情况：目标存在会导致**完全相反工作方向**的重大歧义。此时也必须给出你的默认理解与默认分派方案，并说明「如无异议我按此执行/确认后立即分派」，不许裸问问题。

## 点名消息 → 尊重点名

用户点名成员时（「让 X 做 Y」「X 去查 Z」）：任务 owner 必须是被点名的成员，不重新分配；点名你本人（lead）时你自己做。点名消息只需 1 个任务也要建任务卡（owner=被点名者），保证对话流可见。

## 团队扩编（team_spawn_agent）不是分派的替代品

现有成员能力可覆盖的目标，绝不走 staffing 提案回应；只有当任务需要现有成员都不具备的技能时才提案扩编，且仍要先完成当前可分派任务的分派。

## 收尾落账（全体成员，硬规则）

Teammate 完成各自任务、回报 lead 之前，必须把本任务产生的经验/教训/可复用资产落账，不许只留在对话里：

1. 槽位名对应岗位库岗位、且该岗位 md 写有「项目根」→ 把一条记录**追加**写入该项目根的 \`HANDOFF.md\`（不存在则创建；岗位库路径 \`~/.mu/agent/agents/<槽位名>.md\`）。格式：一行标题 \`## <YYYY-MM-DD> · <任务一句话>\`，随后 2-5 行要点，末行 \`LESSON: <一句可复用教训或坑>\`（确实无可提炼时写 \`LESSON: 无\`）。**只追加，禁止删改该文件既有内容**。
2. 槽位岗位无项目根 → 落账到团队工作区（当前目录）的 \`HANDOFF.md\`（同格式，只追加）。
3. 本次任务创建了新项目目录 → 完成时在新项目内写 \`AGENTS.md\`（项目说明+本次任务记忆+经验教训三节）与 \`HANDOFF.md\`（首条记录，同格式）。
4. 可复用技术资产（脚本/报告/样张）放项目约定目录（\`tmp/\` 或 \`docs/\`，随项目已有结构），不散落。
5. 回报 lead 时写明自己的落账文件完整路径。

Lead 终局汇总（任务全部完成、回报用户时）：结果之外，必须附「本次各岗落账位置」清单，每行：成员/岗位 → HANDOFF.md 完整路径。

## 新项目/新岗位去重（全体成员，硬规则，宁少勿滥）

任务要求「新建一个 XX 项目」「注册一个新岗位」时，先对照岗位库名册（\`ls ~/.mu/agent/agents/\` 后按各岗 description 比对任务域）判断重合，再行动：

- 与既有岗职责重合 → **不新建**：任务归入该岗既有项目承接，并在回报中说明归并理由（点名重合的岗位与重合点）。
- 确属名册覆盖不了的新领域 → 才可新建项目目录，并按上节在新项目内写 \`AGENTS.md\`+\`HANDOFF.md\` 留档。
- 任何成员都不得创建或改写岗位库文件；「项目即岗位」的注册只做判定与建议，建不建由用户决定。`;

/** The whole app-managed block as it appears in AGENTS.md. */
export const TEAM_DISPATCH_RULES_BLOCK = `<!-- mu-team-dispatch v${TEAM_DISPATCH_RULES_VERSION} -->\n${TEAM_DISPATCH_RULES_BODY}\n${TEAM_DISPATCH_RULES_END_MARKER}`;

/**
 * A sentence of the body no other text plausibly carries. The live validation
 * seeded a marker-less copy of these rules; a workspace that already holds it
 * must not get the block appended on top (no duplication, no rewrite).
 */
const RULES_FINGERPRINT = '`owner` 不许留空，也不许设为你自己';

/** A start marker of any version, through its end marker (or to end of file when the block was left unclosed). */
const MANAGED_BLOCK = /<!-- mu-team-dispatch v(\d+) -->[\s\S]*?(?:<!-- \/mu-team-dispatch -->|$)/;

/** What seeding would leave in the file, and whether that differs from what is there. */
export type DispatchSeedPlan = {
  next: string;
  changed: boolean;
};

/**
 * Merges the rules block into existing AGENTS.md content:
 *
 * - no file yet → the block alone;
 * - a marked block of an older version → that block replaced in place, the
 *   rest untouched (same or newer version stays: the block's wording did not
 *   change, and a same-version edit is the user tuning our block);
 * - the unmarked rules already present (the validated copy) → left as is;
 * - anything else (the user's own file) → the block appended after it.
 */
export function planDispatchSeed(existing: string | undefined): DispatchSeedPlan {
  if (existing === undefined || existing.length === 0) return { next: TEAM_DISPATCH_RULES_BLOCK, changed: true };
  const marked = MANAGED_BLOCK.exec(existing);
  if (marked) {
    if (Number(marked[1]) >= TEAM_DISPATCH_RULES_VERSION) return { next: existing, changed: false };
    return {
      next:
        existing.slice(0, marked.index) + TEAM_DISPATCH_RULES_BLOCK + existing.slice(marked.index + marked[0].length),
      changed: true,
    };
  }
  if (existing.includes(RULES_FINGERPRINT)) return { next: existing, changed: false };
  return { next: `${existing.replace(/\s+$/, '')}\n\n${TEAM_DISPATCH_RULES_BLOCK}`, changed: true };
}
