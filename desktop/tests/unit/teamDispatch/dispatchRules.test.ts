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

describe('the v2/v3 sections: gating, claiming, wrap-up ledger and dedup gate', () => {
  it('binds every member, not just the lead, and no longer tells teammates to ignore the file', () => {
    expect(TEAM_DISPATCH_RULES_VERSION).toBe(3);
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

  it('v3 requires a completion self-check before any completed mark', () => {
    expect(TEAM_DISPATCH_RULES_BODY).toContain('完成自回查与收尾落账（全体成员，硬规则）');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('任一不通过不许标完成');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('**产出存在**');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('任何一个不存在 → 不标 completed');
    expect(TEAM_DISPATCH_RULES_BODY).toContain('**下游解除**');
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
