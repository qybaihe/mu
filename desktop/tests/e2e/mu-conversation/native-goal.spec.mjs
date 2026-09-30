// @ts-check
// What round 2 of the native parity added to the conversation page, end to end in the real app on the native host
// (native is the default): the image the person sent in their row (live, and after a quit and a new start, from the session
// file), the context ring beside the send button after a run, the title renamed in the header (the sidebar row and pi's
// session file take the name), and mu's goal line: `/goal <condition>` shows it, a stop pauses it, a reopened
// conversation shows it paused from the file with no host, and ending it from the line clears it. Pictures, light and
// dark, go to the profile's logs. Run with `node scripts/kyrn/e2e-conversation.mjs --native -- native-goal.spec`.
//
// The steps run in order and share one app and one conversation: a failed step skips the ones after it.
import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
  newConversation,
} = createNativeWorld({ desktopRoot });

/** A 1×1 PNG: the image the test sends. */
const PICTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const NEW_NAME = '图片和目标';
const GOAL = 'E2E:SLOW 慢慢写完这一段';

/** What the steps share: the conversation's id (its session's), and its session file. */
const made = { id: '', file: '' };

const line = () => page().getByTestId('composer-goal-line');
const ring = () => page().getByTestId('native-context-usage');
const title = () => page().getByTestId('native-header-title');
const row = (id) => page().locator(`[data-testid="native-sidebar-item"][data-id="${id}"]`);

/** A picture in the light theme and one in the dark theme. */
async function shots(name) {
  await shot(name);
  await page().getByTestId('theme-toggle').click();
  await sleep(400);
  await shot(`${name}-dark`);
  await page().getByTestId('theme-toggle').click();
  await sleep(400);
}

/** The session file of `id` under mu's session folders. */
function sessionFile(id) {
  const root = join(paths().agentDir, 'sessions');
  for (const folder of readdirSync(root)) {
    const dir = join(root, folder);
    if (!statSync(dir).isDirectory()) continue;
    const found = readdirSync(dir).find((name) => name.endsWith(`_${id}.jsonl`));
    if (found) return join(dir, found);
  }
  return '';
}

