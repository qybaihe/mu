// @ts-check
// One conversation on the native host, end to end: pi runs inside the app (native is the default) with no AionCore and no
// ACP in the conversation's path, against the same local fake model as conversation.spec.mjs, in a throwaway profile
// (profile.mjs, nativeWorld.mjs). Run it with `bun run e2e:conversation --native` (scripts/kyrn/e2e-conversation.mjs
// builds the app first); tests/e2e/README.md says more.
//
// The steps run in order and share one app: a failed step skips the ones after it. Every step ends by checking that
// nothing failed unhandled (page errors, a page's error screen, the main process's reports). The test ids it reads are
// the ones docs/native-host-ui.md lists.
import { expect, test } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_API_KEY, FAKE_MODEL_ID, PLAIN_CHUNKS, PLAIN_TEXT, SLOW_CHUNK_COUNT } from './fakeModel.mjs';
import { createNativeWorld } from './nativeWorld.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const FIRST_MESSAGE = 'E2E:PLAIN 你好，请分几段回答。';
const WRITTEN = 'notes/hello.txt';
const DENIED_COMMAND = 'echo denied > bash-out.txt';

const {
  run,
  sent: SENT,
  page,
  paths,
  sleep,
  requests,
  userRows,
  replies,
  status,
  toolCalls,
  hostFailure,
  stamp,
  noteProcesses,
  expectNothingLeft,
  start,
  stop,
  expectNoProblems,
  shot,
  reachSidebar,
  send,
  runEnds,
  replyWith,
  openToolBox,
  sendAndAnswer,
} = createNativeWorld({ desktopRoot });

test('a fresh start: the native group is in the sidebar, empty, and a conversation is made in a folder', async () => {
  await start();
  const p = page();
  await reachSidebar();
  await expect(p.getByTestId('native-sidebar-empty')).toBeVisible();
  await expect(p.getByTestId('native-sidebar-item')).toHaveCount(0);
  await shot('empty');

  await test.step('the popover offers a folder and the permission modes, and makes the conversation', async () => {
    await p.getByTestId('native-new').click();
    await expect(p.getByTestId('native-new-panel')).toBeVisible();
    // 最小权限: mu asks before it writes or runs anything.
    await p.getByTestId('native-permissions').click();
    await p.locator('.arco-select-popup:visible .arco-select-option', { hasText: '最小权限' }).click();
    await shot('new-conversation');
    await p.getByTestId('native-project').click();
    await p.waitForURL(/#\/conversation\/native\//, { timeout: 30_000 });
    run.conversationUrl = p.url();
  });

  await expect(p.getByTestId('native-conversation')).toBeVisible();
  await expect(p.getByTestId('native-header-folder')).toContainText('project');
  await expect(p.getByTestId('native-empty')).toBeVisible();
  // No host yet: nothing runs until a message needs pi.
  await expect(p.getByTestId('native-header-phase')).toHaveAttribute('data-phase', 'idle');
  await expect(p.getByTestId('native-sidebar-item')).toHaveCount(1);
  expectNoProblems();
});

test('a plain reply streams in, in several pieces', async () => {
  const p = page();
  await send(FIRST_MESSAGE);
  const seen = [];
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const text = await replies()
      .last()
      .innerText({ timeout: 250 })
      .catch(() => '');
    if (text && seen[seen.length - 1] !== text) seen.push(text);
    if (text.includes(PLAIN_TEXT)) break;
    const why = await hostFailure();
    if (why !== undefined) throw new Error(`mu's host stopped: ${why}`);
    await sleep(25);
  }
  expect(seen[seen.length - 1]).toContain(PLAIN_TEXT);
  // Seven pieces, 150 ms apart: the reply showed at least three partial states before the whole.
  expect(seen.filter((text) => !text.includes(PLAIN_TEXT)).length).toBeGreaterThanOrEqual(3);
  await runEnds(/^settled$/);
  await expect(p.getByTestId('native-header-phase')).toHaveAttribute('data-phase', 'running');
  await shot('plain-reply');

  const plain = requests().find((request) => request.scenario === 'plain');
  expect(plain, 'the fake model was asked for the plain reply').toBeTruthy();
  expect(plain).toMatchObject({
    stream: true,
    model: FAKE_MODEL_ID,
    authorization: `Bearer ${FAKE_API_KEY}`,
    sentChunks: PLAIN_CHUNKS.length,
    finished: true,
  });
  expect(plain?.tools).toEqual(expect.arrayContaining(['write', 'bash']));
  // The conversation is in the sidebar, live, under the id pi's session gave it, and it is named by its first message.
  await expect(p.getByTestId('native-sidebar-item')).toHaveCount(1);
  await expect(p.getByTestId('native-sidebar-item')).toHaveAttribute('title', new RegExp(FIRST_MESSAGE.slice(0, 20)));
  expect(p.url(), 'the page follows the conversation to its own id').not.toContain('draft-');
  run.conversationUrl = p.url();
  expectNoProblems();
});

