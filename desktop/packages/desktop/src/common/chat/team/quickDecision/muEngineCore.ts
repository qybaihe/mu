/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The MU decision engine, pure: the L1 judge's wire format and its gate.
 * L1 is the System One choice protocol over treg (`typesafe/jev-1.13`): each
 * quick decision becomes ONE choice question whose criteria ARE the verdict
 * space (`reuse:<teamId>` / `reject:<position>` / `full`), and the gate reads
 * `probabilities[choice]` — NOT the `confidence` field, which the 2026-11-21
 * four-way comparison proved miscalibrated against the option probability
 * (scenario a2: choice right, confidence 0.57, probability 0.84). State
 * leaves the machine sanitized to decision-rsi-kernel's privacy-gate
 * standard: emails, domains, company names and drive paths become
 * placeholders and every string is capped at 200 characters. The tiers
 * above and below (L2 glm, L3 the ordinary full flow) live in the service
 * and muDecisionEngine; this module never talks to the network.
 */
import { positionLabel, type PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import type { SupervisorTeam } from '@/common/chat/team/supervisor/supervisorCore';
import type { QuickDecisionKind } from '@/common/chat/team/quickDecision/quickDecisionCore';

/** A probability at or above this acts: the L1 short-circuit fires on the choice as answered. */
export const MU_ENGINE_ACT_PROBABILITY = 0.85;

/** Below this L1 does not even escalate — the answer is too uncertain to be worth an L2 call, so `full`. */
export const MU_ENGINE_ESCALATE_PROBABILITY = 0.5;

/** The display label of the engine as a whole (cached replays and logs name it when no tier model ran). */
export const MU_ENGINE_LABEL = 'MU 决策引擎';

/** The L1 model as the ⚡ receipt names it. */
export const JEV_MODEL_LABEL = 'jev-1.13';

/** The redaction set of decision-rsi-kernel's privacy gate: email → domain/URL → company suffix → Windows drive path. */
const REDACT: Array<[RegExp, string]> = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]'],
  [/\b(?:https?:\/\/)?(?:[a-z0-9-]{2,}\.)+[a-z]{2,6}(?:\/[^\s"'，。）)]*)?/gi, '[DOMAIN]'],
  [
    /[\u4e00-\u9fa5A-Za-z0-9 ]{2,40}(?:有限公司|股份有限公司|有限责任公司|Inc\.?|Corp\.?|Co\.,?\s?Ltd\.?|LLC|GmbH|S\.?A\.?)/g,
    '[COMPANY]',
  ],
  [/\b[A-Za-z]:\\[^\s"'，。、）)]+/g, '[PATH]'],
];

/** One sanitized string: every redaction class applied, then the kernel's per-field 200-character cap. */
const sanitizeString = (value: string): string => {
  for (const [re, tag] of REDACT) value = value.replace(re, tag);
  return value.slice(0, 200);
};

/** The state as it may leave the machine: sanitized recursively, strings capped — nothing else is changed. */
export function sanitizeEngineState(state: Record<string, unknown>): Record<string, unknown> {
  const walk = (value: unknown): unknown =>
    typeof value === 'string'
      ? sanitizeString(value)
      : Array.isArray(value)
        ? value.map(walk)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]))
          : value;
  return Object.fromEntries(Object.entries(state).map(([k, v]) => [k, walk(v)]));
}

/** One System One choice question; the criteria keys are exactly the answers the gate accepts. */
export type MuEngineChoiceQuestion = {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
};

/** The wire payload of one L1 ask: sanitized state plus the single choice question. */
export type MuEngineAskPayload = {
  state: Record<string, unknown>;
  questions: { q: MuEngineChoiceQuestion };
};

/** One roster line, the same shape the L2 prompt uses, so both tiers judge the same context. */
const rosterLine = (position: PositionInfo): string => `${positionLabel(position)} — ${position.description}`;

/** Point A as a choice question: reuse one active team, or `full` for the supervisor flow. */
export function buildSupervisorReuseAsk(options: {
  task: string;
  teams: readonly SupervisorTeam[];
  roster: readonly PositionInfo[];
}): MuEngineAskPayload {
  const labelOf = (positionId: string): string => {
    const found = options.roster.find((position) => position.name === positionId);
    return found ? positionLabel(found) : positionId;
  };
  const teamLines = options.teams.map(
    (team) => `${team.teamId}「${team.name}」：${team.positions.map(labelOf).join('、')}`
  );
  const criteria = Object.fromEntries([
    ...options.teams.map((team) => [
      `reuse:${team.teamId}`,
      `任务是单一明确的请求，且明显属于「${team.name}」（${team.positions.map(labelOf).join('、')}）的职责域：与上述岗位的职责描述一致`,
    ]),
    ['full', '不属于任何现役团队、一句话里含多个不同职责域的复合任务、需新建团队或追问澄清、非派发类请求（闲聊、查状态）、或拿不准'],
  ]);
  return {
    state: {
      mode: 'supervisor-reuse',
      task: options.task,
      activeTeams: teamLines,
      roster: options.roster.map(rosterLine),
    },
    questions: {
      q: {
        type: 'choice',
        instructions:
          '主管收到 task：能否直接复用某个现役团队（不经完整主管流程）？只有当 task 是单一明确的请求、且某队岗位组合的职责域完全覆盖它时才选该队；一句话里含多个不同职责域的复合任务、需要新建团队/追问澄清/非派发类请求（闲聊、查状态）/任何不确定 → 选 full。宁可 full 不可错派。',
        criteria,
      },
    },
  };
}

/** Point B as a choice question: reject to a roster position, or `full` for the position's own flow. */
export function buildPositionDomainAsk(options: {
  task: string;
  position: Pick<PositionInfo, 'name' | 'displayName' | 'description' | 'body'>;
  roster: readonly PositionInfo[];
}): MuEngineAskPayload {
  const own = positionLabel(options.position);
  const criteria = Object.fromEntries([
    ...options.roster
      .filter((candidate) => candidate.name !== options.position.name)
      .map((candidate) => [
        `reject:${candidate.name}`,
        `任务明显是${positionLabel(candidate)}的职责：${candidate.description}`,
      ]),
    ['full', '任务属于本岗、或与本岗有交集、或拿不准、或需追问、或名册中无更匹配岗位'],
  ]);
  return {
    state: {
      mode: 'position-domain',
      task: options.task,
      ownPosition: `${own} — ${options.position.description || '（无职责描述）'}`,
      ownManual: options.position.body ?? '',
      roster: options.roster.map(rosterLine),
    },
    questions: {
      q: {
        type: 'choice',
        instructions: `本岗是${own}。task 是否明显属于名册中另一个岗位的职责域（本岗应拒收并转交）？只有当 task 是单一明确请求、且名册中另一岗位明显更匹配时才选该岗位；任务属于本岗、或与本岗职责有交集（一句话里既有本岗职责又有其他岗职责的复合任务）、拿不准、或需追问 → 选 full。宁可 full 不可误拒。`,
        criteria,
      },
    },
  };
}

/** The criteria keys of a payload — the only choices the gate may act on. */
export const choicesOfAsk = (payload: MuEngineAskPayload): string[] => Object.keys(payload.questions.q.criteria);

/** L1's answer as the gate reads it: the chosen option and ITS probability. */
export type JevChoiceVerdict = { choice: string; probability: number };

/**
 * One answer off the wire — untrusted input, so everything is checked: an
 * object of type `choice`, a string choice among the criteria we sent, and a
 * finite `probabilities[choice]`. The `confidence` field is deliberately
 * never read (see the module doc); an answer without usable probabilities is
 * NO answer — the caller escalates to L2 rather than guessing.
 */
export function parseJevChoice(answer: unknown, validChoices: readonly string[]): JevChoiceVerdict | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined;
  const record = answer as Record<string, unknown>;
  if (record.type !== 'choice' || typeof record.choice !== 'string') return undefined;
  if (!validChoices.includes(record.choice)) return undefined;
  const probabilities = record.probabilities;
  if (typeof probabilities !== 'object' || probabilities === null) return undefined;
  const probability = (probabilities as Record<string, unknown>)[record.choice];
  if (typeof probability !== 'number' || !Number.isFinite(probability)) return undefined;
  return { choice: record.choice, probability };
}

