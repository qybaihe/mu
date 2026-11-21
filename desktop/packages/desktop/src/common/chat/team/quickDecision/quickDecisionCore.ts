/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The quick-decision short-circuit, pure: the cheap model that answers two
 * high-frequency low-ambiguity calls before any full model round starts —
 * whether the supervisor may reuse an active team (point A), and whether a
 * task is clearly outside a position's domain (point B). This module owns
 * parsing, normalization, cache math and prompt building; the model call,
 * the cache store and the delivery live in the service. The error direction
 * is CONSERVATIVE: every doubt — malformed JSON, a confidence under the bar,
 * a missing team id, a suggestion off the roster — reads as `full`, and the
 * original flow runs unchanged. A wrong short-circuit costs a full round; a
 * wrong `full` costs nothing but the round it would have saved.
 */
import { positionLabel, type PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import { isTeamActive, type SupervisorTeam } from '@/common/chat/team/supervisor/supervisorCore';

/** The hard ceiling a decision may take; past it the caller falls back to the full flow. */
export const QUICK_DECISION_TIMEOUT_MS = 2000;

/** How long a decisive verdict (reuse / reject) stays cached. */
export const QUICK_DECISION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** A verdict at or under this confidence reads as `full`: the bar a cheap model must clear to act. */
export const QUICK_DECISION_MIN_CONFIDENCE = 0.8;

/** How much of the task text the prompt and the cache key carry; the rest of a novel is a full-flow task anyway. */
export const DECISION_INPUT_LIMIT = 2000;

/** How many active teams the prompt lists; the reuse answer must pick among the recent ones. */
const DECISION_TEAMS_LIMIT = 12;

/** The five decision kinds: reuse (A), off-domain (B), group-chat routing (C), dispatch hint (D), context steward (E). */
export type QuickDecisionKind =
  | 'supervisor-reuse'
  | 'position-domain'
  | 'team-route'
  | 'dispatch-hint'
  | 'context-steward';

/** Point A's answer: reuse one active team, or hand the task to the full supervisor flow. */
export type SupervisorReuseDecision =
  | { action: 'reuse'; teamId: string; reason: string; confidence: number }
  | { action: 'full'; reason: string };

/** Point B's answer: reject as clearly off-domain and point at a roster position, or run the position's full flow. */
export type PositionDomainDecision =
  | { action: 'reject'; suggest: string; reason: string; confidence: number }
  | { action: 'full'; reason: string };

/** Point C's member options: the teammates a direct route may name (never the lead — addressing the lead IS the whole-team path). */
export type TeamMemberOption = { slotId: string; name: string };

/** Point C's answer: the message clearly addresses one teammate (deliver to that slot), or the whole-team flow runs. */
export type TeamRouteDecision =
  | { action: 'direct'; slotId: string; reason: string; confidence: number }
  | { action: 'full'; reason: string };

/** Point D's answer: roster positions worth the supervisor's first look, or no hint at all. */
export type DispatchHintDecision =
  | { action: 'hint'; positions: string[]; reason: string; confidence: number }
  | { action: 'none'; reason: string };

/** Point E's answer, as the engine may state it. Doubt never resolves here — the steward applies its own lossless fallback. */
export type ContextStewardDecision = { action: 'compact' | 'switch' | 'none'; reason: string };

/** Either kind's decisive verdict — the only answers worth caching. */
export type QuickDecisionVerdict =
  | SupervisorReuseDecision
  | PositionDomainDecision
  | TeamRouteDecision
  | DispatchHintDecision;

/** One cached verdict: what it decided, and when it stops standing in for a model call. */
export type QuickDecisionCacheEntry = { verdict: QuickDecisionVerdict; expiresAt: number };

/** Whether a cached verdict may still answer: past its TTL it must be re-asked. */
export const isCacheEntryFresh = (entry: QuickDecisionCacheEntry | undefined, now: number): boolean =>
  entry !== undefined && entry.expiresAt > now;

/**
 * The task text as a cache key sees it: Unicode-normalized, whitespace
 * folded, lower-cased, capped — so 「查一下   CNS客户」 and 「查一下 CNS客户」
 * are one task, while any real difference stays a different key.
 */
export const normalizeDecisionInput = (input: string): string =>
  input.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, DECISION_INPUT_LIMIT);

/** The cache key of one decision: kind + the position/supervisor scope it was asked in + the normalized task. */
export const decisionCacheKey = (kind: QuickDecisionKind, scope: string, input: string): string =>
  `${kind}:${scope}:${normalizeDecisionInput(input)}`;

