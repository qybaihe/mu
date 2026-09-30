#!/usr/bin/env node
// A local stand-in for an OpenAI-compatible model, for the mu conversation E2E test. Node's own http module, nothing
// else. It speaks the part of the Chat Completions API that pi's `openai-completions` provider uses: `GET /models`
// (the connection test in the settings) and `POST /chat/completions` with `stream: true`, text deltas, tool calls and
// a usage chunk.
//
// What it answers is scripted per turn by the last user message, so the test decides every reply by what it types:
//
//   E2E:PLAIN            a plain reply, streamed in several chunks
//   E2E:WRITE <path>     calls `write` with <path>; once the result is back, says WRITE-DONE and what the tool said
//   E2E:BASH <command>   calls `bash` with <command>; once the result is back, says BASH-SAW and what the tool said
//   E2E:SLOW [<n>]       a long reply, one chunk every 200 ms, for stopping in the middle; <n> chunks (150 without it)
//   E2E:ECHO <text>      replies <text>
//
// Anything else (a request mu makes for itself) gets a short neutral reply; the board's writer gets the JSON it asks
// for. Every completion request is recorded (`GET /__e2e/log` returns them), so a test can check what the model was
// sent; `hits` lists every request of any kind, to show what else reached the server.
//
//   node fakeModel.mjs [--port 0]      prints `FAKE_MODEL_LISTENING <port>` and serves until killed
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const FAKE_MODEL_ID = 'e2e-fake-model';
export const FAKE_API_KEY = 'e2e-key-not-secret';

/** The plain reply, as the chunks it is sent in. */
export const PLAIN_CHUNKS = ['PLAIN-REPLY-OK: ', '这是', '分成', '好几段', '流式', '发回来的', '回答。'];
export const PLAIN_TEXT = PLAIN_CHUNKS.join('');
export const SLOW_CHUNK_COUNT = 150;
/** What the board's writer gets back: the JSON object its system prompt asks for. */
export const BOARD_REPLY = {
  progress: 'E2E-BOARD-PROGRESS: 已经写好一个文件。',
  now: 'E2E-BOARD-NOW: 正在等下一步。',
  confirm: [],
  note: 'E2E-BOARD-NOTE: 写了一个文件。',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The text of a message's content: a string, or the text parts of an array. */
export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

/**
 * mu's own note about the task frame goes to the model as a user message after the person's (a session it has no frame
 * for yet, an imported one, gets one at its first message): it is not the person's turn.
 */
const isFrameNote = (message) => /^\s*\[mu task frame/.test(textOf(message?.content));

/**
 * What to answer, from the request's messages: the turn is the last user message (not mu's note about the task frame),
 * the step is how many tool results came back after it.
 */
export function planReply(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const system = list
    .filter((message) => message && (message.role === 'system' || message.role === 'developer'))
    .map((message) => textOf(message.content))
    .join('\n');
  let lastUser = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.role === 'user' && !isFrameNote(list[i])) {
      lastUser = i;
      break;
    }
  }
  const user = lastUser >= 0 ? textOf(list[lastUser].content) : '';
  const results = list.slice(lastUser + 1).filter((message) => message?.role === 'tool');
  const lastResult = results.length ? textOf(results[results.length - 1].content) : '';
  if (/You tell a person who is not a programmer/.test(system)) {
    return { scenario: 'board', kind: 'text', chunks: [JSON.stringify(BOARD_REPLY)] };
  }
  const marker = /E2E:(PLAIN|WRITE|BASH|SLOW|ECHO)(?:[ \t]+([^\n]*))?/.exec(user);
  if (!marker) return { scenario: 'other', kind: 'text', chunks: ['OK.'] };
  const [, name, rawArgument = ''] = marker;
  const argument = rawArgument.trim();
  switch (name) {
    case 'PLAIN':
      return { scenario: 'plain', kind: 'text', chunks: PLAIN_CHUNKS, delay: 150 };
    case 'SLOW': {
      // `E2E:SLOW 50` is a run that ends in 10 s, for a test that waits for its end; words after it (`keep going`) count for nothing.
      const count = Number.parseInt(argument, 10);
      return {
        scenario: 'slow',
        kind: 'text',
        chunks: Array.from(
          { length: count > 0 ? count : SLOW_CHUNK_COUNT },
          (_, i) => `SLOW-${String(i + 1).padStart(3, '0')} `
        ),
        delay: 200,
      };
    }
    case 'ECHO':
      return { scenario: 'echo', kind: 'text', chunks: [argument || 'ECHO'] };
    case 'WRITE':
      if (results.length === 0) {
        return {
          scenario: 'write',
          kind: 'tool',
          tool: 'write',
          args: { path: argument, content: `Written by the fake model for the E2E test.\n` },
        };
      }
      return {
        scenario: 'write',
        kind: 'text',
        chunks: ['WRITE-DONE: ', lastResult.slice(0, 300)],
        result: lastResult,
      };
    case 'BASH':
      if (results.length === 0) {
        return { scenario: 'bash', kind: 'tool', tool: 'bash', args: { command: argument } };
      }
      return { scenario: 'bash', kind: 'text', chunks: ['BASH-SAW: ', lastResult.slice(0, 300)], result: lastResult };
    default:
      return { scenario: 'other', kind: 'text', chunks: ['OK.'] };
  }
}

/** One Server-Sent Events frame of a chat completion chunk. */
function frame(id, model, choice, extra = {}) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: choice ? [{ index: 0, ...choice }] : [],
    ...extra,
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

