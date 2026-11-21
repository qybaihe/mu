/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The webhook trigger service: a loopback-only HTTP listener in the MAIN
 * process that turns one authenticated `POST /hook/<position id>` into one
 * `[[MU_WEBHOOK]]` message in that position's conversation — the third wake
 * channel beside the user typing and the cron schedules. Routing, caps and
 * message assembly are the pure core (common/chat/team/webhook/webhookCore);
 * this file owns the socket, the roster lookup, the conversation ensure and
 * the settings.
 *
 * Bound to 127.0.0.1 with an OS-assigned port (listen(0), the cdpBridge and
 * muBrowser precedent — the OS guarantees a free port, which is the whole
 * intent of the port-discipline rule) and a per-installation random token in
 * `x-mu-hook-token`. Reaching the internet from here is the user's own
 * tunnel (ngrok et al.), set up and secured outside the app; this listener
 * never binds a public interface itself.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { BackendHttpError, httpRequest } from '@/common/adapter/httpBridge';
import type { PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import { findPositionConversationId } from '@/common/chat/team/positions/positionLibraryCore';
import { webhookBridge, type WebhookStatus } from '@/common/chat/team/webhook/webhookBridge';
import {
  buildWebhookMessage,
  createSlidingWindowLimiter,
  formatWebhookPayload,
  MAX_BODY_BYTES,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  resolveWebhookMode,
  routeWebhookRequest,
  WEBHOOK_TOKEN_HEADER,
  webhookTokensMatch,
  type WebhookPositionMode,
} from '@/common/chat/team/webhook/webhookCore';
import { ensurePositionWorkspace, listPositions } from '../positions';

const HOST = '127.0.0.1';

/** A busy conversation's message waits this long between retries (the turn must end first). */
const BUSY_RETRY_STEP_MS = 5000;
/** A busy conversation's message gives up after this long — webhook events must not vanish silently sooner. */
const BUSY_RETRY_CAP_MS = 5 * 60 * 1000;

/**
 * Posts one message into a conversation, waiting out an in-flight turn: the
 * backend answers 409 (`conversation is already running`) while an agent turn
 * is active, and dropping a webhook event because the position was busy would
 * lose exactly the events the channel exists to carry. Retries every step
 * until the turn ends or the cap passes, then surfaces the failure.
 */
async function sendMessageWhenIdle(conversationId: string, content: string): Promise<void> {
  const deadline = Date.now() + BUSY_RETRY_CAP_MS;
  for (;;) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential retry is the point: the next attempt must see the turn's end
      await httpRequest('POST', `/api/conversations/${conversationId}/messages`, { content, files: [] });
      return;
    } catch (error) {
      if (!(error instanceof BackendHttpError) || error.status !== 409 || Date.now() >= deadline) throw error;
      // oxlint-disable-next-line no-await-in-loop -- the backoff sleep is the retry cadence
      await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_STEP_MS));
    }
  }
}

/** The settings keys this service owns, on the backend's client KV. */
const KEY_ENABLED = 'tools.webhookEnabled';
const KEY_TOKEN = 'tools.webhookToken';
const KEY_MODES = 'tools.webhookPositionModes';

/** The conversations list's row, sliced to what the ensure needs. */
type ConversationRow = { id: string; name?: string; extra?: Record<string, unknown> };

/** What one delivered hook answered the caller with. */
export type WebhookDeliveryResult = {
  ok: boolean;
  /** HTTP status the listener replied with. */
  status: number;
  conversationId?: string;
  mode?: WebhookPositionMode;
  error?: string;
};

/** Everything the service needs from the outside; the seams its tests fake. */
export type WebhookDeps = {
  now: () => number;
  listPositions: () => Promise<PositionInfo[]>;
  ensureWorkspace: (name: string) => Promise<string | undefined>;
  listConversations: () => Promise<ConversationRow[]>;
  /** Creates the position's first conversation; resolves its id, undefined on failure. */
  createConversation: (position: PositionInfo) => Promise<string | undefined>;
  sendMessage: (conversationId: string, content: string) => Promise<void>;
  readMode: (positionId: string) => Promise<WebhookPositionMode>;
  log: (...args: unknown[]) => void;
};

/**
 * Delivers one routed, authorized hook: find the position's conversation (its
 * `extra.position` marker), ensure it on first contact, then post the message.
 * The message carries the mode directive, so toggling a mode in settings
 * changes the next hook's behaviour without touching any workspace file.
 */
