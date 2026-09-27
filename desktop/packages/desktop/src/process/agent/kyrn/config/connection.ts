import {
  ENDPOINT_TYPES,
  type EndpointType,
  type ProviderTestCode,
  type ProviderTestInput,
  type ProviderTestResult,
} from '../../../../common/kyrn/models';
import { KyrnError } from '../../../../common/kyrn/errors';
import { asRecord, text } from '../piRpc';
import { assertEndpoint } from './models';

/** The saved key of a provider and where it may be sent: `SettingsStore.storedKey`. */
export type StoredKey = { baseUrl: string; api: string; key: string; unavailable: boolean } | undefined;

const SECRET = /^[A-Za-z0-9_./+=:@-]{1,4096}$/;
const ANTHROPIC_VERSION = '2023-06-01';

type Attempt = { method: 'GET' | 'POST'; url: string; body?: unknown; kind: 'models' | 'completion' };

const join = (baseUrl: string, path: string): string => `${baseUrl.replace(/\/+$/, '')}${path}`;

/** The header each wire format authenticates with. The key never goes into a URL. */
export function authHeaders(api: EndpointType, key: string, authHeader: boolean): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (api === 'anthropic-messages') headers['anthropic-version'] = ANTHROPIC_VERSION;
  if (!key) return headers;
  if (api === 'anthropic-messages') headers['x-api-key'] = key;
  else if (api === 'google-generative-ai') headers['x-goog-api-key'] = key;
  else headers.authorization = `Bearer ${key}`;
  if (authHeader) headers.authorization = `Bearer ${key}`;
  return headers;
}

/** First the model list, which costs nothing; where an endpoint has none, one request for a single token. */
export function attempts(input: Pick<ProviderTestInput, 'api' | 'baseUrl' | 'model'>): Attempt[] {
  const { api, baseUrl, model } = input;
  const ping = [{ role: 'user', content: 'ping' }];
  if (api === 'anthropic-messages')
    return [
      { method: 'GET', url: join(baseUrl, '/v1/models'), kind: 'models' },
      {
        method: 'POST',
        url: join(baseUrl, '/v1/messages'),
        kind: 'completion',
        body: { model, max_tokens: 1, messages: ping },
      },
    ];
  if (api === 'google-generative-ai')
    return [
      { method: 'GET', url: join(baseUrl, '/models'), kind: 'models' },
      {
        method: 'POST',
        url: join(baseUrl, `/models/${encodeURIComponent(model)}:generateContent`),
        kind: 'completion',
        body: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 1 } },
      },
    ];
  const completion: Attempt =
    api === 'openai-responses'
      ? // The Responses API refuses fewer than 16 output tokens.
        {
          method: 'POST',
          url: join(baseUrl, '/responses'),
          kind: 'completion',
          body: { model, input: 'ping', max_output_tokens: 16 },
        }
      : {
          method: 'POST',
          url: join(baseUrl, '/chat/completions'),
          kind: 'completion',
          body: { model, messages: ping, max_tokens: 1 },
        };
  return [{ method: 'GET', url: join(baseUrl, '/models'), kind: 'models' }, completion];
}

/** Model ids from the three list shapes: OpenAI and Anthropic `{data:[{id}]}`, Google `{models:[{name:"models/x"}]}`. */
function listedModels(body: unknown): string[] | undefined {
  const record = asRecord(body);
  const rows = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : undefined;
  if (!rows) return undefined;
  return rows
    .map((row) => text(asRecord(row).id) || text(asRecord(row).name).replace(/^models\//, ''))
    .filter(Boolean)
    .slice(0, 500);
}

/** What the endpoint said went wrong, shortened, and with the key cut out should a server echo it. */
function detailOf(body: unknown, raw: string, key: string): string {
  const error = asRecord(body).error;
  const message = text(asRecord(error).message) || text(error) || text(asRecord(body).message) || raw;
  const clean = [...message].map((char) => (char.charCodeAt(0) < 32 ? ' ' : char)).join('');
  return (key ? clean.split(key).join('***') : clean).trim().slice(0, 300);
}

/** `fetch` in the app is Electron's `net.fetch` (kyrnBridge.ts): it follows the system's proxy, as the check should. */
export type TestOptions = { timeoutMs?: number; fetch?: (url: string, init: RequestInit) => Promise<Response> };

/**
 * One minimal request from the main process, in the wire format of the chosen endpoint type.
 * The key is used for the request and nothing else: it is in no log line, no error and no result.
 */
export async function testProvider(
  input: ProviderTestInput,
  stored: StoredKey,
  options: TestOptions = {}
): Promise<ProviderTestResult> {
  if (!ENDPOINT_TYPES.includes(input.api)) throw new KyrnError('invalid', 'Invalid endpoint type');
  assertEndpoint(input.baseUrl);
  if (typeof input.model !== 'string' || input.model.length > 200) throw new KyrnError('invalid', 'Invalid model');
  if (input.apiKey !== undefined && !SECRET.test(input.apiKey)) throw new KyrnError('credential', 'Invalid credential');
  const started = Date.now();
  const done = (ok: boolean, code: ProviderTestCode, extra: Partial<ProviderTestResult> = {}): ProviderTestResult => ({
    ok,
    code,
    latencyMs: Date.now() - started,
    models: [],
    detail: '',
    ...extra,
  });

  let key = input.apiKey ?? '';
  if (!input.apiKey && stored) {
    // A saved key only ever goes where it was saved for. Otherwise a changed URL could collect it.
    if (stored.unavailable) return done(false, 'key-unavailable');
    if (stored.key && (stored.baseUrl !== input.baseUrl || stored.api !== input.api)) return done(false, 'url-changed');
    key = stored.key;
  }

  const send = options.fetch ?? fetch;
  let last = done(false, 'network');
  for (const attempt of attempts(input)) {
    if (attempt.kind === 'completion' && !input.model.trim()) break;
    let response: Response;
    let raw: string;
    try {
      // eslint-disable-next-line no-await-in-loop
      response = await send(attempt.url, {
        method: attempt.method,
        headers: {
          ...authHeaders(input.api, key, input.authHeader),
          ...(attempt.body ? { 'content-type': 'application/json' } : {}),
        },
        body: attempt.body ? JSON.stringify(attempt.body) : undefined,
        // A redirect could carry the key to another host.
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
      });
      // eslint-disable-next-line no-await-in-loop
      raw = (await response.text()).slice(0, 200_000);
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      return done(false, name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
    }
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = undefined;
    }
    const { status } = response;
    if (status >= 300 && status < 400) return done(false, 'redirect', { status });
    if (status === 401 || status === 403) return done(false, 'auth', { status, detail: detailOf(body, '', key) });
    if (status >= 200 && status < 300) {
      if (attempt.kind === 'completion')
        return body === undefined
          ? done(false, 'invalid-response', { status })
          : done(true, 'ok-completion', { status });
      const models = listedModels(body);
      if (models) return done(true, 'ok-models', { status, models });
      last = done(false, 'invalid-response', { status });
      continue;
    }
    // No model list here (404, 405, 501): that alone says nothing about the endpoint. Try the one-token request.
    last = done(false, status === 404 ? 'not-found' : 'http', {
      status,
      detail: detailOf(body, body === undefined ? '' : raw, key),
    });
    if (attempt.kind === 'models' && [404, 405, 501].includes(status)) continue;
    return last;
  }
  return last;
}
