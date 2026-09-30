// @ts-check
// A long conversation in the real app: a session file with thousands of messages (as pi writes them) is opened from the
// sidebar, resumed with a new message, and read back to its first message. Prints how long each takes and fails past
// bounds, so a slow path shows up as a number. The page draws the latest rows only (a session of 6,752 entries drew
// every message and took 24 seconds to open); scrolling to the top shows the ones before, and keeps the reader's place.
// Same world as native.spec.mjs (nativeWorld.mjs). MU_E2E_TURNS sets the size (default 3000 turns: about 6000 messages).
import { expect, test } from '@playwright/test';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_MODEL_ID, PLAIN_TEXT } from './fakeModel.mjs';
import { createNativeWorld } from './nativeWorld.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TURNS = Number(process.env.MU_E2E_TURNS ?? 3000);

const {
  run,
  page,
  paths,
  replies,
  userRows,
  status,
  start,
  stop,
  expectNoProblems,
  expectNothingLeft,
  shot,
  reachSidebar,
  send,
  replyWith,
} = createNativeWorld({ desktopRoot });

/** The rows the message list has drawn. */
const rowsInDom = () => page().locator('[data-testid="message-list-content"] [id^="message-"]');

/** A pi session file: `turns` user/assistant pairs, every eighth with a bash call and its result. */
function longSession(cwd, turns) {
  const id = '01a0ed98-0000-7000-8000-000000000001';
  const started = Date.parse('2026-09-01T10:00:00.000Z');
  const lines = [{ type: 'session', version: 3, id, timestamp: new Date(started).toISOString(), cwd }];
  let parent = null;
  let n = 0;
  let clock = started;
  const entry = (body) => {
    n += 1;
    const entryId = n.toString(16).padStart(8, '0');
    clock += 1_000;
    lines.push({ ...body, id: entryId, parentId: parent, timestamp: new Date(clock).toISOString() });
    parent = entryId;
  };
  entry({ type: 'model_change', provider: 'e2e', modelId: FAKE_MODEL_ID });
  entry({ type: 'thinking_level_change', thinkingLevel: 'off' });
  const usage = {
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 120,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const assistant = (content, stopReason) => ({
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'e2e',
    model: FAKE_MODEL_ID,
    usage,
    stopReason,
    timestamp: clock,
  });
  const filler =
    '这是一段用来撑长会话的回答，包含 some English words, `inline code`, and a list:\n- 第一项\n- second item\n\n';
  for (let turn = 1; turn <= turns; turn += 1) {
    entry({
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: `第 ${turn} 个问题：请说明 TURN-${turn} 的做法。` }],
        timestamp: clock,
      },
    });
    if (turn % 8 === 0) {
      const call = `call_${turn}`;
      entry({
        type: 'message',
        message: assistant(
          [{ type: 'toolCall', id: call, name: 'bash', arguments: { command: `echo turn ${turn}` } }],
          'toolUse'
        ),
      });
      entry({
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: call,
          toolName: 'bash',
          content: [{ type: 'text', text: `turn ${turn}\n${'output line\n'.repeat(200)}` }],
          isError: false,
          timestamp: clock,
        },
      });
    }
    entry({
      type: 'message',
      message: assistant([{ type: 'text', text: `TURN-${turn}-DONE ${filler.repeat(6)}` }], 'stop'),
    });
  }
  return { id, text: lines.map((line) => JSON.stringify(line)).join('\n') + '\n', messages: n };
}

