/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The webhook trigger, pure: routing and guarding one HTTP POST before the
 * service delivers anything, the payload formatting, and the `[[MU_WEBHOOK]]`
 * message the service injects into a position conversation. The wire marker
 * follows the `[[MU_*]]` receipt family (`[[MU_INSPECTION]]`, the steward's
 * compact marker): a message the app wrote itself, not the user typing.
 *
 * The HTTP half is deliberately small — a loopback-only listener the main
 * process owns (see process/services/team/webhook/); exposing it beyond the
 * machine is the user's own tunnel, never ours.
 */

/** The marker every webhook message opens with; the position gate keys on it. */
export const WEBHOOK_MARKER = '[[MU_WEBHOOK]]';

/** The only URL shape the listener answers: `POST /hook/<position id>`. */
export const HOOK_PATH_PREFIX = '/hook/';

/** The header carrying the per-installation token. */
export const WEBHOOK_TOKEN_HEADER = 'x-mu-hook-token';

/** Bodies above this are refused (413) before any parsing. */
export const MAX_BODY_BYTES = 64 * 1024;

/** The listener's whole-body budget per one-second sliding window. */
export const RATE_LIMIT_MAX = 10;
export const RATE_LIMIT_WINDOW_MS = 1000;

/** What a webhook asks the position to do; the default is the conservative one. */
export type WebhookPositionMode = 'auto' | 'notify';

export const DEFAULT_WEBHOOK_MODE: WebhookPositionMode = 'notify';

/** The `source` query parameter's cap — it rides into the message's first line. */
const MAX_SOURCE_CHARS = 80;

/** A position id worth looking up in the roster: non-empty, no slashes, bounded. */
const POSITION_ID_RE = /^[^/\s]{1,100}$/;

/**
 * Constant-time compare so token prefixes do not leak through early-exit
 * string comparison. Same construction as the CDP bridge's `tokensMatch`
 * (process/resources/builtinMcp/cdpTargetProtocol.ts); duplicated because
 * common code cannot import from the process tree.
 */
export const webhookTokensMatch = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};

/** What the router decided about one request; the service maps each kind to a status. */
export type WebhookRoute =
  | { kind: 'accepted'; positionId: string; source: string; textParam: string | undefined }
  | { kind: 'method-not-allowed' }
  | { kind: 'not-found' };

/**
 * Routes one incoming request without touching the roster or settings:
 * `POST /hook/<position id>` with an optional `source` label and an optional
 * `text` shortcut parameter; anything else is 404/405 before auth, so an
 * unauthenticated probe learns nothing about which ids exist.
 */
export function routeWebhookRequest(method: string, pathname: string, searchParams: URLSearchParams): WebhookRoute {
  if (method !== 'POST') return { kind: 'method-not-allowed' };
  if (!pathname.startsWith(HOOK_PATH_PREFIX)) return { kind: 'not-found' };
  const rawId = decodeURIComponent(pathname.slice(HOOK_PATH_PREFIX.length));
  if (!POSITION_ID_RE.test(rawId)) return { kind: 'not-found' };
  const source = (searchParams.get('source') ?? '').slice(0, MAX_SOURCE_CHARS).trim();
  const textParam = searchParams.get('text') ?? undefined;
  return { kind: 'accepted', positionId: rawId, source, textParam };
}

/**
 * Formats the payload block of the message: the `text` parameter verbatim
 * when the caller used the shortcut; JSON bodies pretty-printed so a model
 * reads structure instead of one escaped line; anything else passed through
 * as plain text. All paths are length-capped by the body limit upstream.
 */
export function formatWebhookPayload(rawBody: string, contentType: string, textParam: string | undefined): string {
  if (textParam !== undefined && textParam.length > 0) return textParam;
  if (contentType.includes('application/json')) {
    try {
      return JSON.stringify(JSON.parse(rawBody) as unknown, null, 2);
    } catch {
      // Malformed JSON falls through as plain text — still a usable payload.
    }
  }
  return rawBody;
}

/** A one-second sliding-window limiter over caller-supplied timestamps; no timers. */
export type SlidingWindowLimiter = { allow(nowMs: number): boolean };

export function createSlidingWindowLimiter(max: number, windowMs: number): SlidingWindowLimiter {
  const hits: number[] = [];
  return {
    allow(nowMs: number): boolean {
      while (hits.length > 0 && nowMs - hits[0] >= windowMs) hits.shift();
      if (hits.length >= max) return false;
      hits.push(nowMs);
      return true;
    },
  };
}

/** The stored per-position mode map's value, or the conservative default. */
export function resolveWebhookMode(stored: unknown, positionId: string): WebhookPositionMode {
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    const value = (stored as Record<string, unknown>)[positionId];
    if (value === 'auto' || value === 'notify') return value;
  }
  return DEFAULT_WEBHOOK_MODE;
}

/** The local timestamp line format: `2026-11-23 14:05:09`. */
const pad2 = (n: number): string => String(n).padStart(2, '0');

export const webhookTimeLabel = (atMs: number): string => {
  const d = new Date(atMs);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

/** The directive each mode writes into the message; the gate's section explains the contract. */
const MODE_DIRECTIVE: Record<WebhookPositionMode, string> = {
  auto: '处理模式：自动开工——本条为外部事件通知（Webhook）。立即按守则「Webhook 触发」处理：先过任务归属判定与禁忌（anti_job）闸，属于本岗即直接开工执行并在完成时给一句话回执；不属于本岗或触禁忌，按归属守则一句话回复，不开工。',
  notify:
    '处理模式：仅通知——本条为外部事件通知（Webhook），本模式优先于本岗说明书中任何「开工前验证/素材核查」惯例。只依据 payload 文本本身评估，不调用任何工具、不读写文件、不跑命令、不落账、不产出任何中间件；回复仅一行：「事件已到，建议动作 X，等你确认」。用户确认之前绝不开始实际工作。',
};

/** Everything the message line needs; the service fills it from settings at delivery time. */
export type WebhookMessageInput = {
  source: string;
  atMs: number;
  mode: WebhookPositionMode;
  payload: string;
};

/**
 * The message injected into the position conversation: the wire marker plus
 * `source` and time on the first line (parseable at a glance), the mode
 * directive (so toggling a position's mode needs no workspace rewrite), then
 * the payload under a divider.
 */
export function buildWebhookMessage(input: WebhookMessageInput): string {
  const label = input.source ? `source=${input.source} ` : '';
  return [
    `${WEBHOOK_MARKER} ${label}时间=${webhookTimeLabel(input.atMs)}`,
    MODE_DIRECTIVE[input.mode],
    '--- payload ---',
    input.payload,
  ].join('\n');
}
