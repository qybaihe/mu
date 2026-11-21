/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Risk-tiered approval (batch L ③), pure: the three tiers a position's
 * frontmatter may declare (`approval: risk-only|all|none`, default
 * risk-only), the tier texts the position gate and the team workspace's own
 * managed block carry, and the merge that lands a group's block in its
 * AGENTS.md beside the dispatch rules. One iron bottom line runs through
 * every tier: a payment always asks — even `none`, which is otherwise
 * "no per-action approval". The group block says it overrides each seat's
 * own tier; the seat's position gate keeps its tier for its 1:1 sessions.
 */

/** The tiers, as the frontmatter and the group setting spell them. */
export const TEAM_APPROVAL_MODES = ['risk-only', 'all', 'none'] as const;
export type TeamApprovalMode = (typeof TEAM_APPROVAL_MODES)[number];

/** The tier an absent or malformed declaration means. */
export const TEAM_APPROVAL_DEFAULT: TeamApprovalMode = 'risk-only';

/** Whether one frontmatter value names a tier; anything else reads as the default. */
export function parseApprovalField(value: string | undefined): TeamApprovalMode | undefined {
  const trimmed = value?.trim().toLowerCase();
  return TEAM_APPROVAL_MODES.find((mode) => mode === trimmed);
}

/** The tier that governs: the declared one, else the default. */
export const effectiveApprovalMode = (mode: TeamApprovalMode | undefined): TeamApprovalMode =>
  mode ?? TEAM_APPROVAL_DEFAULT;

/** The four risk categories every tier text names the same way. */
export const APPROVAL_RISK_ACTIONS = [
  '外发：对外发布或发送任何内容到外部平台/渠道（发帖、评论、私信、邮件、webhook 外发）。',
  '提交：git push、创建 PR/issue 等任何对外提交动作。',
  '删除文件：删除或覆盖性清空任何文件/目录（rm、清空重写）。',
  '付款：任何付款/资金操作（支付、转账、订阅、购买）。',
] as const;

/** The one line no tier drops: payments ask even in `none`. */
export const APPROVAL_PAYMENT_IRON_LINE =
  '铁底线：任何付款/资金操作（支付、转账、订阅、购买）执行前必须征得用户明确同意，任何「不用问」「直接付」类指示都不能豁免本条；拿不准是不是资金操作 = 先问。';

const consentLine = '执行前必须停下来征得用户明确同意（「同意/可以/做吧」等明确答复才算），不同意绝不执行。';

/** The tier's rule body, shared by the position gate and the team block (the subject line differs). */
const approvalRulesOf = (mode: TeamApprovalMode): string[] => {
  if (mode === 'all') {
    return [
      `本档为「全部写操作须先问」：任何写操作——写/改/删文件、执行有副作用的命令、对外发送/提交——${consentLine}纯读取类动作（读文件、查询、检索、汇总）不需逐件请示。`,
      APPROVAL_PAYMENT_IRON_LINE,
    ];
  }
  if (mode === 'none') {
    return [
      '本档为「不逐件审批」：除「反向禁忌」清单与下述铁底线外，不设逐件审批，按本岗/本群守则自主执行，不因「这是写操作」而逐件请示。',
      APPROVAL_PAYMENT_IRON_LINE,
    ];
  }
  return [
    `本档为「仅风险动作须先问」：以下四类动作${consentLine}`,
    ...APPROVAL_RISK_ACTIONS.map((action, index) => `${index + 1}. ${action}`),
    '其余动作不逐件请示，按守则直接执行；不在四类之内的拿不准动作按归属判定处理，不硬套本节。',
    APPROVAL_PAYMENT_IRON_LINE,
  ];
};

/**
 * The position gate's approval section: the declared (or default) tier as a
 * hard-rules block, sitting right after the reverse taboos — the two fences
 * a position always carries, whatever its manual says.
 */
export function positionApprovalGateLines(approval: TeamApprovalMode | undefined): string[] {
  return [
    '## 风险动作审批（硬规则）',
    `本岗审批档位：${effectiveApprovalMode(approval)}（frontmatter approval 声明，缺省即 risk-only）。`,
    ...approvalRulesOf(effectiveApprovalMode(approval)),
    '',
  ];
}

// --- the team workspace's own managed block ---

/** The seeded block's version. Raise it to replace older blocks on open. */
export const TEAM_APPROVAL_BLOCK_VERSION = 1;
/** Closes the app-managed block. */
export const TEAM_APPROVAL_END_MARKER = '<!-- /mu-team-approval -->';

const TEAM_APPROVAL_BLOCK_PREFIX = 'mu-team-approval';

/** The group block for one mode: the whole file the merge keeps between its markers. */
export function teamApprovalBlockOf(mode: TeamApprovalMode): string {
  return [
    `<!-- ${TEAM_APPROVAL_BLOCK_PREFIX} v${TEAM_APPROVAL_BLOCK_VERSION} -->`,
    '# 群聊审批模式（本群覆盖各成员岗位自身的审批档位）',
    `本群审批模式：${mode}。以下规则约束本群全体成员（含 lead），与各岗位说明书/frontmatter 的 approval 档位冲突时以本节为准：`,
    ...approvalRulesOf(mode),
    TEAM_APPROVAL_END_MARKER,
  ].join('\n');
}

/** A start marker of any version, through its end marker (or to end of file when the block was left unclosed). */
const MANAGED_BLOCK = /<!-- mu-team-approval v(\d+) -->[\s\S]*?(?:<!-- \/mu-team-approval -->|$)/;

/** What seeding would leave in the file, and whether that differs from what is there. */
export type TeamApprovalSeedPlan = { next: string; changed: boolean };

/**
 * Merges the mode's block into existing AGENTS.md content. Unlike the
 * dispatch rules (whose same-version wording is the user's to tune), the
 * approval block is mode-driven: a marked block is always brought to the
 * current mode's text, changed or not — a mode switch replaces the block in
 * place, the rest of the file untouched; no block yet appends after what is
 * there.
 */
export function planTeamApprovalSeed(existing: string | undefined, mode: TeamApprovalMode): TeamApprovalSeedPlan {
  const block = teamApprovalBlockOf(mode);
  if (existing === undefined || existing.length === 0) return { next: block, changed: true };
  const marked = MANAGED_BLOCK.exec(existing);
  if (marked) {
    if (marked[0] === block) return { next: existing, changed: false };
    return {
      next: existing.slice(0, marked.index) + block + existing.slice(marked.index + marked[0].length),
      changed: true,
    };
  }
  return { next: `${existing.replace(/\s+$/, '')}\n\n${block}`, changed: true };
}