test('a session of thousands of messages opens from the sidebar, and a new message resumes it', async () => {
  const { project, agentDir } = paths();
  const session = longSession(project, TURNS);
  const slug = `--${project.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const folder = join(agentDir, 'sessions', slug);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `2026-09-01T10-00-00-000Z_${session.id}.jsonl`);
  writeFileSync(file, session.text);
  const megabytes = (statSync(file).size / 1_048_576).toFixed(1);
  console.log(`[mu e2e] long session: ${session.messages} entries, ${megabytes} MB`);

  await start();
  const p = page();
  await reachSidebar();
  await expect(p.getByTestId('native-sidebar-item')).toHaveCount(1);

  // MU_E2E_PROFILE=1 records a CPU profile of the window while the session opens and prints where the time went.
  const cdp = process.env.MU_E2E_PROFILE === '1' ? await p.context().newCDPSession(p) : undefined;
  if (cdp) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
  }
  const opened = Date.now();
  await p.getByTestId('native-sidebar-item').click();
  await expect(
    replies()
      .filter({ hasText: `TURN-${TURNS}-DONE` })
      .last()
  ).toBeVisible({ timeout: 120_000 });
  const openMs = Date.now() - opened;
  console.log(`[mu e2e] opened in ${openMs} ms`);
  if (cdp) {
    const { profile } = await cdp.send('Profiler.stop');
    writeFileSync(join(paths().logs, 'open-long-session.cpuprofile'), JSON.stringify(profile));
    const self = new Map();
    const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
    profile.samples.forEach((id, i) => {
      const frame = nodes.get(id)?.callFrame;
      const key = `${frame?.functionName || '(anonymous)'} ${String(frame?.url ?? '')
        .split('/')
        .slice(-2)
        .join('/')}:${frame?.lineNumber}`;
      self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0));
    });
    const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
    console.log(
      `[mu e2e] top self time while opening:\n${top.map(([key, us]) => `  ${(us / 1000).toFixed(0).padStart(6)} ms  ${key}`).join('\n')}`
    );
  }
  await expect(userRows().last()).toContainText(`TURN-${TURNS}`);
  await expect(status()).toHaveAttribute('data-status', 'settled');
  await shot('long-session');
  expect(openMs, 'opening the long session').toBeLessThan(8_000);
  // Only the latest rows are in the page: a window of them, not the thousands of the session.
  const drawn = await rowsInDom().count();
  console.log(`[mu e2e] rows in the page after opening: ${drawn}`);
  expect(drawn).toBeGreaterThan(0);
  expect(drawn).toBeLessThan(400);

  const resumed = Date.now();
  await send('E2E:ECHO AFTER-LONG-OK');
  await replyWith('AFTER-LONG-OK', 120_000);
  const resumeMs = Date.now() - resumed;
  console.log(`[mu e2e] a new message answered in ${resumeMs} ms (host start included)`);
  expect(resumeMs, 'resuming the long session with a message').toBeLessThan(30_000);

  // A reply that streams in a long session: every piece redraws the last row, and the page must not stall meanwhile
  // (the tasks that block the page for more than 50 ms, and the longest gap between two frames).
  await p.evaluate(() => {
    const seen = { tasks: [], gap: 0, last: performance.now() };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) seen.tasks.push(entry.duration);
    }).observe({ entryTypes: ['longtask'] });
    const frame = (now) => {
      seen.gap = Math.max(seen.gap, now - seen.last);
      seen.last = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    window.__streaming = seen;
  });
  await send('E2E:PLAIN 再分几段回答一次。');
  await replyWith(PLAIN_TEXT, 60_000);
  const streaming = await p.evaluate(() => window.__streaming);
  const longest = Math.max(0, ...streaming.tasks);
  console.log(
    `[mu e2e] a reply streamed in the long session: ${streaming.tasks.length} tasks over 50 ms (longest ${Math.round(longest)} ms), longest gap between frames ${Math.round(streaming.gap)} ms`
  );
  expect(longest, 'the longest task while a reply streams').toBeLessThan(500);
  expectNoProblems();
});

test('scrolling to the top shows the rows before, and the reader keeps their place', async () => {
  const p = page();
  const scroller = p.getByTestId('message-list-scroller');
  /** Where the first row in the page is, and how many rows are in it. */
  const first = () =>
    p.evaluate(() => {
      const list = document.querySelector('[data-testid="message-list-scroller"]');
      const rows = document.querySelectorAll('[data-testid="message-list-content"] [id^="message-"]');
      const row = rows[0];
      return {
        id: row?.id ?? '',
        offset: row && list ? row.getBoundingClientRect().top - list.getBoundingClientRect().top : NaN,
        count: rows.length,
      };
    });
  /** Where the row with this id is, from the top of the list, once the list has had two frames to keep its place. */
  const offsetOf = (id) =>
    p.evaluate(
      (rowId) =>
        new Promise((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const list = document.querySelector('[data-testid="message-list-scroller"]');
              const row = document.getElementById(rowId);
              resolve(row && list ? row.getBoundingClientRect().top - list.getBoundingClientRect().top : NaN);
            })
          )
        ),
      id
    );

  // Up to the top of the window: the list asks the page for the rows before, and the row that was first stays put.
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  const before = await first();
  await expect.poll(async () => (await first()).count, { timeout: 15_000 }).toBeGreaterThan(before.count);
  // At once, and again after the rows drawn above have rendered their content: the row that was first stays where it was.
  const anchored = await offsetOf(before.id);
  await p.waitForTimeout(1_000);
  const settled = await offsetOf(before.id);
  console.log(
    `[mu e2e] a step up: ${before.count} -> ${(await first()).count} rows; the row that was first moved ${Math.round(anchored - before.offset)} px at once, ${Math.round(settled - before.offset)} px after a second`
  );
  expect(Math.abs(anchored - before.offset), 'the reader keeps their place, at once').toBeLessThan(40);
  expect(Math.abs(settled - before.offset), 'the reader keeps their place, after the rows are drawn').toBeLessThan(40);
  await shot('long-session-earlier');

  // Steps up until the first message of the session: each shows rows before those in the page, a step of a window.
  const reading = Date.now();
  let steps = 1;
  const firstMessage = p.getByTestId('native-message-user').filter({ hasText: '第 1 个问题' });
  while ((await firstMessage.count()) === 0 && steps < 80) {
    const now = await first();
    await scroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect.poll(async () => (await first()).count, { timeout: 30_000 }).toBeGreaterThan(now.count);
    steps += 1;
  }
  const readMs = Date.now() - reading;
  const total = (await first()).count;
  console.log(`[mu e2e] back to the first message in ${steps} steps, ${readMs} ms, ${total} rows in the page`);
  await expect(firstMessage).toHaveCount(1);
  expect(steps).toBeGreaterThan(5);
  expect(readMs, 'reading a long session back to its first message').toBeLessThan(90_000);
  expectNoProblems();
});

test('the app quits with nothing left running', async () => {
  await stop();
  await expectNothingLeft();
  run.passed = true;
});