test('最小权限: a write asks once, allowing it writes the file, and the run finishes', async () => {
  const question = await sendAndAnswer(`E2E:WRITE ${WRITTEN}`, 'first', 'WRITE-DONE');
  expect(question, 'the question names the file').toContain(WRITTEN);
  const file = join(paths().project, WRITTEN);
  expect(existsSync(file), `${file} was written`).toBe(true);
  expect(readFileSync(file, 'utf8')).toBe('Written by the fake model for the E2E test.\n');
  const done = requests().findLast((request) => request.scenario === 'write' && request.kind === 'text');
  expect(done?.toolResult).toContain(WRITTEN);

  // The call is a row of the tool box, named by pi's tool and how it stands.
  await openToolBox();
  await expect(toolCalls().first()).toHaveAttribute('data-tool', 'write');
  await expect(toolCalls().first()).toHaveAttribute('data-status', 'completed');
  await shot('tool-box');
  expectNoProblems();
});

test("a bash call answered don't allow reaches the model as a refusal, and the conversation goes on", async () => {
  const question = await sendAndAnswer(`E2E:BASH ${DENIED_COMMAND}`, 'last', 'BASH-SAW');
  expect(question).toContain(DENIED_COMMAND);
  expect(existsSync(join(paths().project, 'bash-out.txt')), 'the refused command did not run').toBe(false);
  const refusal = requests().findLast((request) => request.scenario === 'bash' && request.kind === 'text');
  expect(refusal?.toolResult, 'the model was told the command was refused').toContain(DENIED_COMMAND);
  expect(refusal?.toolResult).toMatch(/not allow|refus|denied|不允许|拒绝/i);
  // The call's row says it was refused, quietly: it did not run, and that is not an error.
  await expect(toolCalls().last()).toHaveAttribute('data-tool', 'bash');
  await expect(toolCalls().last()).toHaveAttribute('data-status', 'denied');
  await expect(page().getByTestId('tool-call-denied').last()).toHaveText('没有运行：你没有允许。');

  await send('E2E:ECHO AFTER-REFUSAL-OK');
  await replyWith('AFTER-REFUSAL-OK');
  expectNoProblems();
});

test('a reply stopped halfway stays stopped, and the next message works', async () => {
  await send('E2E:SLOW 请慢慢说。');
  const reply = replies().filter({ hasText: 'SLOW-001' }).last();
  await expect(reply).toContainText('SLOW-005', { timeout: 60_000 });
  await noteProcesses();

  await test.step('a window that reloads mid-run gets the run back, and it goes on', async () => {
    const p = page();
    await p.reload();
    await p.waitForFunction(() => Boolean(document.querySelector('#root')?.children.length), undefined, {
      timeout: 60_000,
    });
    await expect(p.getByTestId('native-conversation')).toBeVisible({ timeout: 30_000 });
    // The main process's view of the conversation, run in progress included: the reply so far, and it keeps growing.
    await expect(reply).toContainText('SLOW-001', { timeout: 30_000 });
    await expect(p.getByTestId('native-abort')).toBeVisible();
    await expect(reply).toContainText('SLOW-012', { timeout: 30_000 });
    await expect(userRows()).toHaveCount(SENT.length);
  });

  await page().getByTestId('native-abort').click();
  await runEnds(/^aborted$/, 15_000);
  await expect(page().getByTestId('native-abort')).toHaveCount(0);
  const stoppedAt = await reply.innerText();
  await sleep(2_500);
  expect(await reply.innerText(), 'nothing more arrives after the stop').toBe(stoppedAt);
  expect(stoppedAt.match(/SLOW-\d{3}/g)?.length ?? 0).toBeLessThan(SLOW_CHUNK_COUNT);
  const slow = requests().find((request) => request.scenario === 'slow');
  expect(slow, 'the model request was cut off').toMatchObject({ finished: false, aborted: true });
  await shot('stopped');

  await send('E2E:ECHO AFTER-STOP-OK');
  await replyWith('AFTER-STOP-OK');
  expectNoProblems();
});

