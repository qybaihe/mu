// @ts-check
// Coming to mu from another coding agent: the profile's home holds a Claude Code transcript, a Codex rollout and a ZCode
// database, all of the test's project. The guide's first screen offers them under each tool's mark; the dialog lists
// them under the same marks; importing all three makes three native conversations, and the Claude Code one opens with
// its whole history: the person's words and image, the thinking, the tool call and its result, the answer. Run with
// `bun run e2e:conversation --native` (every native*.spec.mjs).
import { expect, test } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { FAKE_API_KEY, FAKE_MODEL_ID } from './fakeModel.mjs';
import { createNativeWorld } from './nativeWorld.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const T0 = Date.parse('2026-10-20T09:00:00.000Z');
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();

/** A small PNG (a violet-to-teal square) as base64: the image the person pasted. */
function png(size = 48) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = [];
  for (let y = 0; y < size; y++) {
    rows.push(0);
    for (let x = 0; x < size; x++) rows.push(120 - x, 80 + y * 2, 220 - y);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

function writeLines(file, lines) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
}

/** The three tools' conversations, all about the test's project. */
function plant(home, project) {
  const id = '0b9c6f7e-1111-4222-8333-444455556666';
  const record = (type, uuid, parent, seconds, extra) => ({
    parentUuid: parent,
    isSidechain: false,
    cwd: project,
    sessionId: id,
    version: '2.1.0',
    type,
    uuid,
    timestamp: at(seconds),
    ...extra,
  });
  writeLines(join(home, '.claude', 'projects', project.replace(/[^\w]/g, '-'), `${id}.jsonl`), [
    record('user', 'u1', null, 1, {
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Why does the README look off in this screenshot?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png() } },
        ],
      },
    }),
    record('assistant', 'a1', 'u1', 2, {
      message: {
        id: 'm1',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'thinking', thinking: 'Read the README before guessing.', signature: 'sig' }],
      },
    }),
    record('assistant', 'a2', 'a1', 2, {
      message: {
        id: 'm1',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: join(project, 'README.md') } }],
      },
    }),
    record('user', 'r1', 'a2', 3, {
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '1\t# E2E project\n2\t' }],
      },
    }),
    record('assistant', 'a3', 'r1', 4, {
      message: {
        id: 'm2',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: 'The README has only its title line; the screenshot shows the same.' }],
      },
    }),
    { type: 'ai-title', aiTitle: 'README screenshot check', sessionId: id },
  ]);

  const codexId = '019a0000-aaaa-7bbb-8ccc-ddddeeeeffff';
  const item = (seconds, payload) => ({ timestamp: at(seconds), type: 'response_item', payload });
  writeLines(join(home, '.codex', 'sessions', '2026', '10', '20', `rollout-2026-10-20T09-10-00-${codexId}.jsonl`), [
    { timestamp: at(10), type: 'session_meta', payload: { id: codexId, timestamp: at(10), cwd: project } },
    { timestamp: at(10), type: 'turn_context', payload: { cwd: project, model: 'gpt-test' } },
    item(11, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List the files here' }] }),
    item(12, { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'call_1' }),
    item(13, {
      type: 'function_call_output',
      call_id: 'call_1',
      output: '{"output":"README.md","metadata":{"exit_code":0}}',
    }),
    item(14, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Just README.md.' }] }),
  ]);

  const database = join(home, '.zcode', 'cli', 'db', 'db.sqlite');
  mkdirSync(dirname(database), { recursive: true });
  const db = new DatabaseSync(database);
  db.exec(`
    CREATE TABLE session (id text primary key, project_id text not null, parent_id text, slug text not null,
      directory text not null, title text not null, version text not null, revert text, time_created integer not null,
      time_updated integer not null, time_archived integer, task_type text not null default 'interactive',
      title_source text not null default 'first_input');
    CREATE TABLE message (id text primary key, session_id text not null, time_created integer not null,
      time_updated integer not null, data text not null, sequence integer);
    CREATE TABLE part (id text primary key, message_id text not null, session_id text not null,
      time_created integer not null, time_updated integer not null, data text not null, sequence integer);
  `);
  const visible = (kind) => ({
    kind,
    uiVisibility: 'visible',
    providerVisibility: 'visible',
    transcriptVisibility: 'visible',
  });
  db.prepare(
    "INSERT INTO session VALUES ('sess_e2e', 'p', NULL, 's', ?, 'Summarize the project', '0.16.9', NULL, ?, ?, NULL, 'interactive', 'generated')"
  ).run(project, T0 + 20_000, T0 + 22_000);
  const message = (id, seconds, data, sequence) =>
    db
      .prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'sess_e2e', T0 + seconds * 1000, T0 + seconds * 1000, JSON.stringify(data), sequence);
  const part = (id, messageId, data, sequence) =>
    db
      .prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, messageId, 'sess_e2e', T0, T0, JSON.stringify(data), sequence);
  message('z0', 20, { role: 'user', semantics: visible('user_prompt') }, 0);
  part('z0p', 'z0', { type: 'text', text: 'Summarize this project in one line' }, 0);
  message('z1', 21, { role: 'assistant', modelId: 'GLM-test', semantics: visible('assistant_response') }, 1);
  part('z1p0', 'z1', { type: 'reasoning', text: 'It only has a README.' }, 0);
  part('z1p1', 'z1', { type: 'text', text: 'A folder for the mu conversation test.' }, 1);
  db.close();
}

