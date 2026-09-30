// @ts-check
// A native conversation that wants its person, end to end in the real app (native is the default): a run that ends while
// another conversation is on screen marks its row in the sidebar (a spinner while it ran, a dot once it ended) and
// tells the system; a click on the notification opens it and takes the mark off; a run the person stopped tells nobody;
// a question pi asks tells the system at once. The system's own notifications cannot be seen by a test: the main process's
// Notification is stood in for, and the window is said not to be in front (the main process shows nothing while it is).
// Run with `bun run e2e:conversation --native` (every native*.spec.mjs).
import { expect, test } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeWorld } from './nativeWorld.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const {
  run,
  page,
  sleep,
  status,
  dialogs,
  expectNothingLeft,
  start,
  stop,
  expectNoProblems,
  shot,
  reachSidebar,
  send,
  runEnds,
  replyWith,
  newConversation,
} = createNativeWorld({ desktopRoot });

const RUN = 'E2E:SLOW 50';
const rowOf = (title) => page().locator('[data-testid="native-sidebar-item"]').filter({ hasText: title });

/** The system notifications the main process showed, as the stand-in kept them. */
const notes = () =>
  run.state.app.evaluate(() => /** @type {any} */ (globalThis).__muNotes.map(({ title, body }) => ({ title, body })));

let idOfRun = '';

test('the main process’s notifications are stood in for, and the window is not in front', async () => {
  await start();
  await reachSidebar();
  await run.state.app.evaluate(({ Notification, BrowserWindow }) => {
    /** @type {any} */ (globalThis).__muNotes = [];
    const on = Notification.prototype.on;
    Notification.prototype.on = function (event, listener) {
      if (event === 'click') this.__click = listener;
      return on.call(this, event, listener);
    };
    Notification.prototype.show = function () {
      /** @type {any} */ (globalThis).__muNotes.push({
        title: this.title,
        body: this.body,
        click: () => this.__click?.(),
      });
    };
    BrowserWindow.prototype.isFocused = () => false;
  });
  expect(await notes()).toEqual([]);
  expectNoProblems();
});

test('a run shows as a spinner in its row, and once it ends while another conversation is on screen the row is marked and the system told', async () => {
  const p = page();
  await newConversation();
  await send(RUN);
  await expect(rowOf(RUN)).toHaveAttribute('data-running', 'true', { timeout: 30_000 });
  await expect(rowOf(RUN).getByTestId('native-sidebar-running')).toBeVisible();
  idOfRun = (await rowOf(RUN).getAttribute('data-id')) ?? '';
  expect(idOfRun).not.toBe('');
  await shot('attention-running');

  // The person leaves it for another conversation while it runs.
  await newConversation();
  expect(p.url()).not.toContain(idOfRun);
  await expect(rowOf(RUN)).toHaveAttribute('data-unread', 'true', { timeout: 60_000 });
  await expect(rowOf(RUN)).not.toHaveAttribute('data-running');
  await expect(rowOf(RUN).getByTestId('native-sidebar-unread')).toBeVisible();
  // Painted, not only there: the dot's colour is the theme's, and a colour the browser cannot read is transparent.
  const dot = rowOf(RUN).getByTestId('native-sidebar-unread').locator('span');
  await expect(dot).toHaveCSS('background-color', /^rgb\(\d+, \d+, \d+\)$/);
  await shot('attention-unread');

  await expect.poll(notes, { timeout: 15_000 }).toHaveLength(1);
  const [note] = await notes();
  expect(note.title).toBe('mu');
  expect(note.body).toContain(RUN);
  // The profile's language says a reply has finished.
  expect(note.body).toMatch(/已完成本轮回复/);
  expectNoProblems();
});

test('a click on the notification opens the conversation, and its mark goes', async () => {
  const p = page();
  await run.state.app.evaluate(() => /** @type {any} */ (globalThis).__muNotes[0].click());
  await expect.poll(() => p.url(), { timeout: 15_000 }).toContain(`/conversation/native/${idOfRun}`);
  await expect(rowOf(RUN)).not.toHaveAttribute('data-unread');
  await expect(rowOf(RUN).getByTestId('native-sidebar-unread')).toHaveCount(0);
  await expect(p.locator('[data-testid="native-message-assistant"]').filter({ hasText: 'SLOW-050' })).toBeVisible({
    timeout: 15_000,
  });
  expectNoProblems();
});

test('a run the person stops tells nobody', async () => {
  const p = page();
  const before = (await notes()).length;
  await send('E2E:SLOW 150');
  await expect(status()).toHaveAttribute('data-status', /^(working|thinking)$/, { timeout: 60_000 });
  await p.getByTestId('native-abort').click();
  await runEnds(/^aborted$/);
  // Past the moment a run that ended would be told after.
  await sleep(2500);
  expect((await notes()).length).toBe(before);
  expectNoProblems();
});

test('a question pi asks tells the system at once', async () => {
  const before = (await notes()).length;
  // 最小权限: mu asks before it writes or runs anything that changes something.
  await newConversation({ permissions: '最小权限' });
  await send('E2E:WRITE notes/asked.txt');
  await expect(dialogs()).toHaveCount(1, { timeout: 60_000 });
  await expect.poll(async () => (await notes()).length, { timeout: 10_000 }).toBe(before + 1);
  const last = (await notes()).at(-1);
  expect(last.title).toBe('mu');
  expect(last.body).toMatch(/等待你确认/);
  await dialogs().getByTestId('native-dialog-option').first().click();
  await replyWith('WRITE-DONE');
  expectNoProblems();
});

test('the test stayed in its profile, and left nothing running', async () => {
  await stop();
  expectNoProblems();
  await expectNothingLeft();
  run.passed = true;
});
