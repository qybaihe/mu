import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { testProvider } from '../../../../packages/desktop/src/process/agent/kyrn/config/connection';
import { availableModels } from '../../../../packages/desktop/src/process/agent/kyrn/config/available';
import type { EndpointType, ProviderTestInput } from '../../../../packages/desktop/src/common/kyrn/models';

const KEY = 'sk-fixture-SECRET.key_1';
type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: unknown };
type Reply = { status: number; body?: unknown; raw?: string; headers?: Record<string, string>; hang?: boolean };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  vi.restoreAllMocks();
});

/** A local endpoint that answers by path and records what it was sent. Nothing leaves this machine. */
async function endpoint(routes: Record<string, Reply>): Promise<{ baseUrl: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => {
      seen.push({
        method: request.method!,
        url: request.url!,
        headers: request.headers,
        body: text ? JSON.parse(text) : undefined,
      });
      const reply = routes[`${request.method} ${request.url}`] ?? {
        status: 404,
        body: { error: { message: 'no such route' } },
      };
      if (reply.hang) return;
      response.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
      response.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const input = (api: EndpointType, baseUrl: string, patch: Partial<ProviderTestInput> = {}): ProviderTestInput => ({
  id: 'fixture',
  api,
  baseUrl,
  authHeader: false,
  model: 'model-1',
  apiKey: KEY,
  ...patch,
});

describe('testing a provider connection from the main process', () => {
  it('passes on what the model list states about each model, by id (#23)', async () => {
    const { baseUrl } = await endpoint({
      'GET /v1/models': {
        status: 200,
        body: {
          data: [
            { id: 'plain' },
            { id: 'wide', context_length: 1048576, architecture: { input_modalities: ['text', 'image'] } },
          ],
        },
      },
    });
    const result = await testProvider(input('openai-completions', `${baseUrl}/v1`), undefined);
    expect(result).toMatchObject({ ok: true, code: 'ok-models', models: ['plain', 'wide'] });
    expect(result.facts).toEqual({ wide: { contextWindow: 1048576, imageInput: true } });
  });
  it('lists models on an OpenAI-compatible endpoint with a bearer token', async () => {
    const { baseUrl, seen } = await endpoint({
      'GET /v1/models': { status: 200, body: { data: [{ id: 'a' }, { id: 'b' }] } },
    });
    for (const api of ['openai-completions', 'openai-responses'] as const) {
      // eslint-disable-next-line no-await-in-loop
      const result = await testProvider(input(api, `${baseUrl}/v1`), undefined);
      expect(result).toMatchObject({ ok: true, code: 'ok-models', status: 200, models: ['a', 'b'] });
    }
    expect(seen).toHaveLength(2);
    expect(seen[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0].headers['x-api-key']).toBeUndefined();
    expect(seen[0].url).not.toContain(KEY);
  });
  it('speaks Anthropic to an Anthropic endpoint: x-api-key and anthropic-version, under /v1', async () => {
    const { baseUrl, seen } = await endpoint({
      'GET /v1/models': { status: 200, body: { data: [{ id: 'claude-x' }] } },
    });
    const result = await testProvider(input('anthropic-messages', baseUrl), undefined);
    expect(result).toMatchObject({ ok: true, code: 'ok-models', models: ['claude-x'] });
    expect(seen[0].headers['x-api-key']).toBe(KEY);
    expect(seen[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(seen[0].headers.authorization).toBeUndefined();
    // A proxy that wants the bearer header as well gets both.
    await testProvider(input('anthropic-messages', baseUrl, { authHeader: true }), undefined);
    expect(seen[1].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[1].headers['x-api-key']).toBe(KEY);
  });
  it('sends the Google key as a header, never in the URL', async () => {
    const { baseUrl, seen } = await endpoint({
      'GET /v1beta/models': { status: 200, body: { models: [{ name: 'models/gemma-4' }] } },
    });
    const result = await testProvider(input('google-generative-ai', `${baseUrl}/v1beta`), undefined);
    expect(result).toMatchObject({ ok: true, models: ['gemma-4'] });
    expect(seen[0].headers['x-goog-api-key']).toBe(KEY);
    expect(seen[0].url).toBe('/v1beta/models');
  });
  it.each([
    [
      'openai-completions',
      '/v1',
      'POST /v1/chat/completions',
      { model: 'model-1', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
    ],
    ['openai-responses', '/v1', 'POST /v1/responses', { model: 'model-1', input: 'ping', max_output_tokens: 16 }],
    [
      'anthropic-messages',
      '',
      'POST /v1/messages',
      { model: 'model-1', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
    ],
  ] as const)(
    'falls back to a one-token request in the %s wire format when there is no model list',
    async (api, prefix, route, body) => {
      const { baseUrl, seen } = await endpoint({ [route]: { status: 200, body: { id: 'ok' } } });
      const result = await testProvider(input(api, `${baseUrl}${prefix}`), undefined);
      expect(result).toMatchObject({ ok: true, code: 'ok-completion', status: 200 });
      expect(seen.map((request) => `${request.method} ${request.url}`)).toEqual(['GET /v1/models', route]);
      expect(seen[1].body).toEqual(body);
      expect(seen[1].headers['content-type']).toBe('application/json');
    }
  );
  it('does not spend a token when no model is named: the missing list is then the answer', async () => {
    const { baseUrl, seen } = await endpoint({});
    const result = await testProvider(input('openai-completions', `${baseUrl}/v1`, { model: '' }), undefined);
    expect(result).toMatchObject({ ok: false, code: 'not-found', status: 404 });
    expect(seen).toHaveLength(1);
  });
  it('reports a rejected key as such, with the endpoint’s words but never the key', async () => {
    const log = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'info'),
    ];
    const { baseUrl } = await endpoint({
      'GET /v1/models': { status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}. Check it.` } } },
    });
    const result = await testProvider(input('openai-completions', `${baseUrl}/v1`), undefined);
    expect(result).toMatchObject({ ok: false, code: 'auth', status: 401 });
    expect(result.detail).toBe('Incorrect API key provided: ***. Check it.');
    expect(JSON.stringify(result)).not.toContain(KEY);
    for (const spy of log) expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY);
  });
  it('gives up after a short timeout', async () => {
    const { baseUrl } = await endpoint({ 'GET /v1/models': { status: 200, hang: true } });
    const result = await testProvider(input('openai-completions', `${baseUrl}/v1`), undefined, { timeoutMs: 150 });
    expect(result).toMatchObject({ ok: false, code: 'timeout' });
    expect(result.latencyMs).toBeLessThan(3000);
  });
  it('tells a refused connection, a redirect, a server error and a non-JSON answer apart', async () => {
    const { baseUrl } = await endpoint({
      'GET /redirect/models': { status: 302, headers: { location: 'http://127.0.0.1:1/elsewhere' } },
      'GET /broken/models': { status: 500, body: { error: 'upstream exploded' } },
      'GET /html/models': { status: 200, raw: '<html>login</html>' },
    });
    expect(await testProvider(input('openai-completions', 'http://127.0.0.1:1/v1'), undefined)).toMatchObject({
      code: 'network',
    });
    expect(await testProvider(input('openai-completions', `${baseUrl}/redirect`), undefined)).toMatchObject({
      code: 'redirect',
      status: 302,
    });
    expect(await testProvider(input('openai-completions', `${baseUrl}/broken`), undefined)).toMatchObject({
      code: 'http',
      status: 500,
      detail: 'upstream exploded',
    });
    expect(await testProvider(input('openai-completions', `${baseUrl}/html`, { model: '' }), undefined)).toMatchObject({
      ok: false,
      code: 'invalid-response',
    });
  });
  it('validates before it connects: endpoint rules, wire format and the shape of a typed key', async () => {
    const bad = (patch: Partial<ProviderTestInput>) =>
      testProvider(input('openai-completions', 'https://example.com/v1', patch), undefined);
    await expect(bad({ baseUrl: 'http://169.254.169.254/v1' })).rejects.toThrow('not link-local');
    await expect(bad({ baseUrl: 'https://user:pw@example.com/v1' })).rejects.toThrow('embedded credentials');
    await expect(bad({ api: 'soap' as EndpointType })).rejects.toThrow('Invalid endpoint type');
    await expect(bad({ apiKey: 'two words' })).rejects.toThrow('Invalid credential');
  });
  it('uses a saved key only against the address it was saved for', async () => {
    const { baseUrl, seen } = await endpoint({ 'GET /v1/models': { status: 200, body: { data: [] } } });
    const saved = { baseUrl: `${baseUrl}/v1`, api: 'openai-completions', key: KEY, unavailable: false };
    const ok = await testProvider(input('openai-completions', `${baseUrl}/v1`, { apiKey: undefined }), saved);
    expect(ok.ok).toBe(true);
    expect(seen[0].headers.authorization).toBe(`Bearer ${KEY}`);

    const moved = await testProvider(input('openai-completions', `${baseUrl}/other`, { apiKey: undefined }), saved);
    expect(moved).toMatchObject({ ok: false, code: 'url-changed' });
    const command = await testProvider(input('openai-completions', `${baseUrl}/v1`, { apiKey: undefined }), {
      ...saved,
      key: '',
      unavailable: true,
    });
    expect(command).toMatchObject({ ok: false, code: 'key-unavailable' });
    expect(seen).toHaveLength(1);

    // No key at all is fine: a local server does not ask for one.
    await testProvider(input('openai-completions', `${baseUrl}/v1`, { apiKey: undefined }), undefined);
    expect(seen[1].headers.authorization).toBeUndefined();
  });
});

const option = (value: string, name: string, description: string) => ({ value, name, description });

describe('models the running mu last reported', () => {
  const record = {
    id: 'k',
    config_options: JSON.stringify([
      {
        id: 'model',
        category: 'model',
        type: 'select',
        options: [
          option('openai-codex/gpt-5.6-sol', 'GPT-5.6 Sol', 'openai-codex'),
          option('openrouter/anthropic/claude-sonnet-5', 'Claude Sonnet 5', 'openrouter'),
          option('openai-codex/gpt-5.6-luna', '', 'openai-codex'),
          option('vercel-ai-gateway/openai/gpt-5', 'GPT-5', 'vercel-ai-gateway'),
          option('broken', 'no provider', ''),
        ],
      },
      { id: 'thinking', category: 'thought_level', type: 'select', options: [{ value: 'off' }, { value: 'high' }] },
    ]),
  };
  it('groups them by provider, keeping a model id that itself contains a slash, and leaves out the judge gateway', () => {
    expect(availableModels(record)).toEqual({
      providers: [
        {
          id: 'openai-codex',
          models: [
            { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
            { id: 'gpt-5.6-luna', name: 'gpt-5.6-luna' },
          ],
        },
        { id: 'openrouter', models: [{ id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5' }] },
      ],
      thinkingLevels: ['off', 'high'],
    });
  });
  it('reads the older snapshot shape, where the models stand on their own', () => {
    const available_models = { available_models: [{ id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' }] };
    expect(availableModels({ available_models: JSON.stringify(available_models) }).providers).toEqual([
      { id: 'anthropic', models: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }] },
    ]);
  });
  it('answers with nothing when no connection was recorded yet', () => {
    for (const row of [undefined, {}, { config_options: 'not json' }, { handshake: {} }])
      expect(availableModels(row)).toEqual({ providers: [], thinkingLevels: [] });
    expect(
      availableModels({ handshake: { config_options: JSON.parse(record.config_options) } }).providers
    ).toHaveLength(2);
  });
});
