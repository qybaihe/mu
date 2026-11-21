/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The thinking-level vocabulary one level above the wire: the four levels a
 * position's frontmatter may declare and a dispatch may ask for, the
 * system-chore texts that always run with thinking off, and the ⚡
 * complexity evaluation (prompt and parse) that turns one task text into one
 * of those levels. Everything here is pure data in, data out — the callers
 * own the API calls and the conservative error direction: an absent
 * declaration, a malformed answer or a doubtful confidence must leave the
 * conversation's current level untouched.
 */
import { extractDecisionJson } from '@/common/chat/team/quickDecision/quickDecisionCore';

/**
 * The four levels the position vocabulary names. pi's own list is longer
 * (`minimal`, `xhigh`, `max`); every level here exists in pi's vocabulary,
 * and pi clamps to what the current model takes — so a model without `high`
 * lands on its own ceiling, never on an error.
 */
export const POSITION_THINKING_LEVELS = ['off', 'low', 'medium', 'high'] as const;
export type PositionThinkingLevel = (typeof POSITION_THINKING_LEVELS)[number];

/** Whether one frontmatter value names one of the four levels; anything else reads as no declaration. */
export function parsePositionThinkingField(value: string | undefined): PositionThinkingLevel | undefined {
  const trimmed = value?.trim().toLowerCase();
  return POSITION_THINKING_LEVELS.find((level) => level === trimmed);
}

/**
 * The texts that are the app's own bookkeeping, never a task: every wire
 * marker (`[[MU_TEAM_RECEIPT]]`, `[[MU_WEBHOOK]]`, …) opens with one. They
 * run with thinking off — the answer is a one-liner the cheapest possible
 * pass gives, and a thinking budget spent on them is pure waste.
 */
export const isSystemChoreText = (input: string): boolean => /^\s*\[\[MU_[A-Z_]+\]\]/.test(input);

/** The ⚡ answer for one task: set one of the four levels, or keep the current one. */
export type ThinkingLevelDecision =
  | { action: 'set'; level: PositionThinkingLevel; reason: string; confidence: number }
  | { action: 'keep'; reason: string };

/** One line of the shared system instruction, same discipline as every other quick decision. */
const JSON_DISCIPLINE =
  '你是一个判定器。只输出一行 JSON 对象，不要任何解释、markdown 或多余文字。置信度 confidence 是 0 到 1 的小数，不确定就给低值。';

/**
 * Point F's prompt: one task text, one complexity verdict. The bars are
 * deliberately concrete — mechanical lookups are off, single-step work is
 * low, ordinary multi-step work is medium, and only planning, architecture,
 * review or cross-domain integration is high.
 */
export function buildThinkingLevelPrompt(task: string): { system: string; user: string } {
  const excerpt = task.replace(/\s+/g, ' ').trim().slice(0, 2000);
  const user = [
    '评估下面这条任务要交给一个 AI 岗位会话执行时的思考深度档位（thinking level）。',
    '',
    `任务：${excerpt}`,
    '',
    '档位规则：',
    '- off：纯机械操作——查一个数、格式转换、改一行文案、点对点转告，不需要任何推理。',
    '- low：简单单步任务——一次查询/检索后直接作答、读一个文件总结要点。',
    '- medium：常规多步任务——多来源查证后整理成表、按既有流程跑完一段工作。',
    '- high：规划/架构/评审/跨域整合——设计方案、评估取舍、复核他人产出、多约束权衡。',
    '',
    '判定规则（拿不准就 keep，不动现状）：',
    '1. 任务明显落在某一档且无歧义 → 输出 set 并给该档。',
    '2. 任务跨档、表述含糊、或看不出工作量 → 输出 keep。',
    '',
    '只输出一行 JSON，二选一：',
    '{"action":"set","level":"off|low|medium|high","reason":"<15字内理由>","confidence":0.95}',
    '{"action":"keep","reason":"<15字内理由>","confidence":0.9}',
  ].join('\n');
  return { system: JSON_DISCIPLINE, user };
}

/** A level the parser will act on, or undefined when the model did not commit to one of the four. */
const actingLevel = (value: unknown): PositionThinkingLevel | undefined =>
  typeof value === 'string'
    ? POSITION_THINKING_LEVELS.find((level) => level === value.trim().toLowerCase())
    : undefined;

/**
 * Point F's answer from the model's raw output. Every doubt maps to `keep`:
 * no parseable object, an action other than set/keep, a `set` without one of
 * the four levels, or a confidence under the acting bar. The result is never
 * undefined — `keep` IS the conservative answer.
 */
export function parseThinkingLevelDecision(raw: string, options: { minConfidence: number }): ThinkingLevelDecision {
  const parsed = extractDecisionJson(raw);
  if (!parsed) return { action: 'keep', reason: 'unparseable-answer' };
  const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
  const confidence =
    typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence) ? parsed.confidence : 0;
  if (parsed.action !== 'set' && parsed.action !== 'keep') return { action: 'keep', reason: 'unknown-action' };
  if (parsed.action === 'keep') return { action: 'keep', reason: reason || 'model-kept' };
  const level = actingLevel(parsed.level);
  if (!level) return { action: 'keep', reason: 'level-not-named' };
  if (confidence < options.minConfidence) return { action: 'keep', reason: 'confidence-under-bar' };
  return { action: 'set', level, reason, confidence };
}

/** pi's full level order, weakest first — the ladder `clampThinkingLevelTo` walks. */
const PI_LEVEL_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * The level a config option will actually take: the requested one when the
 * option offers it, else the nearest offered level stepping toward `off`
 * first (the cheaper direction), else the lowest offered level above it.
 * `undefined` when the option offers nothing — the caller leaves the level
 * alone rather than guess.
 */
export function clampThinkingLevelTo(
  requested: PositionThinkingLevel,
  available: readonly string[]
): string | undefined {
  if (available.length === 0) return undefined;
  if (available.includes(requested)) return requested;
  const rank = PI_LEVEL_ORDER.indexOf(requested);
  const offered = PI_LEVEL_ORDER.filter((level) => available.includes(level));
  if (offered.length === 0 || rank < 0) return undefined;
  const lower = [...offered].reverse().find((level) => PI_LEVEL_ORDER.indexOf(level) < rank);
  if (lower) return lower;
  return offered.find((level) => PI_LEVEL_ORDER.indexOf(level) > rank);
}
