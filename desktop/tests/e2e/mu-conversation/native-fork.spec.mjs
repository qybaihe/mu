// @ts-check
// Forking a conversation, end to end, in the real app on the native host (on by default): the button under a
// message forks pi's session there. Under the person's second message it makes a session of everything before it and
// brings the message back into the send box, to edit; the conversation goes on in the fork (the route follows its new
// id) and the old session stays in the sidebar as a conversation of its own, whole, with both turns. Under mu's last
// reply it clones the branch. While a run goes there is no button. Each fork is a real session file of pi's, with the
// file it came from as its `parentSession`. Run with `bun run e2e:conversation --native` (every native*.spec.mjs).
import { expect, test } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeWorld } from './nativeWorld.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const {
  run,
  page,
  paths,
  sleep,
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

/** The text of a message's content: a string, or the text parts of an array. */
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (content ?? []).map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('');

/** Every session file pi wrote in the profile: its path, its header and the texts of the person's messages. */
function sessions() {
  const root = join(paths().agentDir, 'sessions');
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((folder) => {
    const dir = join(root, folder);
    if (!statSync(dir).isDirectory()) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => {
        const file = join(dir, name);
        const lines = readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const messages = lines.filter((entry) => entry.type === 'message').map((entry) => entry.message);
        return {
          file,
          header: lines[0],
          users: messages.filter((message) => message.role === 'user').map((message) => textOf(message.content)),
          replies: messages.filter((message) => message.role === 'assistant').length,
        };
      });
  });
}

const rows = () => page().getByTestId('native-sidebar-item');
const box = () => page().getByTestId('native-send-input');
const forkButton = (row) => row.getByTestId('message-fork-button');

/**
 * Puts the pointer over a message until the row under it shows its buttons (they show while the pointer is over the
 * message; a row that moves under the pointer, as the list settles, loses it), and clicks the fork button.
 */
async function forkFrom(row) {
  await expect(async () => {
    await row.getByTestId('message-text-content').hover();
    await expect(forkButton(row)).toHaveCSS('opacity', '1', { timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await forkButton(row).click();
}
const conversationId = () => /#\/conversation\/native\/([^/?#]+)/.exec(page().url())?.[1] ?? '';

test('two turns are asked and answered', async () => {
  await start();
  await reachSidebar();
  await newConversation();
  await send('E2E:ECHO ALPHA-ONE');
  await replyWith('ALPHA-ONE');
  await send('E2E:ECHO BETA-TWO');
  await replyWith('BETA-TWO');
  await expect(userRows()).toHaveCount(2);
  const [only] = sessions();
  expect(sessions()).toHaveLength(1);
  expect(only.users).toEqual(['E2E:ECHO ALPHA-ONE', 'E2E:ECHO BETA-TWO']);
  expectNoProblems();
});

test('the button under the person’s second message forks before it: the message comes back into the box', async () => {
  const before = conversationId();
  const second = userRows().nth(1);
  // The buttons under a message show while the pointer is over the message itself (not the empty width of its row).
  await second.getByTestId('message-text-content').hover();
  await expect(forkButton(second)).toBeVisible();
  await shot('fork-button');
  await forkFrom(second);
  // The conversation goes on in the fork: its route changes, the page stays, and the second message is in the box.
  await expect.poll(conversationId, { timeout: 30_000 }).not.toBe(before);
  await expect(box()).toHaveValue('E2E:ECHO BETA-TWO', { timeout: 30_000 });
  await expect(userRows()).toHaveCount(1);
  await expect(userRows().first()).toContainText('ALPHA-ONE');
  await expect(replies().filter({ hasText: 'BETA-TWO' })).toHaveCount(0);
  // The old session is in the sidebar as a conversation of its own, next to the fork.
  await expect(rows()).toHaveCount(2, { timeout: 30_000 });
  await shot('forked');
  // Two files: the old session whole, and the fork of its first turn, with the old file as its parent.
  await expect.poll(() => sessions().length, { timeout: 30_000 }).toBe(2);
  const [old, fork] = sessions().toSorted((a, b) => b.users.length - a.users.length);
  expect(old.users).toEqual(['E2E:ECHO ALPHA-ONE', 'E2E:ECHO BETA-TWO']);
  expect(fork.users).toEqual(['E2E:ECHO ALPHA-ONE']);
  expect(fork.header.parentSession).toBe(old.file);
  expect(conversationId()).toBe(fork.header.id);
  expectNoProblems();
});

test('the old session opens whole from the sidebar, and its own second turn is still there', async () => {
  const p = page();
  const old = sessions().toSorted((a, b) => b.users.length - a.users.length)[0];
  await p.locator(`[data-testid="native-sidebar-item"][data-id="${old.header.id}"]`).click();
  await expect.poll(conversationId, { timeout: 30_000 }).toBe(old.header.id);
  await expect(userRows()).toHaveCount(2, { timeout: 30_000 });
  await expect(replies().filter({ hasText: 'BETA-TWO' }).first()).toBeVisible();
  expectNoProblems();
});

test('the button under the last reply clones the branch, and puts nothing into the box', async () => {
  const p = page();
  const parent = sessions().find((one) => one.header.id === conversationId());
  expect(parent, 'the conversation on screen is a session file').toBeDefined();
  const reply = p.getByTestId('native-message-assistant').last();
  await expect(forkButton(reply)).toBeAttached();
  const before = conversationId();
  const known = new Set(sessions().map((one) => one.file));
  await forkFrom(reply);
  await expect.poll(conversationId, { timeout: 30_000 }).not.toBe(before);
  await expect(box()).toHaveValue('');
  // The clone shows what the branch had, and the session it was made from is still a row of its own.
  await expect(userRows()).toHaveCount(2);
  await expect(rows()).toHaveCount(3, { timeout: 30_000 });
  await expect.poll(() => sessions().length, { timeout: 30_000 }).toBe(3);
  // The new file, made from the session on screen: all of its branch, as it stood.
  const clone = sessions().find((one) => !known.has(one.file));
  expect(clone?.header.parentSession).toBe(parent?.file);
  expect(clone?.users).toEqual(parent?.users);
  expect(clone?.replies).toBe(parent?.replies);
  expectNoProblems();
});

test('no button while a run goes', async () => {
  const p = page();
  await send('E2E:SLOW keep going');
  await expect(status()).toHaveAttribute('data-status', /^(working|thinking)$/, { timeout: 60_000 });
  await expect(p.getByTestId('message-fork-button')).toHaveCount(0);
  await p.getByTestId('native-abort').click();
  await expect(status()).toHaveAttribute('data-status', /^(aborted|settled)$/, { timeout: 60_000 });
  await sleep(300);
  await expect(p.getByTestId('message-fork-button').first()).toBeAttached();
  expectNoProblems();
});

test('the test stayed in its profile, and left nothing running', async () => {
  await stop();
  expectNoProblems();
  await expectNothingLeft();
  run.passed = true;
});
