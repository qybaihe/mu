// @ts-check
// The native send box's controls, end to end, in the real app on the native host (on by default): the model chip
// (a second model, then a thinking level on the model that reasons, each seen by the fake model), the permission pill
// (a switch from minimal to full access, and mu stops asking), pi's slash commands in the `/` menu, files and images
// attached (they reach the model's request), ↑ bringing back the last message, and a file mentioned with `@`.
// Pictures of the composer's states, light and dark, go to the profile's logs. Run with
// `node scripts/kyrn/e2e-conversation.mjs --native -- native-composer.spec`.
//
// The steps run in order and share one app and one conversation: a failed step skips the ones after it.
import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_API_KEY, FAKE_MODEL_ID } from './fakeModel.mjs';
import { createNativeWorld, SECOND_MODEL_ID, THINKING_MODEL_ID } from './nativeWorld.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const {
  run,
  page,
  paths,
  sleep,
  requests,
  replies,
  dialogs,
  start,
  stop,
  expectNoProblems,
  expectNothingLeft,
  shot,
  reachSidebar,
  send,
  replyWith,
  sendAndAnswer,
  newConversation,
} = createNativeWorld({ desktopRoot });

/** A 1×1 PNG: the image the test attaches. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const chip = () => page().getByTestId('native-model-chip');
const pill = () => page().getByTestId('native-permission-pill');
const modelOption = (id) => page().locator(`[data-testid="composer-model-option"][data-value="e2e/${id}"]`);

/** The last completion request whose last user message holds `text`. */
const requestWith = (text) => requests().findLast((request) => request.lastUser.includes(text));

/**
 * A picture in the light theme and one in the dark theme. The theme switch is a click elsewhere, which closes an open
 * menu: `open` opens it again (when it is not open) for the dark picture, and after the switch back.
 */
async function shots(name, open = async () => {}) {
  await open();
  await shot(name);
  await page().getByTestId('theme-toggle').click();
  await sleep(400);
  await open();
  await shot(`${name}-dark`);
  await page().getByTestId('theme-toggle').click();
  await sleep(400);
  await open();
}

/** Opens a menu with `trigger` unless `shown` already shows. */
const opener = (trigger, shown) => async () => {
  if (!(await shown().isVisible())) await trigger().click();
  await expect(shown()).toBeVisible();
};

test('a new conversation shows mu’s default model and the mode it was made in, before mu runs', async () => {
  // Every model takes images here, so an attached image reaches the request as itself.
  const provider = {
    baseUrl: run.fake?.baseUrl,
    api: 'openai-completions',
    apiKey: FAKE_API_KEY,
    models: [
      { id: FAKE_MODEL_ID, input: ['text', 'image'] },
      { id: SECOND_MODEL_ID, input: ['text', 'image'] },
      { id: THINKING_MODEL_ID, reasoning: true, input: ['text', 'image'] },
    ],
  };
  writeFileSync(join(paths().agentDir, 'models.json'), JSON.stringify({ providers: { e2e: provider } }));
  await start();
  await reachSidebar();
  await newConversation({ permissions: '最小权限' });
  const p = page();
  await expect(p.getByTestId('native-header-phase')).toHaveAttribute('data-phase', 'idle');
  // Nothing ran: no model is known yet (pi takes its default), and the mode is the one the conversation was made in.
  await expect(chip()).toHaveAttribute('data-model', '');
  await expect(chip()).toHaveAttribute('data-source', 'none');
  await expect(pill()).toHaveAttribute('data-mode', 'ask');
  await expect(p.getByTestId('native-attach')).toBeVisible();
  await shots('composer-idle');
  expectNoProblems();
});

test('the / menu lists pi’s commands', async () => {
  const p = page();
  const box = p.getByTestId('native-send-input');
  await box.click();
  await box.fill('/');
  // Typing a command starts mu, which lists its commands.
  // By the start of the row: a command's description may name another command.
  const option = p.getByRole('option', { name: /^\/permissions/ });
  await expect(option).toBeVisible({ timeout: 60_000 });
  await expect(p.getByRole('option', { name: /^\/lessons/ })).toBeVisible();
  await shot('slash-menu');
  await box.fill('');
  await expect(option).toHaveCount(0);
  await expect(p.getByTestId('native-header-phase')).toHaveAttribute('data-phase', 'running', { timeout: 60_000 });
  await expect(chip()).toHaveAttribute('data-model', `e2e/${FAKE_MODEL_ID}`);
  await expect(chip()).toHaveAttribute('data-source', 'host');
  expectNoProblems();
});

test('picking the second model: the model is asked with it', async () => {
  const p = page();
  await p.getByTestId('native-model-pill').click();
  await expect(modelOption(SECOND_MODEL_ID)).toBeVisible({ timeout: 30_000 });
  await expect(modelOption(THINKING_MODEL_ID)).toBeVisible();
  await shots(
    'model-menu',
    opener(
      () => p.getByTestId('native-model-pill'),
      () => modelOption(SECOND_MODEL_ID)
    )
  );
  await modelOption(SECOND_MODEL_ID).click();
  await expect(chip()).toHaveAttribute('data-model', `e2e/${SECOND_MODEL_ID}`);
  await send('E2E:ECHO MODEL-TWO-OK');
  await replyWith('MODEL-TWO-OK');
  expect(requestWith('MODEL-TWO-OK')?.model, 'the request went to the second model').toBe(SECOND_MODEL_ID);
  expectNoProblems();
});