const {
  run,
  page,
  paths,
  requests,
  start,
  stop,
  shot,
  send,
  replyWith,
  reachSidebar,
  expectNoProblems,
  expectNothingLeft,
} = createNativeWorld({
  desktopRoot,
  prepare: (profile) => {
    // A first start: no model yet, so the app opens on its guide.
    rmSync(join(profile.paths.agentDir, 'models.json'), { force: true });
    rmSync(join(profile.paths.agentDir, 'settings.json'), { force: true });
    plant(profile.paths.home, profile.paths.project);
  },
});

test('the guide offers the other tools conversations under their marks, and one opens with its whole history', async () => {
  await start();
  const p = page();
  const offer = p.getByTestId('mu-welcome-intro-import');
  await expect(offer).toBeVisible({ timeout: 60_000 });
  const sources = offer.getByTestId('import-sources').locator('li');
  await expect(sources).toHaveCount(3);
  await expect(sources.nth(0)).toHaveAttribute('data-tool', 'claude-code');
  await expect(sources.nth(1)).toHaveAttribute('data-tool', 'codex');
  await expect(sources.nth(2)).toHaveAttribute('data-tool', 'zcode');
  await shot('import-guide');

  await offer.getByTestId('mu-welcome-intro-import-open').click();
  const groups = p.getByTestId('import-chat-group');
  await expect(groups).toHaveCount(3, { timeout: 60_000 });
  await expect(p.getByTestId('import-chat-row').filter({ hasText: 'README screenshot check' })).toBeVisible();
  for (const row of await p.getByTestId('import-chat-row').all()) await row.locator('.arco-checkbox').click();
  await shot('import-dialog');
  await p.getByTestId('import-chats-start').click();
  await expect(p.getByTestId('import-chats-start')).toBeHidden({ timeout: 120_000 });
  // The guide stays where it was, and has nothing left to offer.
  await expect(p.getByTestId('mu-welcome-step-intro')).toBeVisible();
  await expect(offer).toBeHidden({ timeout: 30_000 });

  await reachSidebar();
  const item = p.getByTestId('native-sidebar-item').filter({ hasText: 'README screenshot check' });
  await expect(item).toBeVisible({ timeout: 30_000 });
  await expect(p.getByTestId('native-sidebar-item').filter({ hasText: 'Summarize the project' })).toBeVisible();
  await expect(p.getByTestId('native-sidebar-item').filter({ hasText: 'List the files here' })).toBeVisible();
  await item.click();
  await expect(p.getByTestId('native-message-user').first()).toContainText('Why does the README look off');
  await expect(p.locator('[data-testid="native-message-user"] img').first()).toBeVisible();
  await expect(
    p
      .locator('[data-testid="native-message-assistant"] .markdown-shadow-body')
      .filter({ hasText: 'only its title line' })
  ).toBeVisible();
  await expect(p.getByTestId('mu-notice').filter({ hasText: 'Claude Code' }).first()).toBeVisible();
  await shot('imported-conversation');
  expectNoProblems();
});

test('with a model set up, the imported conversation goes on, and the model reads its whole history', async () => {
  await stop();
  // The person sets a model up afterwards (the guide's model step, the settings): mu's own, not the one Claude Code used.
  const provider = {
    baseUrl: run.fake?.baseUrl,
    api: 'openai-completions',
    apiKey: FAKE_API_KEY,
    models: [{ id: FAKE_MODEL_ID }],
  };
  writeFileSync(join(paths().agentDir, 'models.json'), JSON.stringify({ providers: { e2e: provider } }));
  writeFileSync(
    join(paths().agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'e2e', defaultModel: FAKE_MODEL_ID })
  );
  await start();
  await reachSidebar();
  const p = page();
  await p.getByTestId('native-sidebar-item').filter({ hasText: 'README screenshot check' }).click();
  await expect(p.getByTestId('native-message-user').first()).toContainText('Why does the README look off');
  // Imported before a model was set up: it goes on with mu's default, not with the model Claude Code answered with.
  const chip = p.getByTestId('native-model-chip');
  await expect(chip).toHaveAttribute('data-model', '');
  await expect(chip).not.toContainText('claude-test');
  await send('E2E:PLAIN carry on from here');
  await replyWith('PLAIN-REPLY-OK');
  const asked = requests().findLast((request) => request.lastUser.includes('carry on from here'));
  expect(asked?.model).toBe(FAKE_MODEL_ID);
  // The imported turn came along: the person's message, the call and its result, the answer.
  expect(asked?.roles.tool, 'the imported tool result').toBe(1);
  expect(asked?.roles.assistant, 'the imported answers').toBeGreaterThanOrEqual(2);
  expect(asked?.roles.user, 'the imported message and the new one').toBeGreaterThanOrEqual(2);
  await expect(chip).toHaveAttribute('data-model', `e2e/${FAKE_MODEL_ID}`);
  await shot('imported-continued');
  expectNoProblems();
});

test('the test left nothing running', async () => {
  await stop();
  await expectNothingLeft();
  run.passed = true;
});
