import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { clmServer } from '../../../../packages/desktop/src/common/kyrn/clm';
import { checkClmServer } from '../../../../packages/desktop/src/process/agent/kyrn/clmServer';

type Reply = { status: number; body?: unknown; location?: string };

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
});

/** A stand-in for clm-serve on a free local port, answering each path as told and noting what it was sent. */
async function clmServe(routes: Record<string, Reply>): Promise<{ url: string; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = [];
  server = createServer((request, response) => {
    seen.push(request.headers);
    const reply = routes[request.url ?? ''] ?? { status: 404, body: { detail: 'Not Found' } };
    response.writeHead(reply.status, {
      'content-type': 'application/json',
      ...(reply.location ? { location: reply.location } : {}),
    });
    response.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, seen };
}

const HEALTH = { ok: true, embedder: true, models: ['clm-latest', 'clm-raw'], cache: null };

describe('asking a CLM server how it is', () => {
  it('reads what /health says, whatever form the address was written in', async () => {
    const { url, seen } = await clmServe({
      '/health': { status: 200, body: HEALTH },
      '/v1/models': { status: 200, body: { models: [] } },
    });
    for (const address of [url, `${url}/`, `${url}/v1`, `${url}/v1/systemone`]) {
      const state = await checkClmServer(address);
      expect(state).toMatchObject({
        status: 'ready',
        models: ['clm-latest', 'clm-raw'],
        mock: false,
        keyRequired: false,
      });
      expect(state.status !== 'down' && state.latencyMs).toBeGreaterThanOrEqual(0);
    }
    // No key goes with the check, saved or not.
    expect(seen.every((headers) => headers.authorization === undefined)).toBe(true);
  });

  it('tells an encoder that is down, a mock encoder and a server that asks for a key', async () => {
    const { url } = await clmServe({
      '/health': { status: 200, body: { ...HEALTH, embedder: false, mock: true } },
      '/v1/models': { status: 401, body: { detail: 'invalid API key' } },
    });
    expect(await checkClmServer(url)).toMatchObject({ status: 'encoderDown', mock: true, keyRequired: true });
  });

  it('calls a server down when nothing answers, or not the way clm-serve does', async () => {
    const { url } = await clmServe({
      '/health': { status: 302, location: 'https://example.com/health' },
    });
    expect(await checkClmServer(url)).toEqual({ status: 'down' });
    await new Promise<void>((done) => server!.close(() => done()));
    server = undefined;
    expect(await checkClmServer(url)).toEqual({ status: 'down' });

    const other = await clmServe({ '/health': { status: 200, body: { status: 'ok' } } });
    expect(await checkClmServer(other.url)).toEqual({ status: 'down' });
  });

  it('asks only addresses the questions may go to: HTTPS or HTTP, never link-local, never with credentials', async () => {
    await expect(checkClmServer('http://169.254.169.254:8700')).rejects.toThrow('not link-local');
    await expect(checkClmServer('https://user:secret@example.com')).rejects.toThrow('without embedded credentials');
  });

  it('names the server behind any form of its address, and this machine when there is none', () => {
    expect(clmServer('')).toBe('http://127.0.0.1:8700');
    expect(clmServer('http://gpu:8700/v1/systemone/')).toBe('http://gpu:8700');
    expect(clmServer('https://example.com/clm/v1')).toBe('https://example.com/clm');
  });
});
