// @ts-check
// The thinking level picked on the home page, end to end, in the real app on the native host (on by default): mu's
// default model reasons, the home page's pill opens it to its levels, and "high" picked there is the level the
// conversation starts with (its chip says it, and the model is asked with `reasoning_effort: high`). The pill shows a
// level whether or not one was picked: a start without a pick leaves mu's own (checked in the DOM tests, not here).
// Run with `bun run e2e:conversation --native` (every native*.spec.mjs).
import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAIN_TEXT } from './fakeModel.mjs';
import { createNativeWorld, THINKING_MODEL_ID } from './nativeWorld.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const {
  run,
  page,
  paths,
  sleep,
  requests,
  start,
  stop,
  expectNoProblems,
  expectNothingLeft,
  shot,
  reachSidebar,
  replyWith,
} = createNativeWorld({ desktopRoot });

test('the level picked on the home page is the one the conversation starts with', async () => {
  // The model that reasons is mu's default here: the pill of the home page offers its levels (the levels it lists are the
  // ones mu's default model reported, as in the classic home page).
  writeFileSync(
    join(paths().agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'e2e', defaultModel: THINKING_MODEL_ID })
  );
  await start();
  const p = page();
  await reachSidebar();
  await p.waitForURL(/#\/guid/);
  // A folder: the system's picker cannot be driven, the world answers it with the test's project.
  await p.getByTestId('workspace-selector-btn').click();
  const box = p.getByTestId('guid-input');
  await box.click();
  await box.fill('E2E:PLAIN 首页选的思考强度');
  const pill = p.getByTestId('guid-model-selector');
  await expect(pill).toContainText(THINKING_MODEL_ID, { timeout: 60_000 });
  await pill.click();
  const thinker = p.locator(`[data-testid="composer-model-option"][data-value="e2e/${THINKING_MODEL_ID}"]`);
  await expect(thinker).toBeVisible();
  await thinker.hover();
  const high = p.locator('[data-testid="composer-level-option"][data-value="high"]');
  await expect(high).toBeVisible();
  await sleep(400);
  await shot('home-level-menu');
  await high.click();
  await expect(pill).toContainText('高');
  await box.press('Enter');
  await p.waitForURL(/#\/conversation\/native\//, { timeout: 60_000 });
  await replyWith(PLAIN_TEXT, 90_000);
  const chip = p.getByTestId('native-model-chip');
  await expect(chip).toHaveAttribute('data-model', `e2e/${THINKING_MODEL_ID}`);
  await expect(chip).toHaveAttribute('data-level', 'high');
  const asked = requests().findLast((request) => request.scenario === 'plain');
  expect(asked, 'the model was asked with the level picked on the home page').toMatchObject({
    model: THINKING_MODEL_ID,
    reasoningEffort: 'high',
  });
  expectNoProblems();
});

test('the test stayed in its profile, and left nothing running', async () => {
  await stop();
  expectNoProblems();
  await expectNothingLeft();
  run.passed = true;
});