/** The session file's entries. */
const entries = () =>
  readFileSync(made.file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((text) => JSON.parse(text));

test('an image sent with a message shows in the person’s row; the context ring shows after the run', async () => {
  // Every model takes images here, so the image reaches pi's message as itself.
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
  await newConversation();
  const p = page();
  // Nothing ran: pi has not said how full the context is.
  await expect(ring()).toHaveCount(0);

  const image = join(paths().root, 'pixel.png');
  writeFileSync(image, PICTURE);
  await p.getByTestId('native-attach-input').setInputFiles([image]);
  await expect(p.getByTestId('native-attachment')).toHaveCount(1);
  await send('E2E:PLAIN 这张图是什么颜色？');
  await replyWith('PLAIN-REPLY-OK');
  const asked = requests().findLast((request) => request.lastUser.includes('这张图是什么颜色'));
  expect(asked?.images, 'the image went to the model as itself').toBe(1);
  const pictures = userRows().last().getByTestId('native-message-image');
  await expect(pictures).toHaveCount(1);
  await expect(pictures.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  made.id = decodeURIComponent(p.url().split('/conversation/native/')[1] ?? '');
  expect(made.id).not.toBe('');

  // After the run pi said how full the context is: the ring shows, against the model's window.
  await expect(ring()).toBeVisible({ timeout: 15_000 });
  expect(Number(await ring().getAttribute('data-tokens'))).toBeGreaterThan(0);
  expect(Number(await ring().getAttribute('data-window'))).toBeGreaterThan(0);
  await shots('image-and-ring');
  // Its numbers on hover (the popover of mu's other conversations), for a look.
  await ring().locator('.context-usage-indicator').hover();
  await sleep(800);
  await shot('ring-hovered');
  await p.mouse.move(0, 0);
  await sleep(600);
  expectNoProblems();
});

test('the header renames the conversation: the sidebar row and pi’s session file take the name', async () => {
  const p = page();
  await title().click();
  const field = p.getByTestId('native-header-title-input');
  await expect(field).toBeVisible();
  // Esc leaves the title as it was.
  await field.fill('不要这个名字');
  await field.press('Escape');
  await expect(field).toBeHidden();
  await expect(title()).not.toContainText('不要这个名字');

  await title().click();
  await field.fill(NEW_NAME);
  // One picture only: the theme's switch is a click elsewhere, which leaves the field (and saves it).
  await shot('header-rename');
  await field.press('Enter');
  await expect(field).toBeHidden();
  await expect(title()).toHaveText(NEW_NAME);
  await expect(row(made.id)).toContainText(NEW_NAME);
  // The field in the dark theme, left with Esc.
  await p.getByTestId('theme-toggle').click();
  await sleep(400);
  await title().click();
  await expect(field).toHaveValue(NEW_NAME);
  await shot('header-rename-dark');
  await field.press('Escape');
  await expect(field).toBeHidden();
  await p.getByTestId('theme-toggle').click();
  await sleep(400);
  made.file = sessionFile(made.id);
  expect(made.file, 'pi saved the conversation').not.toBe('');
  // The host is live: pi named its session and saved the name as a session_info entry.
  await expect
    .poll(() => entries().findLast((entry) => entry.type === 'session_info')?.name, { timeout: 15_000 })
    .toBe(NEW_NAME);
  expectNoProblems();
});

test('/goal shows the goal line while mu works on it; a stop pauses it', async () => {
  const p = page();
  const box = p.getByTestId('native-send-input');
  await box.click();
  await box.fill(`/goal ${GOAL}`);
  await p.getByTestId('native-send').click();
  await expect(line()).toBeVisible({ timeout: 60_000 });
  await expect(line()).toHaveAttribute('data-status', 'active');
  await expect(p.getByTestId('composer-goal-text')).toContainText(GOAL);
  // The goal's run goes (the fake model writes slowly), and the command is not left on its way as a message.
  await expect(status()).toHaveAttribute('data-status', /^(working|thinking)$/, { timeout: 30_000 });
  await expect(status()).toHaveAttribute('data-sending', 'false');
  await shots('goal-active');

  await p.getByTestId('native-abort').click();
  await expect(status()).toHaveAttribute('data-status', 'aborted', { timeout: 30_000 });
  // mu pauses a goal whose run the person stopped.
  await expect(line()).toHaveAttribute('data-status', 'paused', { timeout: 30_000 });
  await shot('goal-paused');
  await expect
    .poll(() => entries().findLast((entry) => entry.customType === 'kyrn.goal')?.data?.status, { timeout: 15_000 })
    .toBe('paused');
  expectNoProblems();
});

test('after a quit and a new start, the conversation read from its file shows the image, the name and the goal', async () => {
  await stop();
  await start();
  await reachSidebar();
  const p = page();
  await expect(row(made.id)).toContainText(NEW_NAME, { timeout: 30_000 });
  await row(made.id).click();
  await expect(p.getByTestId('native-conversation')).toBeVisible();
  // Read from the file: no host runs.
  await expect(p.getByTestId('native-header-phase')).toHaveAttribute('data-phase', 'idle');
  await expect(title()).toHaveText(NEW_NAME);
  await expect(p.getByTestId('native-message-image')).toHaveCount(1);
  await expect(line()).toHaveAttribute('data-status', 'paused');
  await expect(p.getByTestId('composer-goal-text')).toContainText(GOAL);
  // pi has not said how full the context is since the start: no ring.
  await expect(ring()).toHaveCount(0);
  await shots('reopened');
  expectNoProblems();
});

test('ending the goal from its line clears it', async () => {
  const p = page();
  await p.getByTestId('composer-goal-end').click();
  // The command starts mu, which resumes the session and clears the goal.
  await expect(line()).toHaveCount(0, { timeout: 60_000 });
  await expect
    .poll(() => entries().findLast((entry) => entry.customType === 'kyrn.goal')?.data?.status, { timeout: 15_000 })
    .toBe('cleared');
  await expect(p.getByTestId('native-header-phase')).toHaveAttribute('data-phase', 'running');
  await shot('goal-ended');
  expectNoProblems();
});

test('the app quits and leaves nothing running', async () => {
  await stop();
  expectNoProblems();
  await expectNothingLeft();
  run.passed = true;
});