/**
 * The JSON object in a model's answer, or undefined. Cheap models wrap their
 * one line in prose or a code fence; the answer is still just the first
 * balanced object — but anything that does not parse is NO decision (the
 * caller falls back), never a guess.
 */
export function extractDecisionJson(raw: string): Record<string, unknown> | undefined {
  const candidates: string[] = [raw];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fenced?.[1]) candidates.unshift(fenced[1]);
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate shape.
    }
  }
  return undefined;
}

/** A confidence the caller will act on, or undefined when the model did not commit to one — doubt reads as `full`. */
const actingConfidence = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;

/**
 * Point A's answer from the model's raw output. Every doubt maps to `full`:
 * no parseable object, an action other than reuse/full, a `reuse` without a
 * team id, or a confidence under the bar. The result is never undefined —
 * the conservative answer IS `full`.
 */
export function parseSupervisorReuseDecision(raw: string): SupervisorReuseDecision {
  const parsed = extractDecisionJson(raw);
  if (parsed === undefined) return { action: 'full', reason: 'malformed-answer' };
  const reason = typeof parsed.reason === 'string' ? parsed.reason : 'model-says-full';
  if (parsed.action === 'full') return { action: 'full', reason };
  if (parsed.action !== 'reuse') return { action: 'full', reason: 'unknown-action' };
  const teamId = typeof parsed.teamId === 'string' ? parsed.teamId.trim() : '';
  const confidence = actingConfidence(parsed.confidence);
  if (!teamId || confidence === undefined || confidence < QUICK_DECISION_MIN_CONFIDENCE) {
    return {
      action: 'full',
      reason:
        confidence !== undefined && confidence < QUICK_DECISION_MIN_CONFIDENCE ? 'low-confidence' : 'missing-team-id',
    };
  }
  return { action: 'reuse', teamId, reason, confidence };
}

/**
 * Point B's answer from the model's raw output, against the roster the
 * suggestion must name. A `reject` whose `suggest` is not a roster position
 * (by id or display name) is `full`: the receipt must never point at an
 * invented position.
 */
export function parsePositionDomainDecision(raw: string, roster: readonly PositionInfo[]): PositionDomainDecision {
  const parsed = extractDecisionJson(raw);
  if (parsed === undefined) return { action: 'full', reason: 'malformed-answer' };
  const reason = typeof parsed.reason === 'string' ? parsed.reason : 'model-says-full';
  if (parsed.action === 'full') return { action: 'full', reason };
  if (parsed.action !== 'reject') return { action: 'full', reason: 'unknown-action' };
  const suggested = typeof parsed.suggest === 'string' ? parsed.suggest.trim() : '';
  const match = roster.find((position) => position.name === suggested || position.displayName === suggested);
  const confidence = actingConfidence(parsed.confidence);
  if (!match || confidence === undefined || confidence < QUICK_DECISION_MIN_CONFIDENCE) {
    return { action: 'full', reason: !match ? 'suggestion-off-roster' : 'low-confidence' };
  }
  return { action: 'reject', suggest: match.name, reason, confidence };
}

/** Point C's teammates from a team detail: slot ids and names, known teammates only (the lead excluded, half-formed rows excluded). */
export const teamMembersForRoute = (
  assistants: ReadonlyArray<{ slot_id?: string; role?: string; assistant_name?: string }>
): TeamMemberOption[] =>
  assistants
    .filter(
      (assistant) => assistant.role === 'teammate' && Boolean(assistant.slot_id) && Boolean(assistant.assistant_name)
    )
    .map((assistant) => ({ slotId: assistant.slot_id ?? '', name: assistant.assistant_name ?? '' }));

/**
 * Point C's answer from the model's raw output, against the teammates the
 * slot id must name. A `direct` whose slot is not a teammate is `full`: a
 * route must never invent a member.
 */
export function parseTeamRouteDecision(raw: string, members: readonly TeamMemberOption[]): TeamRouteDecision {
  const parsed = extractDecisionJson(raw);
  if (parsed === undefined) return { action: 'full', reason: 'malformed-answer' };
  const reason = typeof parsed.reason === 'string' ? parsed.reason : 'model-says-full';
  if (parsed.action === 'full') return { action: 'full', reason };
  if (parsed.action !== 'direct') return { action: 'full', reason: 'unknown-action' };
  const slotId = typeof parsed.slotId === 'string' ? parsed.slotId.trim() : '';
  const confidence = actingConfidence(parsed.confidence);
  if (!slotId || confidence === undefined || confidence < QUICK_DECISION_MIN_CONFIDENCE) {
    return {
      action: 'full',
      reason:
        confidence === undefined
          ? 'missing-confidence'
          : confidence < QUICK_DECISION_MIN_CONFIDENCE
            ? 'low-confidence'
            : 'missing-slot-id',
    };
  }
  if (!members.some((member) => member.slotId === slotId)) {
    return { action: 'full', reason: 'slot-not-member' };
  }
  return { action: 'direct', slotId, reason, confidence };
}

