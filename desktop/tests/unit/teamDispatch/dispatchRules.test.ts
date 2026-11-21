/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  planDispatchSeed,
  TEAM_DISPATCH_RULES_BLOCK,
  TEAM_DISPATCH_RULES_BODY,
  TEAM_DISPATCH_RULES_END_MARKER,
  TEAM_DISPATCH_RULES_VERSION,
} from '@/common/chat/team/teamDispatch/dispatchRules';

/** An older marked block, as a future version would find and replace. */
const olderBlock = (version: number): string =>
  `<!-- mu-team-dispatch v${version} -->\n旧版守则正文。\n${TEAM_DISPATCH_RULES_END_MARKER}`;

describe('planDispatchSeed', () => {
  it('seeds an empty workspace with the marked block alone', () => {
    const plan = planDispatchSeed(undefined);
    expect(plan.changed).toBe(true);
    expect(plan.next).toBe(TEAM_DISPATCH_RULES_BLOCK);
    expect(plan.next).toContain(`<!-- mu-team-dispatch v${TEAM_DISPATCH_RULES_VERSION} -->`);
    expect(plan.next.endsWith(TEAM_DISPATCH_RULES_END_MARKER)).toBe(true);
  });

  it('appends the block under the user’s own file, leaving their content first', () => {
    const userFile = '# 我的项目\n\n用户自己写的规矩，不许动。';
    const plan = planDispatchSeed(userFile);
    expect(plan.changed).toBe(true);
    expect(plan.next.startsWith('# 我的项目\n\n用户自己写的规矩，不许动。\n\n')).toBe(true);
    expect(plan.next.endsWith(TEAM_DISPATCH_RULES_BLOCK)).toBe(true);
  });

  it('replaces an older marked block in place, keeping content before and after it', () => {
    const existing = `# 开头\n\n${olderBlock(TEAM_DISPATCH_RULES_VERSION - 1)}\n\n# 结尾`;
    const plan = planDispatchSeed(existing);
    expect(plan.changed).toBe(true);
    expect(plan.next).toBe(`# 开头\n\n${TEAM_DISPATCH_RULES_BLOCK}\n\n# 结尾`);
  });

  it('never rewrites a file that already carries the current version', () => {
    const existing = `# 开头\n\n${TEAM_DISPATCH_RULES_BLOCK}\n\n# 结尾`;
    expect(planDispatchSeed(existing)).toEqual({ next: existing, changed: false });
  });

  it('keeps the user’s edits around a same-version block (no rewrite, no duplicate)', () => {
    const existing = `用户加的前言\n\n${TEAM_DISPATCH_RULES_BLOCK}\n用户加的后记`;
    expect(planDispatchSeed(existing)).toEqual({ next: existing, changed: false });
  });

  it('leaves the unmarked validated rules alone instead of appending a second copy', () => {
    const existing =
      '# 团队 Lead 自动分派守则（Team Lead Dispatch Rules）\n\n逐个 `team_task_create`，`owner` 不许留空，也不许设为你自己。\n';
    expect(planDispatchSeed(existing)).toEqual({ next: existing, changed: false });
  });

  it('is idempotent: seeding its own output changes nothing', () => {
    const once = planDispatchSeed('# 用户文件');
    expect(planDispatchSeed(once.next)).toEqual({ next: once.next, changed: false });
  });

  it('stays quiet on a version from the future', () => {
    const existing = olderBlock(TEAM_DISPATCH_RULES_VERSION + 1);
    expect(planDispatchSeed(existing)).toEqual({ next: existing, changed: false });
  });
});

