// @ts-check
// What happens to a native conversation when its process goes away without being asked: the app quits in the middle of a
// run, or the host is killed. The conversation must come back with what it had, the screen must not stay "working", and
// the next message must start a host again (resuming the session file). Same world as native.spec.mjs (nativeWorld.mjs).
import { expect, test } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeWorld } from './nativeWorld.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const {
  run,
  page,
  sleep,
  userRows,
  replies,
  status,
  noteProcesses,
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

/**
 * The hosts the app runs now: its Electron utility processes that run node (the network service is not one), asked of
 * Electron itself. The process table cannot say: on Linux a host names itself with process.title, which replaces its
 * command line there.
 */
async function hostProcesses() {
  const app = run.state?.app;
  if (!app) return [];
  const metrics = await app.evaluate(({ app: electron }) =>
    electron.getAppMetrics().map(({ pid, type, serviceName }) => ({ pid, type, serviceName }))
  );
  return metrics.filter((entry) => entry.type === 'Utility' && entry.serviceName === 'node.mojom.NodeService');
}

test('a conversation exists with one answered message, so its session has a file', async () => {
  await start();
  await reachSidebar();
  await newConversation();
  await send('E2E:PLAIN 先答一句。');
  await runEnds(/^settled$/);
  await replyWith('PLAIN-REPLY-OK');
  expect(await hostProcesses(), 'one host runs for the conversation').toHaveLength(1);
  expectNoProblems();
});

test('quitting the app in the middle of a run leaves nothing running, and the conversation comes back', async () => {
  await send('E2E:SLOW 请慢慢说。');
  await expect(replies().filter({ hasText: 'SLOW-001' }).last()).toContainText('SLOW-004', { timeout: 60_000 });
  await noteProcesses();
  await stop();
  await expectNothingLeft();

  await start();
  const p = page();
  await reachSidebar();
  await expect(p.getByTestId('native-sidebar-item')).toHaveCount(1);
  await p.getByTestId('native-sidebar-item').click();
  await expect(p.getByTestId('native-conversation')).toBeVisible();
  // What was saved before the quit is there; the run that was cut is not shown as still going.
  await expect(replies().filter({ hasText: 'PLAIN-REPLY-OK' }).first()).toBeVisible({ timeout: 30_000 });
  await expect(p.getByTestId('native-abort')).toHaveCount(0);
  await expect(status()).not.toHaveAttribute('data-status', /^(working|thinking)$/);
  await shot('after-quit-mid-run');

  await send('E2E:ECHO AFTER-QUIT-OK');
  await replyWith('AFTER-QUIT-OK');
  expectNoProblems();
});

test('a host that is killed in the middle of a run: the screen says mu stopped, nothing hangs, the next message starts it again', async () => {
  const p = page();
  await send('E2E:SLOW 请慢慢说。');
  await expect(replies().filter({ hasText: 'SLOW-001' }).last()).toContainText('SLOW-004', { timeout: 60_000 });
  const hosts = await hostProcesses();
  expect(hosts, 'one host runs for the conversation').toHaveLength(1);
  process.kill(hosts[0].pid, 'SIGKILL');

  await expect(p.getByTestId('native-failed')).toBeVisible({ timeout: 30_000 });
  await expect(p.getByTestId('native-failed')).toHaveAttribute('data-kind', 'crashed');
  await expect(p.getByTestId('native-header-phase')).toHaveAttribute('data-phase', 'failed');
  // The run that was going is over for the screen: no stop button, no "working".
  await expect(p.getByTestId('native-abort')).toHaveCount(0, { timeout: 15_000 });
  await expect(status()).not.toHaveAttribute('data-status', /^(working|thinking)$/);
  await expect(p.getByTestId('native-send-input')).toBeEnabled();
  await shot('after-host-killed');
  // What had come was not lost from the screen.
  await expect(replies().filter({ hasText: 'PLAIN-REPLY-OK' }).first()).toBeVisible();
  await expect(userRows().last()).toContainText('E2E:SLOW');

  await send('E2E:ECHO AFTER-KILL-OK');
  await replyWith('AFTER-KILL-OK');
  await expect(p.getByTestId('native-failed')).toHaveCount(0);
  await expect(p.getByTestId('native-header-phase')).toHaveAttribute('data-phase', 'running');
  expect(await hostProcesses(), 'a new host runs, the killed one is gone').toHaveLength(1);
  await sleep(300);
  expectNoProblems();
});

test('the app quits with nothing left running', async () => {
  await stop();
  await expectNothingLeft();
  run.passed = true;
});