test('after a quit and a new start the conversation opens with its history, and a new message works', async () => {
  await stop();
  expectNoProblems();
  await expectNothingLeft();

  await start();
  const p = page();
  await reachSidebar();
  // Read from pi's session file: no host starts to show the history.
  await expect(p.getByTestId('native-sidebar-item')).toHaveCount(1);
  await p.getByTestId('native-sidebar-item').click();
  await p.waitForURL(run.conversationUrl, { timeout: 30_000 });
  await expect(p.getByTestId('native-conversation')).toBeVisible();
  for (const text of [PLAIN_TEXT, 'WRITE-DONE', 'BASH-SAW', 'AFTER-REFUSAL-OK', 'SLOW-005', 'AFTER-STOP-OK']) {
    await expect(replies().filter({ hasText: text }).first()).toBeVisible({ timeout: 30_000 });
  }
  await expect(userRows()).toHaveCount(SENT.length);
  await expect(status()).toHaveAttribute('data-status', 'settled');
  await expect(p.getByTestId('native-header-phase')).toHaveAttribute('data-phase', 'idle');
  // The calls read back from the file stand as they stood live: the write done, the refused command refused.
  await expect(toolCalls()).toHaveCount(2);
  await expect(toolCalls().nth(0)).toHaveAttribute('data-tool', 'write');
  await expect(toolCalls().nth(0)).toHaveAttribute('data-status', 'completed');
  await expect(toolCalls().nth(1)).toHaveAttribute('data-tool', 'bash');
  await expect(toolCalls().nth(1)).toHaveAttribute('data-status', 'denied');
  await shot('reopened');

  await test.step('pictures of the same page in the dark theme and in a narrow window, for a look', async () => {
    await p.getByTestId('theme-toggle').click();
    await sleep(600);
    await shot('reopened-dark');
    await p.getByTestId('theme-toggle').click();
    await sleep(600);
    const frame = await run.state?.app.browserWindow(p);
    const before = await frame?.evaluate((win) => win.getSize());
    await frame?.evaluate((win) => win.setSize(760, 760));
    await sleep(800);
    await shot('reopened-narrow');
    if (before) await frame?.evaluate((win, size) => win.setSize(size[0], size[1]), before);
    await sleep(600);
  });

  await send('E2E:ECHO AFTER-RELAUNCH-OK');
  await replyWith('AFTER-RELAUNCH-OK');
  // The first message that needed pi started its host, resuming the session file.
  await expect(p.getByTestId('native-header-phase')).toHaveAttribute('data-phase', 'running');
  expectNoProblems();
});

test('the test stayed in its profile, and left nothing running', async () => {
  await stop();
  expectNoProblems();
  await expectNothingLeft();

  const { project, home, agentDir } = paths();
  const slug = `--${project.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  expect(existsSync(join(agentDir, 'sessions', slug)), "mu kept the conversation's session in MU_AGENT_DIR").toBe(true);
  expect(existsSync(join(home, '.mu', 'agent')), 'nothing in the profile home ~/.mu/agent').toBe(false);
  const realMu = join(homedir(), '.mu');
  expect(existsSync(join(realMu, 'agent', 'sessions', slug)), "nothing in the person's ~/.mu/agent").toBe(false);
  // A native conversation has no ACP record: AionCore never heard of it. (Its start-up health checks leave records of
  // their own, in the temporary folder; none of them names the conversation's project.)
  const records = join(home, '.mu', 'acp-sessions');
  const naming = existsSync(records)
    ? readdirSync(records).filter(
        (name) => name.endsWith('.json') && readFileSync(join(records, name), 'utf8').includes(project)
      )
    : [];
  expect(naming, "ACP session records that name the native conversation's folder").toEqual([]);
  for (const { path, before } of run.untouched) expect(stamp(path), `${path} left alone`).toBe(before);
  run.passed = true;
});
