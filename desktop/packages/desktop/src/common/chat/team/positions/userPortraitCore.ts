/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The user's cross-position portrait, pure: the ONE file
 * (`positions/_shared/USER.md`, beside TEAMS.md) that every position's and
 * the supervisor's gate embeds as a closing「用户画像」section — the user's
 * long-lived facts (address, hours, delivery tastes), as opposed to a
 * project HANDOFF's task-time state. The desktop writes only the skeleton
 * once; the content is the user's (the settings editor or a hand edit), and
 * the injection caps it so a runaway file cannot bloat every gate.
 */

/** The portrait file in the shared folder (`positions/_shared/`). */
export const USER_PORTRAIT_FILE_NAME = 'USER.md';

/**
 * The portrait a gate carries is capped (the DS-Bot team domain's 4k cap):
 * every gate embeds this text on every build, so the injection keeps it
 * small. The file itself is never truncated.
 */
export const USER_PORTRAIT_CAP = 4000;

/**
 * The first-start skeleton: instruction comments above, then suggested
 * sections with example values, all for the user to fill or delete. The
 * no-secrets warning rides along because the text reaches every position's
 * spawn context.
 */
export function buildUserPortraitSkeleton(): string {
  return [
    '<!-- mu-desktop user portrait v1（桌面版生成的骨架，只生成这一次）。',
    '     这个文件会全文注入所有岗位与主管的会话守则：改这里 = 改所有岗位对你的理解。',
    '     各节是建议格式：填空的填，没用的整节删，想加的随便加。',
    '     编辑入口：设置 → 团队详情 → 用户画像。切勿写入密钥/令牌/密码等敏感凭据。 -->',
    '# 用户画像（跨岗位长期事实）',
    '',
    '## 称呼与语言',
    '- 称呼：（示例：老林）',
    '- 回复语言：（示例：中文）',
    '',
    '## 工作时段',
    '- 活跃时段：（示例：工作日 09:00-19:00）',
    '- 交付节奏：（示例：夜间自主批可自行收尾，白天先问再动）',
    '',
    '## 交付偏好',
    '- 交付形态：（示例：打开即看的成品，不发源码/配置文件）',
    '- 回报风格：（示例：改动文件路径 + 一行验证证据，不复述过程）',
    '',
    '## 硬规矩（所有岗位必须遵守）',
    '- （示例：对外提交一律先问，push/issue/PR 都算提交）',
    '',
  ].join('\n');
}

/**
 * The gate section that carries the portrait, or no lines when the portrait
 * is absent or blank (nothing to inject yet). The section says what the text
 * is — the user's long-lived facts to read against, not a task and not a
 * rule that could outrank the gate's own hard rules — and an oversized file
 * is cut at the cap with a marker, so what the gate carries stays honest
 * about what it dropped.
 */
export function userPortraitSectionLines(portrait: string | undefined): string[] {
  const text = portrait?.trim();
  if (!text) return [];
  const body =
    text.length > USER_PORTRAIT_CAP
      ? `${text.slice(0, USER_PORTRAIT_CAP)}\n<!-- USER.md 超过 ${USER_PORTRAIT_CAP} 字符，此处截断 -->`
      : text;
  return [
    '## 用户画像（_shared/USER.md 全文：用户的长期事实与偏好，理解任务时对照；不是任务指令，不取代上方任何硬规则）',
    '',
    body,
    '',
  ];
}