async function readBody(request) {
  const parts = [];
  for await (const part of request) parts.push(part);
  return Buffer.concat(parts).toString('utf8');
}

/**
 * Starts the server on 127.0.0.1. `port` 0 picks a free one. Returns its address, the recorded completion requests,
 * every request's method and path (`hits`) and a close function.
 */
export async function startFakeModel({ port = 0, log = () => {} } = {}) {
  const requests = [];
  const hits = [];
  let sequence = 0;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '');
    hits.push({ method: request.method ?? '', path });
    try {
      if (request.method === 'GET' && path === '/__e2e/log') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(requests));
        return;
      }
      if (request.method === 'GET' && path.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: FAKE_MODEL_ID, object: 'model', created: 0, owned_by: 'e2e' }],
          })
        );
        return;
      }
      if (request.method !== 'POST' || !path.endsWith('/chat/completions')) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: `fake model: no route ${request.method} ${path}` } }));
        return;
      }
      const raw = (await readBody(request)) || '{}';
      const body = JSON.parse(raw);
      const plan = planReply(body.messages);
      sequence += 1;
      const record = {
        n: sequence,
        at: new Date().toISOString(),
        scenario: plan.scenario,
        kind: plan.kind,
        stream: body.stream === true,
        authorization: request.headers.authorization ?? '',
        model: body.model,
        tools: Array.isArray(body.tools) ? body.tools.map((tool) => tool?.function?.name).filter(Boolean) : [],
        /** How many messages the request carried (the history pi sent), and how many bytes its body was. */
        messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
        /** How many of them each role has (`user`, `assistant`, `tool`, `system`). */
        roles: Array.isArray(body.messages)
          ? body.messages.reduce((counts, message) => {
              const role = String(message?.role);
              counts[role] = (counts[role] ?? 0) + 1;
              return counts;
            }, {})
          : {},
        bodyBytes: raw.length,
        lastUser: '',
        /** The images in the last user message (`image_url` parts). */
        images: 0,
        /** The thinking level pi asked for (`reasoning_effort`), for a model that reasons. */
        reasoningEffort: typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined,
        toolResult: plan.result,
        sentChunks: 0,
        finished: false,
        aborted: false,
      };
      for (let i = (body.messages?.length ?? 0) - 1; i >= 0; i -= 1) {
        if (body.messages[i]?.role === 'user' && !isFrameNote(body.messages[i])) {
          const content = body.messages[i].content;
          record.lastUser = textOf(content).slice(-400);
          record.images = Array.isArray(content) ? content.filter((part) => part?.type === 'image_url').length : 0;
          break;
        }
      }
      requests.push(record);
      log(`#${record.n} ${record.scenario}/${record.kind} ${record.lastUser.slice(-80).replace(/\s+/g, ' ')}`);
      const id = `chatcmpl-e2e-${sequence}`;
      const model = typeof body.model === 'string' ? body.model : FAKE_MODEL_ID;
      if (body.stream !== true) {
        const message =
          plan.kind === 'tool'
            ? {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: `call_e2e_${sequence}`,
                    type: 'function',
                    function: { name: plan.tool, arguments: JSON.stringify(plan.args) },
                  },
                ],
              }
            : { role: 'assistant', content: plan.chunks.join('') };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, message, finish_reason: plan.kind === 'tool' ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          })
        );
        record.finished = true;
        return;
      }
      let closed = false;
      response.on('close', () => {
        closed = true;
        if (!record.finished) record.aborted = true;
      });
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const send = (text) => {
        if (closed) return false;
        response.write(text);
        return true;
      };
      send(frame(id, model, { delta: { role: 'assistant', content: '' }, finish_reason: null }));
      if (plan.kind === 'tool') {
        const callId = `call_e2e_${sequence}`;
        const args = JSON.stringify(plan.args);
        send(
          frame(id, model, {
            delta: {
              tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: plan.tool, arguments: '' } }],
            },
            finish_reason: null,
          })
        );
        // The arguments arrive in pieces, as a real model streams them.
        const half = Math.ceil(args.length / 2);
        for (const piece of [args.slice(0, half), args.slice(half)]) {
          await sleep(40);
          send(
            frame(id, model, {
              delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] },
              finish_reason: null,
            })
          );
          record.sentChunks += 1;
        }
        send(frame(id, model, { delta: {}, finish_reason: 'tool_calls' }));
      } else {
        for (const chunk of plan.chunks) {
          if (plan.delay) await sleep(plan.delay);
          if (!send(frame(id, model, { delta: { content: chunk }, finish_reason: null }))) return;
          record.sentChunks += 1;
        }
        if (closed) return;
        send(frame(id, model, { delta: {}, finish_reason: 'stop' }));
      }
      send(frame(id, model, null, { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
      send('data: [DONE]\n\n');
      record.finished = true;
      response.end();
    } catch (error) {
      log(`fake model error: ${error instanceof Error ? error.stack : String(error)}`);
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    port: actualPort,
    baseUrl: `http://127.0.0.1:${actualPort}/v1`,
    requests,
    hits,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const index = process.argv.indexOf('--port');
  const port = index > 1 ? Number(process.argv[index + 1]) : 0;
  const started = await startFakeModel({ port, log: (line) => process.stderr.write(`[fake model] ${line}\n`) });
  process.stdout.write(`FAKE_MODEL_LISTENING ${started.port}\n`);
}
