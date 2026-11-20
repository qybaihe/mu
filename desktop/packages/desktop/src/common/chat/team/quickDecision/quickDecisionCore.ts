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

/** The two decision kinds, one per short-circuit point. */
export type QuickDecisionKind = 'supervisor-reuse' | 'position-domain';

/** Point A's answer: reuse one active team, or hand the task to the full supervisor flow. */
export type SupervisorReuseDecision =
  | { action: 'reuse'; teamId: string; reason: string; confidence: number }
  | { action: 'full'; reason: string };

/** Point B's answer: reject as clearly off-domain and point at a roster position, or run the position's full flow. */
export type PositionDomainDecision =
  | { action: 'reject'; suggest: string; reason: string; confidence: number }
  | { action: 'full'; reason: string };

/** Either kind's decisive verdict — the only answers worth caching. */
export type QuickDecisionVerdict = SupervisorReuseDecision | PositionDomainDecision;

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