export async function deliverWebhook(
  deps: WebhookDeps,
  positionId: string,
  source: string,
  textParam: string | undefined,
  rawBody: string,
  contentType: string
): Promise<WebhookDeliveryResult> {
  const positions = await deps.listPositions();
  const position = positions.find((candidate) => candidate.name === positionId);
  if (!position) return { ok: false, status: 404, error: 'unknown position' };

  let conversationId: string | undefined;
  try {
    const conversations = await deps.listConversations();
    conversationId = findPositionConversationId(conversations, positionId) ?? undefined;
    if (!conversationId) {
      const workspace = await deps.ensureWorkspace(position.name);
      if (!workspace) return { ok: false, status: 502, error: 'workspace prepare failed' };
      conversationId = await deps.createConversation(position);
    }
    if (!conversationId) return { ok: false, status: 502, error: 'conversation ensure failed' };

    const mode = await deps.readMode(positionId);
    const payload = formatWebhookPayload(rawBody, contentType, textParam);
    const message = buildWebhookMessage({ source, atMs: deps.now(), mode, payload });
    await deps.sendMessage(conversationId, message);
    return { ok: true, status: 200, conversationId, mode };
  } catch (error) {
    deps.log('[webhook] delivery failed for', positionId, error);
    return { ok: false, status: 502, error: 'delivery failed' };
  }
}

/** The listener plus its state; `close` stops the socket. */
type WebhookListener = {
  port: number;
  close(): Promise<void>;
};

/** Everything the request handler consults per request. */
export type WebhookRequestScope = {
  deps: WebhookDeps;
  token: string;
  limiter: ReturnType<typeof createSlidingWindowLimiter>;
};

/**
 * Handles one request end-to-end for the listener: route → caps → auth →
 * rate limit → deliver. Order is deliberate: 404/405 before 401 so an
 * unauthenticated probe learns nothing about which ids exist; the rate
 * window guards the whole listener, not per position — a hook storm from
 * one source must not wake every position.
 */
export async function handleWebhookRequest(
  scope: WebhookRequestScope,
  req: IncomingMessage,
  body: string
): Promise<WebhookDeliveryResult> {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  const route = routeWebhookRequest(req.method ?? '', url.pathname, url.searchParams);
  if (route.kind === 'method-not-allowed') return { ok: false, status: 405, error: 'POST only' };
  if (route.kind === 'not-found') return { ok: false, status: 404, error: 'not found' };

  if (!webhookTokensMatch(scope.token, String(req.headers[WEBHOOK_TOKEN_HEADER] ?? ''))) {
    return { ok: false, status: 401, error: 'bad token' };
  }
  if (!scope.limiter.allow(scope.deps.now())) return { ok: false, status: 429, error: 'rate limited' };

  return deliverWebhook(
    scope.deps,
    route.positionId,
    route.source,
    route.textParam,
    body,
    String(req.headers['content-type'] ?? '')
  );
}

/**
 * Starts the loopback listener: OS-assigned port, one shared rate window.
 * The socket-level body cap (below) is the real 413 gate — a lying
 * Content-Length never gets its bytes read.
 */
export async function startWebhookListener(scope: WebhookRequestScope): Promise<WebhookListener> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, payload: Record<string, unknown>) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    // Refuse oversized bodies before buffering: both a lying Content-Length
    // and an actual chunk overage destroy the connection (no partial parse).
    const declared = Number(req.headers['content-length'] ?? '0');
    if (declared > MAX_BODY_BYTES) {
      reply(413, { ok: false, error: 'body too large' });
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        tooLarge = true;
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return; // already destroyed; nothing to answer
      const body = Buffer.concat(chunks).toString('utf8');
      handleWebhookRequest(scope, req, body)
        .then((result) =>
          reply(
            result.status,
            result.ok
              ? { ok: true, conversation_id: result.conversationId, mode: result.mode }
              : { ok: false, error: result.error }
          )
        )
        .catch(() => reply(502, { ok: false, error: 'internal error' }));
    });
    req.on('error', () => undefined);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    // listen(0): the OS picks a free port (the cdpBridge precedent) — no
    // fixed port to collide with anything, and no netstat dance needed.
    server.listen(0, HOST, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('Could not determine webhook port'));
    });
  });

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// Settings-backed lifecycle: the bridge providers and the boot path
// ---------------------------------------------------------------------------

const productionDeps = (): WebhookDeps => ({
  now: Date.now,
  listPositions,
  ensureWorkspace: async (name) => {
    try {
      const { workspace } = await ensurePositionWorkspace(name);
      return workspace;
    } catch {
      return undefined;
    }
  },
  listConversations: async () => {
    const data = await httpRequest<{ items?: ConversationRow[] }>('GET', '/api/conversations?limit=200');
    return data?.items ?? [];
  },
  createConversation: (position) => createPositionConversation(position),
  sendMessage: async (conversationId, content) => {
    await sendMessageWhenIdle(conversationId, content);
  },
  readMode: async (positionId) => {
    const data = await httpRequest<Record<string, unknown>>(
      'GET',
      `/api/settings/client?keys=${encodeURIComponent(KEY_MODES)}`
    );
    return resolveWebhookMode(data?.[KEY_MODES], positionId);
  },
  log: (...args) => console.log('[webhook]', ...args),
});

