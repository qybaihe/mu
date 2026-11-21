/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createSlidingWindowLimiter } from '@/common/chat/team/webhook/webhookCore';
import type { PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import { deliverWebhook, handleWebhookRequest, type WebhookDeps } from '@/process/services/team/webhook/webhookService';

const position = (name: string): PositionInfo => ({
  name,
  displayName: name,
  description: `${name} 的岗位描述`,
  body: '说明书正文',
  antiJob: undefined,
});

/** The delivery seam's fake: a roster of two positions, one existing conversation for forwarder. */
const makeDeps = (overrides: Partial<WebhookDeps> = {}): WebhookDeps => {
  const sent: Array<{ conversationId: string; content: string }> = [];
  const created: string[] = [];
  const deps: WebhookDeps = {
    now: () => 1_000,
    listPositions: async () => [position('forwarder'), position('video-lab')],
    ensureWorkspace: async (name) => `C:/ws/${name}`,
    listConversations: async () => [{ id: 'conv-forwarder', extra: { position: 'forwarder' } }],
    createConversation: async (p) => {
      created.push(p.name);
      return `conv-${p.name}`;
    },
    sendMessage: async (conversationId, content) => {
      sent.push({ conversationId, content });
    },
    readMode: async () => 'notify',
    log: () => undefined,
    ...overrides,
  };
  return Object.assign(deps, {
    // Test-only readers riding the fake.
    __sent: sent,
    __created: created,
  } as unknown as WebhookDeps);
};

type FakeDeps = WebhookDeps & { __sent: Array<{ conversationId: string; content: string }>; __created: string[] };

const fakeReq = (
  headers: Record<string, string>,
  url: string
): { headers: Record<string, string>; url: string; method: string } => ({
  headers,
  url,
  method: 'POST',
});

describe('deliverWebhook', () => {
  it('delivers into the existing position conversation with the stored mode', async () => {
    const deps = makeDeps({ readMode: async () => 'auto' }) as FakeDeps;
    const result = await deliverWebhook(deps, 'forwarder', 'gh', undefined, '{"build":"ok"}', 'application/json');
    expect(result).toMatchObject({ ok: true, status: 200, conversationId: 'conv-forwarder', mode: 'auto' });
    expect(deps.__sent).toHaveLength(1);
    expect(deps.__sent[0].content.startsWith('[[MU_WEBHOOK]] source=gh 时间=')).toBe(true);
    expect(deps.__sent[0].content).toContain('"build": "ok"');
  });

  it('ensures a first conversation when the position has none', async () => {
    const deps = makeDeps() as FakeDeps;
    const result = await deliverWebhook(deps, 'video-lab', '', 'text shortcut', 'ignored', 'text/plain');
    expect(result).toMatchObject({ ok: true, status: 200, conversationId: 'conv-video-lab' });
    expect(deps.__created).toEqual(['video-lab']);
    expect(deps.__sent[0].content).toContain('text shortcut');
  });

  it('404s an unknown position without creating or sending anything', async () => {
    const deps = makeDeps() as FakeDeps;
    const result = await deliverWebhook(deps, 'ghost', '', undefined, 'x', 'text/plain');
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(deps.__sent).toHaveLength(0);
    expect(deps.__created).toHaveLength(0);
  });

  it('502s when the conversation ensure fails (no default assistant)', async () => {
    const deps = makeDeps({ createConversation: async () => undefined }) as FakeDeps;
    const result = await deliverWebhook(deps, 'video-lab', '', undefined, 'x', 'text/plain');
    expect(result).toMatchObject({ ok: false, status: 502 });
  });

  it('502s when the send throws, without leaking the error to the caller', async () => {
    const deps = makeDeps({
      sendMessage: async () => {
        throw new Error('backend down');
      },
    }) as FakeDeps;
    const result = await deliverWebhook(deps, 'forwarder', '', undefined, 'x', 'text/plain');
    expect(result).toMatchObject({ ok: false, status: 502, error: 'delivery failed' });
  });
});

describe('handleWebhookRequest', () => {
  const TOKEN = 't'.repeat(48);
  const scope = (deps: WebhookDeps, token = TOKEN, max = 10) => ({
    deps,
    token,
    limiter: createSlidingWindowLimiter(max, 1000),
  });

  it('401s a wrong token before touching the roster', async () => {
    const deps = makeDeps() as FakeDeps;
    const result = await handleWebhookRequest(
      scope(deps),
      fakeReq({ 'x-mu-hook-token': 'wrong' }, '/hook/forwarder'),
      '{}'
    );
    expect(result.status).toBe(401);
    expect(deps.__sent).toHaveLength(0);
  });

  it('404s an unknown path before auth, so probes learn nothing', async () => {
    const result = await handleWebhookRequest(scope(makeDeps()), fakeReq({}, '/nope'), '{}');
    expect(result.status).toBe(404);
  });

  it('405s a GET even with a good token', async () => {
    const req = { ...fakeReq({ 'x-mu-hook-token': TOKEN }, '/hook/forwarder'), method: 'GET' };
    const result = await handleWebhookRequest(scope(makeDeps()), req, '');
    expect(result.status).toBe(405);
  });

  it('429s once the window is exhausted', async () => {
    const deps = makeDeps();
    const theScope = { deps, token: TOKEN, limiter: createSlidingWindowLimiter(2, 1000) };
    const req = () => fakeReq({ 'x-mu-hook-token': TOKEN }, '/hook/forwarder');
    expect((await handleWebhookRequest(theScope, req(), 'x')).status).toBe(200);
    expect((await handleWebhookRequest(theScope, req(), 'x')).status).toBe(200);
    expect((await handleWebhookRequest(theScope, req(), 'x')).status).toBe(429);
  });

  it('routes the ?text= shortcut into the payload', async () => {
    const deps = makeDeps() as FakeDeps;
    const result = await handleWebhookRequest(
      scope(deps),
      fakeReq({ 'x-mu-hook-token': TOKEN }, '/hook/forwarder?text=deploy%20done'),
      '{"ignored":true}'
    );
    expect(result.status).toBe(200);
    expect(deps.__sent[0].content).toContain('deploy done');
    expect(deps.__sent[0].content).not.toContain('"ignored"');
  });
});
