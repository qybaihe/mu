// @ts-check
// Two native conversations at once, end to end, in the real app on the native host (on by default): a long run goes in
// one while a second conversation is made and answered in the same window, and the first is opened again while it is
// still running. Each conversation has a host of its own: the second one's messages never show in the first's page (or the
// other way round), the first goes on streaming while it is out of sight, and the sidebar lists both with their hosts'
// green dots. The slow reply of the fake model (`E2E:SLOW`) keeps the first run going. Run with
// `bun run e2e:conversation --native` (every native*.spec.mjs).
import { expect, test } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAIN_TEXT } from './fakeModel.mjs';
import { createNativeWorld } from './nativeWorld.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const {
  run,
  page,
  requests,
  userRows,
  replies,
  status,
  expectNothingLeft,
  start,
  stop,
  expectNoProblems,
  shot,
  reachSidebar,
  send,
  replyWith,
  newConversation,
} = createNativeWorld({ desktopRoot });

const rowOf = (text) => page().getByTestId('native-sidebar-item').filter({ hasText: text });
const chunk = (number) => `SLOW-${String(number).padStart(3, '0')}`;

test('a second conversation is made and answered while the first one’s run goes', async () => {
  await start();
  await reachSidebar();
  await newConversation();
  await send('E2E:SLOW alpha');
  await expect(
    replies()
      .filter({ hasText: chunk(3) })
      .first()
  ).toBeVisible({ timeout: 60_000 });

  // A second conversation, in the same window, while the first goes on in its own host.
  await newConversation();
  const p = page();
  await expect(userRows()).toHaveCount(0);
  await send('E2E:PLAIN beta');
  await replyWith(PLAIN_TEXT);
  // Its page shows its own messages only.
  await expect(userRows()).toHaveCount(1);
  await expect(userRows().first()).toContainText('beta');
  await expect(p.getByTestId('native-message-assistant').filter({ hasText: 'SLOW-' })).toHaveCount(0);
  // Both are listed, both have a host running.
  await expect(p.getByTestId('native-sidebar-item')).toHaveCount(2);
  await expect(rowOf('alpha').locator('[aria-label]').first()).toBeVisible();
  await shot('two-conversations');
  expectNoProblems();
});

test('the first conversation, opened again, has streamed on meanwhile and finishes', async () => {
  const p = page();
  await rowOf('alpha').click();
  await expect(userRows()).toHaveCount(1);
  await expect(userRows().first()).toContainText('alpha');
  // It went on while out of sight: what it shows is well past the third chunk, and its own reply only.
  await expect(
    replies()
      .filter({ hasText: chunk(20) })
      .first()
  ).toBeVisible({ timeout: 30_000 });
  await expect(p.getByTestId('native-message-assistant').filter({ hasText: 'PLAIN' })).toHaveCount(0);
  await expect(status()).toHaveAttribute('data-status', /^(working|thinking)$/);
  await shot('first-again');
  // ...and it runs to its end (150 chunks, 200 ms apart).
  await expect(
    replies()
      .filter({ hasText: chunk(150) })
      .first()
  ).toBeVisible({ timeout: 90_000 });
  await expect(status()).toHaveAttribute('data-status', 'settled', { timeout: 30_000 });
  await expect(userRows()).toHaveCount(1);
  // The second one is as it was.
  await rowOf('beta').click();
  await expect(userRows()).toHaveCount(1);
  await expect(userRows().first()).toContainText('beta');
  await expect(replies().filter({ hasText: PLAIN_TEXT }).first()).toBeVisible();
  expect(requests().filter((request) => request.scenario === 'slow')).toHaveLength(1);
  expect(requests().filter((request) => request.scenario === 'plain')).toHaveLength(1);
  expectNoProblems();
});

test('the test stayed in its profile, and left nothing running', async () => {
  await stop();
  expectNoProblems();
  await expectNothingLeft();
  run.passed = true;
});
