/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildWebhookMessage,
  createSlidingWindowLimiter,
  formatWebhookPayload,
  resolveWebhookMode,
  routeWebhookRequest,
  webhookTimeLabel,
  webhookTokensMatch,
} from '@/common/chat/team/webhook/webhookCore';

const params = (entries: Record<string, string>): URLSearchParams => new URLSearchParams(entries);

describe('routeWebhookRequest', () => {
  it('accepts POST /hook/<id> and reads source and text', () => {
    const route = routeWebhookRequest('POST', '/hook/forwarder', params({ source: 'gh', text: 'hi' }));
    expect(route).toEqual({ kind: 'accepted', positionId: 'forwarder', source: 'gh', textParam: 'hi' });
  });

  it('decodes url-encoded ids', () => {
    const route = routeWebhookRequest('POST', '/hook/%E8%B4%A7%E4%BB%A3', params({}));
    expect(route.kind === 'accepted' && route.positionId).toBe('货代');
  });

  it('rejects other methods with 405 semantics', () => {
    expect(routeWebhookRequest('GET', '/hook/forwarder', params({})).kind).toBe('method-not-allowed');
  });

  it('rejects wrong paths, empty ids and slash-carrying ids as not-found', () => {
    expect(routeWebhookRequest('POST', '/hooks/forwarder', params({})).kind).toBe('not-found');
    expect(routeWebhookRequest('POST', '/hook/', params({})).kind).toBe('not-found');
    expect(routeWebhookRequest('POST', '/hook/a/b', params({})).kind).toBe('not-found');
  });

  it('caps the source label length', () => {
    const route = routeWebhookRequest('POST', '/hook/x', params({ source: 's'.repeat(200) }));
    expect(route.kind === 'accepted' && route.source.length).toBe(80);
  });
});

describe('webhookTokensMatch', () => {
  it('matches equal strings and rejects wrong or truncated ones', () => {
    expect(webhookTokensMatch('abc', 'abc')).toBe(true);
    expect(webhookTokensMatch('abc', 'abd')).toBe(false);
    expect(webhookTokensMatch('abc', 'abcd')).toBe(false);
  });
});

describe('createSlidingWindowLimiter', () => {
  it('allows up to max hits per window, then refuses until the window slides', () => {
    const limiter = createSlidingWindowLimiter(3, 1000);
    expect([0, 10, 20].map((t) => limiter.allow(t))).toEqual([true, true, true]);
    expect(limiter.allow(30)).toBe(false);
    expect(limiter.allow(1100)).toBe(true);
  });
});

describe('formatWebhookPayload', () => {
  it('passes the text parameter through verbatim when present', () => {
    expect(formatWebhookPayload('{"a":1}', 'application/json', 'plain shortcut')).toBe('plain shortcut');
  });

  it('pretty-prints JSON bodies', () => {
    expect(formatWebhookPayload('{"a":1}', 'application/json; charset=utf-8', undefined)).toBe('{\n  "a": 1\n}');
  });

  it('falls back to raw text for malformed JSON and non-JSON bodies', () => {
    expect(formatWebhookPayload('{"a":', 'application/json', undefined)).toBe('{"a":');
    expect(formatWebhookPayload('hello', 'text/plain', undefined)).toBe('hello');
  });
});

describe('resolveWebhookMode', () => {
  it("defaults to notify for anything but a stored 'auto'", () => {
    expect(resolveWebhookMode(undefined, 'x')).toBe('notify');
    expect(resolveWebhookMode({}, 'x')).toBe('notify');
    expect(resolveWebhookMode({ x: 'notify' }, 'x')).toBe('notify');
    expect(resolveWebhookMode({ x: 'auto' }, 'x')).toBe('auto');
    expect(resolveWebhookMode({ x: 'auto' }, 'y')).toBe('notify');
  });

  it('ignores non-object storage', () => {
    expect(resolveWebhookMode(['auto'], 'x')).toBe('notify');
  });
});

describe('buildWebhookMessage', () => {
  it('opens with the marker, source and local time, then the mode directive and payload', () => {
    const message = buildWebhookMessage({ source: 'gh', atMs: 0, mode: 'auto', payload: 'build ok' });
    const [first, second, divider, payload] = message.split('\n');
    expect(first.startsWith('[[MU_WEBHOOK]] source=gh 时间=')).toBe(true);
    expect(second).toContain('自动开工');
    expect(divider).toBe('--- payload ---');
    expect(payload).toBe('build ok');
  });

  it('omits the source segment when the source is empty', () => {
    const message = buildWebhookMessage({ source: '', atMs: 0, mode: 'notify', payload: 'x' });
    expect(message.split('\n')[0]).not.toContain('source=');
    expect(message.split('\n')[1]).toContain('仅通知');
  });

  it('formats the timestamp as local YYYY-MM-DD HH:mm:ss', () => {
    const label = webhookTimeLabel(new Date(2026, 10, 23, 14, 5, 9).getTime());
    expect(label).toBe('2026-11-23 14:05:09');
  });
});