/** What the gate does with a probability: act on it, escalate to L2, or answer `full` outright. */
export type JevGate = 'act' | 'escalate' | 'full';

export const jevGate = (probability: number): JevGate =>
  probability >= MU_ENGINE_ACT_PROBABILITY
    ? 'act'
    : probability >= MU_ENGINE_ESCALATE_PROBABILITY
      ? 'escalate'
      : 'full';

/**
 * An acted-on choice as the decision JSON the service's strict parsers
 * already understand — L1's verdict funnels through the same parse, roster
 * and team validation as every other verdict, so no second trust path
 * exists. `confidence` carries the acting probability (the parser's 0.8 bar
 * is below the 0.85 gate, so an acted verdict always clears it). Returns
 * undefined for a choice that does not name a verdict of this kind.
 */
export function jevChoiceToDecisionJson(
  kind: QuickDecisionKind,
  choice: string,
  probability: number
): string | undefined {
  const reason = `jev 概率 ${probability.toFixed(2)}`;
  if (choice === 'full') return JSON.stringify({ action: 'full', reason, confidence: probability });
  if (kind === 'supervisor-reuse' && choice.startsWith('reuse:')) {
    return JSON.stringify({ action: 'reuse', teamId: choice.slice('reuse:'.length), reason, confidence: probability });
  }
  if (kind === 'position-domain' && choice.startsWith('reject:')) {
    return JSON.stringify({
      action: 'reject',
      suggest: choice.slice('reject:'.length),
      reason,
      confidence: probability,
    });
  }
  return undefined;
}
