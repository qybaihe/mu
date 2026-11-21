/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Report rendering: turns scan/audit results into the markdown file the
 * inspection drops at `positions/_shared/inspections/YYYY-MM-DD.md`. The
 * report is a data artifact for the supervisor and the user, written in the
 * workspace's working language (Chinese, like the supervisor's injected
 * rules), NOT an i18n surface — only the receipt badge and settings rows in
 * the app UI localize. Worst-first ordering comes in from `rankFriction`.
 */

import type { ConversationFriction, ConversationMeta } from './frictionCore';
import type { ConversationWaste, LowOutputSession } from './wasteCore';

const IDLE_REASON_LABELS = {
  'tools-no-output': '工具烧了无产出',
  'error-no-output': '报错终止无产出',
  interrupted: '被用户打断',
} as const;

/** Everything one report file contains. */
export type InspectionReportInput = {
  dateKey: string;
  window: { from: number; to: number };
  ranAt: number;
  friction: ConversationFriction[];
  waste?: { conversations: ConversationWaste[]; lowOutput: LowOutputSession[] };
};

const fmtTime = (at: number): string => {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const scopeLabel = (meta: ConversationMeta): string => {
  if (meta.teamId) return `${meta.name}（团队${meta.role === 'lead' ? '·lead' : '·成员'}）`;
  if (meta.position) return `${meta.name}（岗位 ${meta.position}）`;
  return meta.name;
};

/** Renders the full markdown report; empty sections stay as honest "nothing found" lines. */
export function buildInspectionReport(input: InspectionReportInput): string {
  const lines: string[] = [];
  lines.push(`# 巡检报告 ${input.dateKey}`);
  lines.push('');
  lines.push(`- 生成时刻：${fmtTime(input.ranAt)}`);
  lines.push(`- 扫描窗口：${fmtTime(input.window.from)} ~ ${fmtTime(input.window.to)}`);
  lines.push(`- 覆盖会话：${input.friction.length} 个`);
  lines.push('');

  lines.push('## 摩擦扫描（报错与中断）');
  const withFriction = input.friction.filter((f) => f.errorTips > 0 || f.toolErrors > 0 || f.interrupts > 0);
  if (withFriction.length === 0) {
    lines.push('');
    lines.push('窗口内无报错、无工具失败、无用户中断。');
  } else {
    lines.push('');
    lines.push('| 会话 | 错误行 | 工具失败 | 被打断 | 用户轮次 |');
    lines.push('| --- | ---: | ---: | ---: | ---: |');
    for (const f of withFriction) {
      lines.push(`| ${scopeLabel(f.meta)} | ${f.errorTips} | ${f.toolErrors} | ${f.interrupts} | ${f.userTurns} |`);
    }
    const samples = withFriction.flatMap((f) => f.errorTipSamples.map((s) => ({ scope: scopeLabel(f.meta), ...s })));
    if (samples.length > 0) {
      lines.push('');
      lines.push('**错误样本（最多每会话 5 条）**：');
      for (const s of samples.slice(0, 12)) {
        const code = s.code ? ` \`${s.code}\`` : '';
        lines.push(`- ${s.scope}：${s.message}${code}`);
      }
    }
  }
  lines.push('');

  if (input.waste) {
    lines.push('## 浪费审计（空转与低产出）');
    const idle = input.waste.conversations.flatMap((c) =>
      c.idleTurns.map((t) => ({ scope: scopeLabel(c.meta), ...t }))
    );
    lines.push('');
    lines.push(`- 空转轮次：${idle.length}`);
    lines.push(`- 重复失败：${input.waste.conversations.reduce((n, c) => n + c.repeatedFailures.length, 0)} 组`);
    lines.push(`- 低产出会话：${input.waste.lowOutput.length} 个`);
    if (idle.length > 0) {
      lines.push('');
      lines.push('| 会话 | 空转原因 | 工具调用 | 产出字符 | 时刻 |');
      lines.push('| --- | --- | ---: | ---: | --- |');
      for (const t of idle.slice(0, 12)) {
        lines.push(
          `| ${t.scope} | ${IDLE_REASON_LABELS[t.reason]} | ${t.toolCalls} | ${t.assistantTextLen} | ${fmtTime(t.startedAt)} |`
        );
      }
    }
    const repeated = input.waste.conversations.flatMap((c) =>
      c.repeatedFailures.map((r) => ({ scope: scopeLabel(c.meta), ...r }))
    );
    if (repeated.length > 0) {
      lines.push('');
      lines.push('**重复失败（同错误 ≥2 次）**：');
      for (const r of repeated.slice(0, 8)) {
        lines.push(`- ${r.scope}：${r.message}（${r.count} 次）`);
      }
    }
    if (input.waste.lowOutput.length > 0) {
      lines.push('');
      lines.push('**低产出会话 Top**：');
      for (const s of input.waste.lowOutput) {
        lines.push(
          `- ${scopeLabel(s.meta)}：${s.turns} 轮，平均产出 ${s.avgAssistantTextLen} 字符，空转 ${s.badTurns} 轮`
        );
      }
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('> 本报告由桌面版常驻巡检自动生成（工作日摩擦扫描 / 周一浪费审计），可在设置中关闭。');
  lines.push('');
  return lines.join('\n');
}