/**
 * Creates a position's first conversation on the default assistant — the
 * openPosition flow's parameters, minus the window: the first enabled
 * assistant and its resolved default model carry the conversation.
 */
async function createPositionConversation(position: PositionInfo): Promise<string | undefined> {
  const assistants = await httpRequest<Array<Record<string, unknown>>>('GET', '/api/assistants').catch((): Array<Record<string, unknown>> => []);
  const enabled = (assistants ?? []).find((assistant): boolean => assistant.enabled !== false);
  const assistantId = typeof enabled?.id === 'string' ? enabled.id : undefined;
  if (!assistantId) return undefined;

  let modelId: string | undefined;
  try {
    const detail = await httpRequest<Record<string, unknown>>('GET', `/api/assistants/${assistantId}`);
    const defaults = (detail?.defaults ?? {}) as Record<string, unknown>;
    const model = (defaults.model ?? {}) as Record<string, unknown>;
    const preferences = (detail?.preferences ?? {}) as Record<string, unknown>;
    if (model.mode === 'fixed' && typeof model.value === 'string') modelId = model.value;
    else if (model.mode === 'auto' && typeof preferences.last_model_id === 'string')
      modelId = preferences.last_model_id;
  } catch {
    // A model-less conversation still starts; the backend asks at first run.
  }

  const workspace = await ensurePositionWorkspace(position.name).then(
    (answer): string | undefined => answer.workspace,
    (): undefined => undefined
  );
  if (!workspace) return undefined;

  const body = {
    name: position.displayName,
    assistant: { id: assistantId, ...(modelId ? { conversation_overrides: { model: modelId } } : {}) },
    extra: { workspace, custom_workspace: true, position: position.name },
  };
  const created = await httpRequest<Record<string, unknown>>('POST', '/api/conversations', body);
  return typeof created?.id === 'string' && created.id ? created.id : undefined;
}

/** The running listener, when the switch is on. */
let active: WebhookListener | null = null;
let activeToken = '';

/** Reads the persisted token, generating and storing one when absent. */
async function ensureToken(): Promise<string> {
  const read = await httpRequest<Record<string, string | undefined>>(
    'GET',
    `/api/settings/client?keys=${encodeURIComponent(KEY_TOKEN)}`
  );
  const existing = read?.[KEY_TOKEN];
  if (typeof existing === 'string' && /^[a-f0-9]{48,64}$/.test(existing)) return existing;
  const token = randomBytes(24).toString('hex');
  await httpRequest('PUT', '/api/settings/client', { [KEY_TOKEN]: token }).catch((): undefined => undefined);
  return token;
}

async function currentStatus(): Promise<WebhookStatus> {
  const read = await httpRequest<Record<string, boolean | undefined>>(
    'GET',
    `/api/settings/client?keys=${encodeURIComponent(KEY_ENABLED)}`
  );
  const enabled = read?.[KEY_ENABLED] === true;
  return {
    enabled,
    listening: active !== null,
    port: active?.port ?? null,
    token: activeToken,
    urlTemplate: active ? `http://${HOST}:${active.port}/hook/<岗位id>` : null,
  };
}

/** Stops the listener if one is up. */
export async function stopWebhookListener(): Promise<void> {
  const listener = active;
  active = null;
  activeToken = '';
  if (listener) await listener.close();
}

/** Starts the listener when the persisted switch is on; the boot path. */
export async function syncWebhookWithSettings(): Promise<WebhookStatus> {
  const read = await httpRequest<Record<string, boolean | undefined>>(
    'GET',
    `/api/settings/client?keys=${encodeURIComponent(KEY_ENABLED)}`
  );
  const enabled = read?.[KEY_ENABLED] === true;
  if (!enabled) {
    await stopWebhookListener();
    return currentStatus();
  }
  if (active) return currentStatus();
  const token = await ensureToken();
  const listener = await startWebhookListener({
    deps: productionDeps(),
    token,
    limiter: createSlidingWindowLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS),
  });
  active = listener;
  activeToken = token;
  return currentStatus();
}

/** The bridge entry: the settings section's two providers. The boot sync hangs off
 *  `markBackendReady` (index.ts) — bridges initialize before the backend starts,
 *  so a settings read here would only ever fail. */
export function initWebhookBridge(): void {
  webhookBridge.status.provider(() => currentStatus());
  webhookBridge.setEnabled.provider(async ({ enabled }) => {
    await httpRequest('PUT', '/api/settings/client', { [KEY_ENABLED]: enabled });
    return syncWebhookWithSettings();
  });
}
