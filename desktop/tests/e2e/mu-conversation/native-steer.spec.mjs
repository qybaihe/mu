// @ts-check
// Interjecting in a run, end to end, in the real app on the native host (on by default): a message sent while a run
// goes is not lost and does not start a second run. It waits in pi's queue, above the send box, as a steer (at the run's
// next step) or a follow-up (after the run); "Take back" puts the queued texts into the box, and the run goes on as it
// was. A steer left in the queue is delivered when the run ends, and answered. The slow reply of the fake model
// (`E2E:SLOW`, one chunk every 200 ms) keeps the run going long enough to type into. Run with
// `bun run e2e:conversation --native` (every native*.spec.mjs).
import { expect, test } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeWorld } from './nativeWorld.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const {
  run,
  page,
  sleep,
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
  runEnds,
  replyWith,
  newConversation,
} = createNativeWorld({ desktopRoot });

const queue = () => page().getByTestId('native-queue');

/** Types into the send box and sends while a run goes: the person's row does not show (the message waits in the queue). */
async function interject(text) {
  const box = page().getByTestId('native-send-input');
  await box.click();
  await box.fill(text);
  await page().getByTestId('native-send').click();
}

/** Waits until the slow reply has streamed `chunk` of its chunks: the run goes and can be typed into. */
async function slowReplyReaches(chunk) {
  await expect(
    replies()
      .filter({ hasText: `SLOW-${String(chunk).padStart(3, '0')}` })
      .first()
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(status()).toHaveAttribute('data-status', /^(working|thinking)$/);
}

test('a steer and a follow-up wait in the queue while the run goes, and "Take back" puts them in the box', async () => {
  await start();
  await reachSidebar();
  await newConversation();
  const p = page();
  await send('E2E:SLOW first run');
  await slowReplyReaches(3);
  await expect(p.getByTestId('native-send-mode')).toBeVisible();

  await interject('E2E:ECHO STEERED-OK');
  await expect(queue()).toContainText('STEERED-OK', { timeout: 15_000 });
  // The message waits: the transcript has the person's first message only, and the run was not restarted.
  await expect(userRows()).toHaveCount(1);
  await expect(p.getByTestId('native-abort')).toBeVisible();

  // The second is left for after the run: the switch beside the box.
  await p.getByTestId('native-send-mode').locator('.arco-radio-button').nth(1).click();
  await interject('E2E:ECHO AFTER-OK');
  await expect(queue()).toContainText('AFTER-OK', { timeout: 15_000 });
  await expect(queue().locator('span.truncate')).toHaveCount(2);
  await shot('queued');

  // Taking them back: the queue is gone, both texts are in the box, the run goes on.
  await p.getByTestId('native-queue-take-back').click();
  await expect(queue()).toHaveCount(0);
  const box = p.getByTestId('native-send-input');
  await expect(box).toHaveValue(/STEERED-OK[\s\S]*AFTER-OK/);
  await expect(status()).toHaveAttribute('data-status', /^(working|thinking)$/);
  await shot('taken-back');
  expectNoProblems();
});

test('a steer left in the queue is delivered when the run ends, and answered', async () => {
  const p = page();
  // Stop the first run (the queue is empty): with text in the box the button sends, so the box is cleared first.
  await p.getByTestId('native-send-input').fill('');
  await p.getByTestId('native-abort').click();
  await runEnds(/^aborted$/);
  expect(
    requests().filter((request) => request.scenario === 'echo'),
    'nothing taken back was ever sent'
  ).toEqual([]);

  const users = await userRows().count();
  await send('E2E:SLOW second run');
  await slowReplyReaches(3);
  // Steer mode is the default for each run: the switch shows `steer`.
  await interject('E2E:ECHO STEERED-OK');
  await expect(queue()).toContainText('STEERED-OK', { timeout: 15_000 });
  await expect(userRows()).toHaveCount(users + 1);
  // The run ends by itself (150 chunks, 200 ms apart): the queued message is delivered, and answered.
  await replyWith('STEERED-OK', 90_000);
  await expect(queue()).toHaveCount(0);
  await expect(userRows()).toHaveCount(users + 2);
  await expect(userRows().last()).toContainText('STEERED-OK');
  const asked = requests().findLast((request) => request.scenario === 'echo');
  expect(asked?.lastUser, 'the model was asked with the steered message').toContain('STEERED-OK');
  await shot('steer-answered');
  expectNoProblems();
});

test('the test stayed in its profile, and left nothing running', async () => {
  await stop();
  expectNoProblems();
  await expectNothingLeft();
  run.passed = true;
});