describe('the v2-v4 sections: gating, claiming, ownership, wrap-up ledger and dedup gate', () => {
  it('binds every member, not just the lead, and no longer tells teammates to ignore the file', () => {
    expect(TEAM_DISPATCH_RULES_VERSION).toBe(6);
    expect(TEAM_DISPATCH_RULES_BODY).not.toContain('Teammate 读到时忽略本文件');
    expect(TEAM_DISPATCH_RULES_BODY).toContain(
      '「依赖门控与受阻任务」「待领任务与空闲主动认领」「完成自回查与收尾落账」「新项目/新岗位去重」各节约束全体成员'
    );
  });

  it('v3 gates dependencies: the lead never assigns a blocked task, members never touch one', () => {
    expect(TEAM_DISPATCH_RULES_BODY).toContain('依赖门控与受阻任务（全体成员，硬规则）');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('**lead 不派受阻任务**');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('**成员不碰受阻任务**');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('受阻任务绝不认领、绝不 `team_task_update` 它的 owner/status');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('后端不拦依赖');
  });

  it('v3 allows ownerless 待领 tasks and teaches idle members to claim by duty', () => {
    expect(TEAM_DISPATCH_RULES_BODY).toContain('待领任务与空闲主动认领（全体成员，硬规则）');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('可不带 owner 建为待领任务');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('没有 in_progress 任务');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('播报一句「我领了 <任务名>」');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('职责不匹配 → 不碰不抢');
  });

  it('v4 gates ownership: team_task_update is a member’s own two lanes only, never anyone else’s task', () => {
    expect(TEAM_DISPATCH_RULES_BODY).toContain('所有权闸（后端不拦所有权，人人自守）');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('成员对 `team_task_update` 的使用仅限两种');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('①认领 owner 为空的待领任务（改 owner=自己 + status=in_progress）');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('②流转 owner 是自己的任务');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('一律不得 update/delete，发现问题也不许代改');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('@ 对应负责人说，由他处置');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('lead 行使分派调度职责');
  });

  it('v3 requires a completion self-check before any completed mark', () => {
    expect(TEAM_DISPATCH_RULES_BODY).toContain('完成自回查与收尾落账（全体成员，硬规则）');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('任一不通过不许标完成');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('**产出存在**');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('任何一个不存在 → 不标 completed');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('**下游解除**');
  });

  it('v6 rides the self-check with a verdict line the report must carry (batch L ②)', () => {
    expect(TEAM_DISPATCH_RULES_BODY).toContain('**回报附核验结果（必带）**');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('自回查：N/M 产出路径已核验存在');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('自回查：无产出路径，无需核验');
    // The system re-checks the same standard and marks the card — the rule says so.
    expect(TEAM_DISPATCH_RULES_BODY).toContain('标「待验证」');
  });

  it('teaches the member ledger: project-root HANDOFF.md, team-workspace fallback, new-project archive', () => {
    expect(TEAM_DISPATCH_RULES_BODY).toContain('完成自回查与收尾落账（全体成员，硬规则）');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('~/.mu/agent/agents/<槽位名>.md');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('追加**写入该项目根的 `HANDOFF.md`');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('LESSON: ');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('落账到团队工作区（当前目录）的 `HANDOFF.md`');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('与 `HANDOFF.md`（首条记录');
  });

  it('makes the lead’s final summary name every member’s ledger location', () => {
    expect(TEAM_DISPATCH_RULES_BODY).toContain('本次各岗落账位置');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('写明自己的落账文件完整路径');
  });

  it('keeps the v1 fingerprint sentence, so the unmarked validated copy still reads as present', () => {
    expect(TEAM_DISPATCH_RULES_BODY).toContain('`owner` 不许留空，也不许设为你自己');
  });

  it('replaces a live v1 block with the v2 one in place', () => {
    const v1 = `<!-- mu-team-dispatch v1 -->\n旧版守则正文。\n${TEAM_DISPATCH_RULES_END_MARKER}`;
    const existing = `# 用户前言\n\n${v1}\n用户后记`;
    const plan = planDispatchSeed(existing);
    expect(plan.changed).toBe(true);
    expect(plan.next).toContain(`<!-- mu-team-dispatch v${TEAM_DISPATCH_RULES_VERSION} -->`);
    expect(plan.next).toContain('完成自回查与收尾落账（全体成员，硬规则）');
    expect(plan.next).toContain('# 用户前言');
    expect(plan.next).toContain('用户后记');
  });
});

describe('the v5 section: thinking-level dispatch duty', () => {
  it('names the think tool with its four levels and the clamp behaviour', () => {
    expect(TEAM_DISPATCH_RULES_BODY).toContain('思考档分派（lead 的权与责，硬规则）');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('teams.cjs think --team');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('<off|low|medium|high>');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('自动就近');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('不阻塞分派');
  });
  it('grades the four bars and honours the position default declared in its md', () => {
    expect(TEAM_DISPATCH_RULES_BODY).toContain('纯机械操作');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('简单单步');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('常规多步');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('规划/架构/评审/跨域整合');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('`thinking: 档位`');
  });
  it('pins the chores to off and forbids model switching through think', () => {
    expect(TEAM_DISPATCH_RULES_BODY).toContain('**内部杂务固定 off**');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('回执播报、巡检摘要播报、纯转告、纯确认');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('**只调档不换模型**');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('拿不准时不动现状');
  });
  it('upgrades a live v4 block in place, keeping the surroundings', () => {
    const v4 = `<!-- mu-team-dispatch v4 -->
旧版守则正文。
${TEAM_DISPATCH_RULES_END_MARKER}`;
    const existing = `# 用户前言

${v4}
用户后记`;
    const plan = planDispatchSeed(existing);
    expect(plan.changed).toBe(true);
    expect(plan.next).toContain(`<!-- mu-team-dispatch v${TEAM_DISPATCH_RULES_VERSION} -->`);
    expect(plan.next).toContain('思考档分派（lead 的权与责，硬规则）');
    expect(plan.next).toContain('# 用户前言');
    expect(plan.next).toContain('用户后记');
  });
});
