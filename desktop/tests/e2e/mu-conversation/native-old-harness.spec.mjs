// @ts-check
// A mu too old to run inside the app, end to end in the real app. The native host is on by default, but only where the
// mu the app finds can run inside it: the packaged app carries the mu it was built with, and a launcher from before the
// native host has no `planHost`. Here the profile's copy of the launcher is made so. The app must carry on as it did
// before the native host: quietly on AionCore, with one line in the app's log saying why, no native group in
// the sidebar, and a message sent from the home page starting a conversation that the model answers. Run with
// `bun run e2e:conversation --native` (every native*.spec.mjs).
import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesUnder, logFolders } from './app.mjs';
import { PLAIN_TEXT } from './fakeModel.mjs';
import { createNativeWorld } from './nativeWorld.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// A packaged app runs the mu it carries, which is not the test's to change: this spec edits the profile's copy of a
// harness checkout's launcher.
test.skip(Boolean(process.env.MU_E2E_APP), 'needs a harness checkout, not the mu a packaged app carries');

const { run, page, sleep, start, stop, expectNoProblems, expectNothingLeft, noteProcesses, requests } =
  createNativeWorld({
    desktopRoot,
    prepare: (profile) => {
      const launcher = join(profile.harness.view, 'kyrn', 'bin', 'mu.mjs');
      // Only the profile's own copy of the launcher is changed: a harness that the profile links, or the mu a packaged
      // app carries, is not the test's to edit.
      if (!launcher.startsWith(profile.paths.root))
        throw new Error(`This spec needs the profile's copy of the launcher, not ${launcher}`);
      const text = readFileSync(launcher, 'utf8');
      expect(text).toContain('export function planHost(');
      // Kept for the classic path: the command line and the ACP adapter start mu through the same file, and still can.
      writeFileSync(launcher, text.replace('export function planHost(', 'function planHost('));
    },
  });

/**
 * What the app wrote to its logs: the main process's console goes to a daily file of electron-log (the profile's own
 * `Library/Logs` folder), not to the output the test reads.
 */
const appLog = () =>
  logFolders(run.profile)
    .flatMap(filesUnder)
    .filter((file) => file.endsWith('.log'))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
const classicReplies = () => page().locator('[data-testid="message-text-left"] .markdown-shadow-body');

test('the app starts on AionCore and says in its log why the native host stays off', async () => {
  await start();
  const p = page();
  const welcome = p.getByTestId('mu-welcome');
  const box = p.getByTestId('guid-input');
  await expect(welcome.or(box).first()).toBeVisible({ timeout: 60_000 });
  if (await welcome.isVisible().catch(() => false)) {
    await p.getByText('跳过引导', { exact: true }).click();
    await p.waitForURL(/#\/guid/);
  }
  await expect(box).toBeVisible();
  await expect.poll(appLog, { timeout: 30_000 }).toContain('[mu] the native host stays off: ');
  expect(appLog()).toMatch(
    /the native host stays off: This mu cannot run inside the app yet \(.*mu\.mjs has no planHost\)/
  );
  // The window asked, was told no, and shows nothing of the native host: no group, and the classic list's placeholder.
  await sleep(1000);
  await expect(p.getByTestId('native-sidebar-group')).toHaveCount(0);
  expectNoProblems();
});

test('a message sent from the home page starts a conversation on AionCore, and the model answers it', async () => {
  const p = page();
  await p.getByTestId('workspace-selector-btn').click();
  // With a recent folder the button opens a menu first; on a fresh profile it opens the picker right away.
  const other = p.getByText('选择其他目录', { exact: true });
  if (await other.isVisible().catch(() => false)) await other.click();
  await expect(p.getByText('project', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  const box = p.getByTestId('guid-input');
  await box.click();
  await box.fill('E2E:PLAIN a mu older than the native host');
  await box.press('Enter');
  await p.waitForURL(/#\/conversation\//, { timeout: 60_000 });
  expect(p.url()).not.toContain('/conversation/native/');
  await expect(classicReplies().filter({ hasText: PLAIN_TEXT }).first()).toBeVisible({ timeout: 90_000 });
  expect(requests().some((request) => request.scenario === 'plain')).toBe(true);
  await expect(p.getByTestId('native-sidebar-group')).toHaveCount(0);
  await noteProcesses();
  expectNoProblems();
});

test('the test stayed in its profile, and left nothing running', async () => {
  await stop();
  expectNoProblems();
  await expectNothingLeft();
  run.passed = true;
});