/**
 * Point D's answer from the model's raw output, against the roster the
 * positions must name. Off-roster ids are dropped — the hint may be
 * sparser than promised, never wronger — and an empty remainder is `none`.
 */
export function parseDispatchHintDecision(raw: string, roster: readonly PositionInfo[]): DispatchHintDecision {
  const parsed = extractDecisionJson(raw);
  if (parsed === undefined) return { action: 'none', reason: 'malformed-answer' };
  const reason = typeof parsed.reason === 'string' ? parsed.reason : 'model-says-none';
  if (parsed.action === 'none') return { action: 'none', reason };
  if (parsed.action !== 'hint') return { action: 'none', reason: 'unknown-action' };
  const confidence = actingConfidence(parsed.confidence);
  if (confidence === undefined || confidence < QUICK_DECISION_MIN_CONFIDENCE) {
    return { action: 'none', reason: confidence !== undefined ? 'low-confidence' : 'missing-confidence' };
  }
  if (!Array.isArray(parsed.positions)) return { action: 'none', reason: 'missing-positions' };
  const ids = parsed.positions
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map((id) => id.trim());
  // Accept an id or a display name; canonicalize to the id so downstream lookups stay one-shaped.
  const onRoster = ids.flatMap((id) => {
    const match = roster.find((position) => position.name === id || position.displayName === id);
    return match ? [match.name] : [];
  });
  if (onRoster.length === 0)
    return { action: 'none', reason: ids.length === 0 ? 'no-positions' : 'positions-off-roster' };
  return { action: 'hint', positions: onRoster, reason, confidence };
}

/** Point E's answer from the model's raw output, or undefined when nothing usable was said — the CALLER owns the conservative direction (switch where allowed, compact where not), because eligibility is a steward fact the engine cannot see. */
export function parseContextStewardDecision(raw: string): ContextStewardDecision | undefined {
  const parsed = extractDecisionJson(raw);
  if (parsed === undefined) return undefined;
  if (parsed.action !== 'compact' && parsed.action !== 'switch' && parsed.action !== 'none') return undefined;
  const reason = typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim().slice(0, 120) : '';
  return { action: parsed.action, reason };
}

