// @ts-check
// A first start on the native host (on by default): mu has no provider and no default model, as on a computer that
// has never signed in. A conversation can be made and opened; its message is not answered, and the screen says why and
// leads to the page where a model is set up (the guide's job): the host is `needs-model`, not a failure, and it stays
// so. Run with `bun run e2e:conversation --native` (every native*.spec.mjs).
import { expect, test } from '@playwright/test';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeWorld } from './nativeWorld.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const {
  run,
  page,
  paths,
  sleep,
  requests,
  status,
  start,
  stop,
  expectNoProblems,
  expectNothingLeft,
  shot,
  reachSidebar,
  newConversation,
} = createNativeWorld({ desktopRoot });

test('with no model, mu starts, says it has none, and the card leads to where one is set up', async () => {
  // The world gives mu the fake model: a first start has none.
  rmSync(join(paths().agentDir, 'models.json'), { force: true });
  rmSync(join(paths().agentDir, 'settings.json'), { force: true });
  await start();
  await reachSidebar();
  await newConversation();
  const p = page();
  await expect(p.getByTestId('native-header-phase')).toHaveAttribute('data-phase', 'idle');
  const box = p.getByTestId('native-send-input');
  await box.click();
  await box.fill('E2E:PLAIN hello');
  await p.getByTestId('native-send').click();
  // Sending starts mu, which finds no model.
  await expect(p.getByTestId('native-needs-model')).toBeVisible({ timeout: 60_000 });
  await expect(p.getByTestId('native-header-phase')).toHaveAttribute('data-phase', 'needs-model');
  await expect(p.getByTestId('native-model-chip')).toHaveAttribute('data-model', '');
  // The message was refused, not on its way: the send box is ready again (no "sending" strip, no stop button).
  await expect(status()).toHaveAttribute('data-sending', 'false', { timeout: 30_000 });
  await sleep(500);
  await shot('needs-model');
  expect(requests(), 'no model was asked').toEqual([]);
  expectNoProblems();
});

test('the card’s button opens the page where a model is set up', async () => {
  const p = page();
  await p.getByTestId('native-needs-model').getByRole('button').click();
  await p.waitForURL(/#\/settings\/providers/, { timeout: 15_000 });
  await sleep(500);
  await shot('providers-page');
  expectNoProblems();
});

test('the test stayed in its profile, and left nothing running', async () => {
  await stop();
  expectNoProblems();
  await expectNothingLeft();
  run.passed = true;
});
