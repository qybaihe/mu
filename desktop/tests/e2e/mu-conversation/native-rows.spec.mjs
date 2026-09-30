// @ts-check
// A native conversation's row in the sidebar, end to end in the real app (native is the default): its menu marks it unread
// (a dot in the theme's colour) and read again, and archives it (the row leaves the list for an Archived fold, whose
// rows offer to restore it). Both are kept in the window's storage, so they outlive a restart of the app; opening a
// conversation takes its mark off. Run with `bun run e2e:conversation --native` (every native*.spec.mjs).
import { expect, test } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeWorld } from './nativeWorld.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const {
  run,
  page,
  sleep,
  expectNothingLeft,
  start,
  stop,
  expectNoProblems,
  shot,
  reachSidebar,
  send,
  replyWith,
  newConversation,
  menuButtonOf,
} = createNativeWorld({ desktopRoot });

const rowOf = (title) => page().locator('[data-testid="native-sidebar-item"]').filter({ hasText: title });
const archivedToggle = () => page().getByTestId('native-sidebar-archived-toggle');

/** The menu item on screen: a menu that was closed may still be in the page, hidden, until its animation ends. */
const shown = (item) => page().locator(`[data-testid="${item}"]:visible`);

/** Every menu is shut: one that was picked from fades out for a moment. */
const noMenuOpen = () => expect(page().locator('[role="menu"]:visible')).toHaveCount(0);

/** Opens a row's menu (the button shows while the row is hovered) and picks one of its items by test id. */
async function pick(title, item) {
  await noMenuOpen();
  await (await menuButtonOf(rowOf(title))).click();
  await shown(item).click();
  await noMenuOpen();
}

test('two conversations are made', async () => {
  await start();
  await reachSidebar();
  await newConversation();
  await send('E2E:ECHO ROWS-ONE');
  await replyWith('ROWS-ONE');
  await newConversation();
  await send('E2E:ECHO ROWS-TWO');
  await replyWith('ROWS-TWO');
  await expect(rowOf('ROWS-ONE')).toHaveCount(1, { timeout: 30_000 });
  await expect(rowOf('ROWS-TWO')).toHaveCount(1);
  await expect(archivedToggle()).toHaveCount(0);
  expectNoProblems();
});

test('the menu marks a conversation unread, painted, and read again', async () => {
  // The run in ROWS-ONE ended while ROWS-TWO was on screen, so mu may have marked it by itself (a second or so after
  // the run): let that come, then start from a row that is read.
  await sleep(2500);
  if ((await rowOf('ROWS-ONE').getAttribute('data-unread')) === 'true') await pick('ROWS-ONE', 'native-sidebar-mark');
  await expect(rowOf('ROWS-ONE')).not.toHaveAttribute('data-unread');
  await pick('ROWS-ONE', 'native-sidebar-mark');
  await expect(rowOf('ROWS-ONE')).toHaveAttribute('data-unread', 'true');
  const dot = rowOf('ROWS-ONE').getByTestId('native-sidebar-unread').locator('span');
  await expect(dot).toHaveCSS('background-color', /^rgb\(\d+, \d+, \d+\)$/);
  await shot('rows-unread');
  // The menu now offers the other way.
  await (await menuButtonOf(rowOf('ROWS-ONE'))).click();
  await expect(shown('native-sidebar-mark')).toContainText('已读');
  await shown('native-sidebar-mark').click();
  await expect(rowOf('ROWS-ONE')).not.toHaveAttribute('data-unread');
  // Marked again for the restart below.
  await pick('ROWS-ONE', 'native-sidebar-mark');
  await expect(rowOf('ROWS-ONE')).toHaveAttribute('data-unread', 'true');
  expectNoProblems();
});

test('the menu archives a conversation: the row leaves the list and the Archived fold has it', async () => {
  await pick('ROWS-TWO', 'native-sidebar-archive');
  await expect(rowOf('ROWS-TWO')).toHaveCount(0);
  await expect(archivedToggle()).toContainText('(1)');
  await expect(archivedToggle()).toHaveAttribute('aria-expanded', 'false');
  await archivedToggle().click();
  await expect(rowOf('ROWS-TWO')).toHaveAttribute('data-archived', 'true');
  await shot('rows-archived');
  await archivedToggle().click();
  await expect(rowOf('ROWS-TWO')).toHaveCount(0);
  expectNoProblems();
});

test('a restart keeps both: the mark, and the archive', async () => {
  await stop();
  await start();
  await reachSidebar();
  await expect(rowOf('ROWS-ONE')).toHaveAttribute('data-unread', 'true', { timeout: 30_000 });
  await expect(rowOf('ROWS-TWO')).toHaveCount(0);
  await expect(archivedToggle()).toContainText('(1)');
  expectNoProblems();
});

test('opening a marked conversation takes its mark off, and the Archived fold restores a conversation', async () => {
  const p = page();
  await rowOf('ROWS-ONE').click();
  await expect(p.getByTestId('native-conversation')).toBeVisible({ timeout: 30_000 });
  await expect(rowOf('ROWS-ONE')).not.toHaveAttribute('data-unread');

  await archivedToggle().click();
  await expect(rowOf('ROWS-TWO')).toHaveAttribute('data-archived', 'true');
  // An archived row's menu: no pin, no mark, no archive; it restores.
  await (await menuButtonOf(rowOf('ROWS-TWO'))).click();
  await expect(shown('native-sidebar-restore')).toBeVisible();
  await expect(shown('native-sidebar-pin')).toHaveCount(0);
  await expect(shown('native-sidebar-mark')).toHaveCount(0);
  await expect(shown('native-sidebar-archive')).toHaveCount(0);
  await shown('native-sidebar-restore').click();
  await expect(archivedToggle()).toHaveCount(0);
  await expect(rowOf('ROWS-TWO')).not.toHaveAttribute('data-archived');
  await expect(rowOf('ROWS-TWO')).toHaveCount(1);
  expectNoProblems();
});

test('the test stayed in its profile, and left nothing running', async () => {
  await stop();
  expectNoProblems();
  await expectNothingLeft();
  run.passed = true;
});