test('a thinking level set on the model that reasons reaches the request', async () => {
  const p = page();
  await p.getByTestId('native-model-pill').click();
  const thinker = modelOption(THINKING_MODEL_ID);
  await expect(thinker).toBeVisible({ timeout: 30_000 });
  await thinker.hover();
  const high = p.locator('[data-testid="composer-level-option"][data-value="high"]');
  await expect(high).toBeVisible();
  // The menu of levels flies out of a chip at the bottom of the window: every level is inside the window, not below it.
  const levels = p.locator('[data-testid="composer-level-option"]');
  const inside = await levels.evaluateAll((items) =>
    items.map((item) => {
      const box = item.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= globalThis.innerHeight;
    })
  );
  expect(inside.length, 'the levels the model offers').toBeGreaterThan(2);
  expect(inside, 'every level shows inside the window').toEqual(inside.map(() => true));
  await shot('model-levels');
  await high.click();
  await expect(chip()).toHaveAttribute('data-model', `e2e/${THINKING_MODEL_ID}`);
  await expect(chip()).toHaveAttribute('data-level', 'high');
  await send('E2E:ECHO THINK-HIGH-OK');
  await replyWith('THINK-HIGH-OK');
  const asked = requestWith('THINK-HIGH-OK');
  expect(asked?.model).toBe(THINKING_MODEL_ID);
  expect(asked?.reasoningEffort, 'pi asked for the level the person picked').toBe('high');
  expectNoProblems();
});

test('switching the permission mode: mu asked before a write, and no longer does in full access', async () => {
  const p = page();
  const question = await sendAndAnswer('E2E:WRITE notes/asked.txt', 'first', 'WRITE-DONE');
  expect(question).toContain('notes/asked.txt');

  await p.getByTestId('native-permission').click();
  const full = () => p.locator('[data-testid="native-permission-option"][data-mode="full"]');
  await expect(full()).toBeVisible();
  await shots(
    'permission-menu',
    opener(() => p.getByTestId('native-permission'), full)
  );
  await full().click();
  await expect(pill()).toHaveAttribute('data-mode', 'full', { timeout: 30_000 });

  await send('E2E:WRITE notes/free.txt');
  // Look until the reply comes: no question may show on the way.
  let asked = 0;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- one look after another, until the reply comes
    const [shown, done] = await Promise.all([
      dialogs().count(),
      replies().filter({ hasText: 'notes/free.txt' }).count(),
    ]);
    asked = Math.max(asked, shown);
    if (done > 0) break;
    // eslint-disable-next-line no-await-in-loop -- one look after another, until the reply comes
    await sleep(100);
  }
  expect(asked, 'questions asked in full access').toBe(0);
  await replyWith('notes/free.txt');
  expect(existsSync(join(paths().project, 'notes', 'free.txt')), 'the write ran without a question').toBe(true);
  expectNoProblems();
});

test('an attached image and file reach the model’s request', async () => {
  const p = page();
  const image = join(paths().root, 'pixel.png');
  writeFileSync(image, PIXEL);
  mkdirSync(join(paths().project, 'notes'), { recursive: true });
  const file = join(paths().project, 'notes', 'attach-me.md');
  writeFileSync(file, '# Attached by the E2E test\n');
  await p.getByTestId('native-attach-input').setInputFiles([image, file]);
  const chips = p.getByTestId('native-attachment');
  await expect(chips).toHaveCount(2);
  await expect(chips.first()).toHaveAttribute('data-kind', 'image');
  await expect(chips.last()).toHaveAttribute('data-kind', 'file');
  await shots('attachments');

  await send('E2E:ECHO ATTACH-OK');
  await replyWith('ATTACH-OK');
  await expect(chips).toHaveCount(0);
  const asked = requestWith('ATTACH-OK');
  expect(asked?.images, 'the image went as itself').toBe(1);
  expect(asked?.lastUser, 'the file went by its full path').toContain(file);
  await shot('attachments-sent');

  // ↑ in the empty box brings the last message back, without its files.
  const box = p.getByTestId('native-send-input');
  await box.click();
  await box.press('ArrowUp');
  await expect(box).toHaveValue('E2E:ECHO ATTACH-OK');
  await box.fill('');
  expectNoProblems();
});

test('a file mentioned with @ reaches the model by its full path', async () => {
  const p = page();
  const box = p.getByTestId('native-send-input');
  await box.click();
  await box.fill('E2E:ECHO MENTION-OK ');
  await box.pressSequentially('@attach-me');
  const option = p.getByRole('option', { name: /attach-me\.md/ });
  await expect(option).toBeVisible({ timeout: 30_000 });
  await shot('mention-menu');
  await option.click();
  await p.getByTestId('native-send').click();
  await replyWith('MENTION-OK');
  expect(requestWith('MENTION-OK')?.lastUser).toContain(join(paths().project, 'notes', 'attach-me.md'));
  expectNoProblems();
});

test('the app quits and leaves nothing running', async () => {
  await stop();
  expectNoProblems();
  await expectNothingLeft();
  run.passed = true;
});