/** The active teams a reuse may pick from, most recently used first, capped. */
export const activeTeamsForDecision = (teams: readonly SupervisorTeam[], now: number): SupervisorTeam[] =>
  teams
    .filter((team) => isTeamActive(team, now))
    .toSorted((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, DECISION_TEAMS_LIMIT);

/** One line of the shared system instruction: answer as a strict one-line JSON object, nothing else. */
const JSON_DISCIPLINE =
  '你是一个判定器。只输出一行 JSON 对象，不要任何解释、markdown 或多余文字。置信度 confidence 是 0 到 1 的小数，不确定就给低值。';

/** The capped task text the prompt carries. */
const taskExcerpt = (task: string): string => task.replace(/\s+/g, ' ').trim().slice(0, DECISION_INPUT_LIMIT);

/**
 * Point A's prompt: the task, the active teams, the roster. Reuse is the
 * answer ONLY when one active team's positions clearly cover the task and
 * the task clearly belongs to that team's domain — anything else is `full`,
 * where the supervisor's own rules (match, build, propose) take over.
 */
export function buildSupervisorReusePrompt(options: {
  task: string;
  teams: readonly SupervisorTeam[];
  roster: readonly PositionInfo[];
}): { system: string; user: string } {
  const labelOf = (positionId: string): string => {
    const found = options.roster.find((position) => position.name === positionId);
    return found ? positionLabel(found) : positionId;
  };
  const teamLines =
    options.teams.length === 0
      ? ['（无现役团队）']
      : options.teams.map(
          (team) => `- teamId=${team.teamId} 「${team.name}」：${team.positions.map(labelOf).join('、')}`
        );
  const rosterLines =
    options.roster.length === 0
      ? ['（名册为空）']
      : options.roster.map((position) => `- ${positionLabel(position)} — ${position.description}`);
  const user = [
    '判断主管收到下面这条任务时，能否直接复用某个现役团队（把任务原文发给该队 lead，不经过完整主管流程）。',
    '',
    `任务：${taskExcerpt(options.task)}`,
    '',
    '现役团队（按最近使用排序）：',
    ...teamLines,
    '',
    '岗位名册：',
    ...rosterLines,
    '',
    '判定规则（宁可 full，不可错派）：',
    '1. 只有当某个现役团队的岗位组合明确覆盖任务所需能力、且任务域与该队的岗位组合一致时，才输出 reuse 并给该队的 teamId。',
    '2. 任务需要新建团队、需要主管追问澄清、需要起草新岗位、或对哪个队匹配有任何不确定 → 输出 full。',
    '3. 任务不是派发类请求（闲聊、查询团队状态、询问流程）→ 输出 full。',
    '',
    '只输出一行 JSON，二选一：',
    '{"action":"reuse","teamId":"<现役团队的 teamId>","reason":"<15字内理由>","confidence":0.95}',
    '{"action":"full","reason":"<15字内理由>","confidence":0.9}',
  ].join('\n');
  return { system: JSON_DISCIPLINE, user };
}

/**
 * Point B's prompt: the task, the position's own description and manual
 * excerpt, the roster. Reject is the answer ONLY when the task is clearly
 * another position's job and the roster names that position — in-domain,
 * cross-domain-but-unclear, and anything doubtful are `full`.
 */
export function buildPositionDomainPrompt(options: {
  task: string;
  position: Pick<PositionInfo, 'name' | 'displayName' | 'description' | 'body'>;
  roster: readonly PositionInfo[];
}): { system: string; user: string } {
  const own = positionLabel(options.position);
  const rosterLines = options.roster.map((position) => `- ${positionLabel(position)} — ${position.description}`);
  const manual = taskExcerpt(options.position.body ?? '').slice(0, 600);
  const user = [
    `判断下面这条任务是否明显不属于「${own}」岗位的职责域（该岗收到后应直接拒收并转交）。`,
    '',
    `任务：${taskExcerpt(options.task)}`,
    '',
    `本岗：${own} — ${options.position.description || '（无职责描述）'}`,
    manual ? `本岗说明书摘录：${manual}` : '（本岗无说明书正文）',
    '',
    '岗位名册（转交建议只能从下列岗位中选）：',
    ...rosterLines,
    '',
    '判定规则（宁可 full，不可误拒）：',
    '1. 只有当任务明显属于名册中另一个岗位的职责域、且那一个岗位明确更匹配时，才输出 reject 并在 suggest 里给那个岗位的英文 id。',
    '2. 任务属于本岗、或与本岗职责有交集、或拿不准、或需要向用户追问 → 输出 full。',
    '3. 名册里没有明确更匹配的岗位 → 输出 full。',
    '',
    '只输出一行 JSON，二选一：',
    '{"action":"reject","suggest":"<岗位英文id>","reason":"<15字内理由>","confidence":0.95}',
    '{"action":"full","reason":"<15字内理由>","confidence":0.9}',
  ].join('\n');
  return { system: JSON_DISCIPLINE, user };
}

/**
 * Point C's prompt: the group-chat message, the teammates. Direct is the
 * answer ONLY when the message text itself addresses exactly one teammate —
 * it names them, or it unmistakably follows up that one member's own work.
 * A new goal, anything needing the lead's dispatch, several members, or the
 * lead itself is `full`: the whole-team path, where the message text alone
 * cannot carry the attribution, is the conservative answer.
 */
export function buildTeamRoutePrompt(options: { message: string; members: readonly TeamMemberOption[] }): {
  system: string;
  user: string;
} {
  const memberLines = options.members.map((member) => `- slotId=${member.slotId} 「${member.name}」`);
  const user = [
    '用户在团队群聊里发了一条消息。判断这条消息是否明确只指向其中一名成员（应由该成员直接处理，不需要 lead 主持的全队分派）。',
    '',
    `消息：${taskExcerpt(options.message)}`,
    '',
    '成员名单（direct 的 slotId 只能从下列成员中选）：',
    ...memberLines,
    '',
    '判定规则（宁可 full，不可误定向）：',
    '1. 只有当消息本身明确点名一名成员（出现其名字或明显别名，如「货代，继续查」「让视频岗把片头改了」），或明确是对某一名成员刚交付结果的追问/催办/补充材料时，才输出 direct 并给该成员的 slotId。',
    '2. 消息给出新目标或新任务（需要拆解、分派、多人协作）→ 输出 full（那是 lead 的分派路径）。',
    '3. 消息指向多名成员、指向 lead 本人或汇总/管理工作、无明确单一指向（如单独的「继续」「好的」）、或任何拿不准 → 输出 full。',
    '4. 名单里有同名编号成员（如「货代」与「货代 2」）时，点名「货代」指不带编号后缀的那一位；只点到姓氏/职位域而无精确成员 → full。',
    '',
    '只输出一行 JSON，二选一：',
    '{"action":"direct","slotId":"<成员slotId>","reason":"<15字内理由>","confidence":0.95}',
    '{"action":"full","reason":"<15字内理由>","confidence":0.9}',
  ].join('\n');
  return { system: JSON_DISCIPLINE, user };
}

/**
 * Point E's prompt: one long-lived session past its check line, and the one
 * question — compact in place (lossy) or switch to a fresh part (lossless).
 * Mid-work prefers the switch (a summary of half-finished work loses the
 * thread); settled work and chatter compact; every compaction already taken
 * makes the next summary weaker, tilting toward switch.
 */
export function buildContextStewardPrompt(options: {
  goal: string;
  percent: number;
  tokens: number;
  contextWindow: number;
  checkLine: number;
  compactions: number;
  midWorkHint: 'mid-work' | 'settled' | 'unclear';
  lastExcerpt: string;
}): { system: string; user: string } {
  const excerpt = options.lastExcerpt.replace(/\s+/g, ' ').trim().slice(-300);
  const percentText = Number.isFinite(options.percent) ? `${Math.round(options.percent * 100)}%` : '未知';
  const user = [
    `会话「${taskExcerpt(options.goal)}」的上下文已过检查线，需要原地压缩（compact）或换新会话分卷（switch）二选一。`,
    '',
    `会话目标：${taskExcerpt(options.goal)}`,
    `上下文占用：${percentText}（${options.tokens} / ${options.contextWindow} tokens，检查线 ${options.checkLine}）`,
    `本会话已被管家压缩过 ${options.compactions} 次`,
    `最近一轮状态：${
      options.midWorkHint === 'mid-work'
        ? '任务进行中（上一轮是工作产出，非收尾）'
        : options.midWorkHint === 'settled'
          ? '工作已收尾或闲聊'
          : '不明确'
    }`,
    excerpt ? `最近回复摘录：${excerpt}` : '（无回复摘录）',
    '',
    '判定规则：',
    '1. 任务进行中、上下文里有未完成的承诺或待办 → switch（无损：旧会话全量留档，新会话干净开局）。',
    '2. 工作已收尾、闲聊、或会话只承载零散问答 → compact（原地压缩，保留摘要继续用）。',
    '3. 已压缩次数越多越倾向 switch（摘要的摘要损失更大）。',
    '4. 拿不准 → switch。',
    '',
    '只输出一行 JSON，三选一：',
    '{"action":"compact","reason":"<15字内理由>"}',
    '{"action":"switch","reason":"<15字内理由>"}',
    '{"action":"none","reason":"<15字内理由>"}',
  ].join('\n');
  return { system: JSON_DISCIPLINE, user };
}

/**
 * Point D's prompt: the task, the roster. The hint is advisory — the
 * supervisor re-checks it against the task — so the bar is precision over
 * recall: a wrong candidate costs the supervisor attention, a missed one
 * costs nothing (it matches on its own). Non-task chatter answers none.
 */
export function buildDispatchHintPrompt(options: { task: string; roster: readonly PositionInfo[] }): {
  system: string;
  user: string;
} {
  const rosterLines =
    options.roster.length === 0
      ? ['（名册为空）']
      : options.roster.map((position) => `- ${positionLabel(position)} — ${position.description}`);
  const user = [
    '用户给团队主管发了一条消息。从岗位名册中预匹配与该消息直接相关的候选岗位（主管将优先核对这些岗，再决定组队匹配），供主管参考。',
    '',
    `消息：${taskExcerpt(options.task)}`,
    '',
    '岗位名册（positions 只能从下列岗位中选）：',
    ...rosterLines,
    '',
    '判定规则（宁缺勿滥）：',
    '1. 选描述与任务（或其一部分）直接相关的岗位，少而精，最多 3 个；复合任务可选多个（如「调研+做图」= 调研岗、做图岗）。',
    '2. 消息不是派发类请求（闲聊、查询团队状态、询问流程、确认/答复）→ positions 给空数组。',
    '3. 名册中没有明显相关的岗位，或拿不准 → positions 给空数组（主管会自行全名册匹配）。',
    '',
    '只输出一行 JSON，二选一：',
    '{"action":"hint","positions":["<岗位英文id>","<岗位英文id>"],"reason":"<15字内理由>","confidence":0.9}',
    '{"action":"none","reason":"<15字内理由>","confidence":0.9}',
  ].join('\n');
  return { system: JSON_DISCIPLINE, user };
}
