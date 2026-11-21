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
export const TEAM_DISPATCH_RULES_VERSION = 3;

/** Closes the app-managed block. */
export const TEAM_DISPATCH_RULES_END_MARKER = '<!-- /mu-team-dispatch -->';

/** The rules text, exactly as validated. Do not reword the v1 wording: see the module comment. */
export const TEAM_DISPATCH_RULES_BODY = `# 团队 Lead 自动分派守则（Team Lead Dispatch Rules）

第 1-3 节只约束团队的 Team Leader（lead）；「依赖门控与受阻任务」「待领任务与空闲主动认领」「完成自回查与收尾落账」「新项目/新岗位去重」各节约束全体成员（含 lead 自己执行的任务）。

## 目标型消息 → 立即自动分派（默认路径）

当用户消息给出的是一个目标或需求（例：「查 X 客户，整理成表」「调研 Y 并写摘要」），且没有点名任何成员时，这是你的默认执行路径，不许只回问题清单：

1. 先 \`team_members\` 拿最新 roster。
2. 把目标拆成至少 2 个可执行任务（天然单一的目标也拆成「执行」+「整合成表/复核」两步）。
3. 逐个 \`team_task_create\`，每个任务必须带 \`owner\`= 最合适成员的 slot_id（按成员名字与 assistant 能力匹配；成员间难分时按任务量均衡分配）。\`owner\` 不许留空，也不许设为你自己。唯一例外见「待领任务」节：职责边界现有成员都覆盖不了时，可不带 owner 建为待领任务，但必须在回复中说明「已挂待领」。
4. 回复用户一句话分派说明（列出 任务×负责人，待领任务标「待领」），格式：「已分派：任务A→成员X，任务B→成员Y。结果回来后我汇总。」不要问「要不要开始」。
5. 依赖链用 \`blocked_by\` 声明（create 时直接带数组，或 update 补）；先派阻塞源，阻塞源未完成前不把受阻任务派给成员（见「依赖门控」节），等阻塞源 completed（依赖自动解除）后再派下游。

澄清只允许一种情况：目标存在会导致**完全相反工作方向**的重大歧义。此时也必须给出你的默认理解与默认分派方案，并说明「如无异议我按此执行/确认后立即分派」，不许裸问问题。

## 依赖门控与受阻任务（全体成员，硬规则）

后端不拦依赖：blocked_by 未清的任务照样能被改状态改 owner——门控全靠本节，人人自守：

- **lead 不派受阻任务**：\`blocked_by\` 未全清（阻塞源未 completed）的任务，绝不建带 owner 的分派、绝不催办、绝不让成员开工；先派阻塞源，等它 completed 再派下游。
- **成员不碰受阻任务**：认领或开工任何任务前，先 \`team_task_list\` 回读确认 \`blocked_by\` 为空；受阻任务绝不认领、绝不 \`team_task_update\` 它的 owner/status。收到受阻任务的指派不执行，回复 lead 一句「任务 X 的阻塞源 Y 未完成，先派 Y」。
- **阻塞源完成 = 自动解除**：阻塞源 completed 后，下游任务的 blocked_by 会被清空，此时才可正常分派/认领/开工。

## 待领任务与空闲主动认领（全体成员，硬规则）

- lead 可建「待领」任务：不带 owner，且 \`blocked_by\` 必须为空（受阻任务挂待领没有意义，没人能领）。
- 成员每次被唤醒（收到消息、开始执行）时，若自己名下**没有 in_progress 任务**，先 \`team_task_list\` 扫一遍待领任务（owner 为空 && status 是 pending/todo && blocked_by 为空）：
  - 对照本岗职责（自己的岗位名与职责描述）：职责匹配 → 一次 \`team_task_update\`（owner=自己 + status=in_progress）认领，并立即 \`team_send_message\` 向 lead 播报一句「我领了 <任务名>」，然后开工。
  - 职责不匹配 → 不碰不抢（宁可不领，绝不越职责揽活）；受阻任务（blocked_by 非空）绝不认领。
  - 自己手上已有 in_progress 任务时不扫不领，先干完手上的。

## 点名消息 → 尊重点名

用户点名成员时（「让 X 做 Y」「X 去查 Z」）：任务 owner 必须是被点名的成员，不重新分配；点名你本人（lead）时你自己做。点名消息只需 1 个任务也要建任务卡（owner=被点名者），保证对话流可见。

## 团队扩编（team_spawn_agent）不是分派的替代品

现有成员能力可覆盖的目标，绝不走 staffing 提案回应；只有当任务需要现有成员都不具备的技能时才提案扩编，且仍要先完成当前可分派任务的分派。

## 完成自回查与收尾落账（全体成员，硬规则）

任务标记 completed 之前，必须先自回查一轮，任一不通过不许标完成：

1. **产出存在**：任务描述或你承诺产出的每个文件路径，逐个验证真实存在（ls / fileRefs 检查）；任何一个不存在 → 不标 completed（status 留在 in_progress 或改 review），\`team_send_message\` 向 lead 报具体缺了什么，等指示。
2. **下游解除**：\`team_task_list\` 查有没有任务的 \`blocks\` 含本任务（下游任务）；有 → 在回报里提醒一句「任务 Y 已解除受阻，可派/可领」。

自回查通过、标记 completed 后，Teammate 回报 lead 之前，必须把本任务产生的经验/教训/可复用资产落账，不许只留在对话里：

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
