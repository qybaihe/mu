// @ts-check
// The home page and the sidebar on the native host (on by default), end to end, in a throwaway profile
// (nativeWorld.mjs): the home page's send starts a native conversation in the folder picked there, its row is pinned,
// renamed and deleted from the sidebar (into a bin of the test's own), and the session files AionCore's conversations
// use are left out of the native list. The level picked on the home page is native-home-level.spec.mjs's. Run with
// `bun run e2e:conversation --native` (every native*.spec.mjs); the test ids read are the ones docs/native-host-ui.md
// lists.
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_MODEL_ID, PLAIN_TEXT } from './fakeModel.mjs';
import { createNativeWorld } from './nativeWorld.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const FIRST_MESSAGE = 'E2E:PLAIN 从首页开始的原生会话';
const NEW_NAME = '改过名字的会话';
const OLD_TITLE = 'E2E 别处的旧会话';
const BOUND_TITLE = 'E2E AionCore 在用的会话';
const IMPORTED_TITLE = 'E2E 导入的会话';
const CLI_TITLE = 'E2E 命令行刚做的会话';

const {
  run,
  page,
  paths,
  sleep,
  requests,
  stamp,
  expectNothingLeft,
  start,
  stop,
  expectNoProblems,
  shot,
  reachSidebar,
  replyWith,
  menuButtonOf,
} = createNativeWorld({ desktopRoot });

/** pi's folder name for a project's sessions. */
const slug = (cwd) => `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;

/**
 * The files this spec made before the start, and the conversation the home page makes: `bound` and `imported` are used
 * by AionCore's conversations (an adapter record, an import record), `free` is mu's own, in a folder of its own.
 * @type {{ elsewhere: string, free: { id: string, file: string }, bound: { id: string, file: string }, imported: { id: string, file: string }, records: string[], id: string, file: string, bin: string }}
 */
const made = {
  elsewhere: '',
  free: { id: '', file: '' },
  bound: { id: '', file: '' },
  imported: { id: '', file: '' },
  records: [],
  id: '',
  file: '',
  bin: '',
};

/** A finished session in pi's format (one question, one answer) in `cwd`, `minutes` ago. */
function writeSession(cwd, title, minutes) {
  const id = randomUUID();
  const time = Date.now() - minutes * 60_000;
  const iso = new Date(time).toISOString();
  const dir = join(paths().agentDir, 'sessions', slug(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${iso.replace(/[:.]/g, '-')}_${id}.jsonl`);
  const lines = [
    { type: 'session', version: 3, id, timestamp: iso, cwd },
    {
      type: 'message',
      id: 'a1b2c3d4',
      parentId: null,
      timestamp: iso,
      message: { role: 'user', content: [{ type: 'text', text: title }], timestamp: time },
    },
    {
      type: 'message',
      id: 'e5f6a7b8',
      parentId: 'a1b2c3d4',
      timestamp: iso,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'OK.' }],
        provider: 'e2e',
        model: FAKE_MODEL_ID,
        stopReason: 'stop',
        timestamp: time,
      },
    },
  ];
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  return { id, file };
}

const rows = () => page().getByTestId('native-sidebar-item');
const row = (id) => page().locator(`[data-testid="native-sidebar-item"][data-id="${id}"]`);

/** A picture once the menus and dialogs have finished their fade (Arco's take about 0.2 s). */
async function still(name) {
  await sleep(400);
  await shot(name);
}

/**
 * An item of the row menu that is open. Each row's menu stays in the page once it has been opened (hidden), so a test id
 * alone names one item per row that was ever opened.
 */
const menuItem = (name) => page().locator(`[data-testid="native-sidebar-${name}"]:visible`);

/** Opens a row's menu the way a person does: over the row, then its "…" button. */
async function openMenu(id) {
  await (await menuButtonOf(row(id))).click();
  await expect(menuItem('rename')).toBeVisible();
}

test('the native list leaves out the sessions AionCore’s conversations use', async () => {
  const { project, root, home } = paths();
  made.elsewhere = join(root, 'elsewhere');
  mkdirSync(made.elsewhere, { recursive: true });
  made.free = writeSession(made.elsewhere, OLD_TITLE, 30);
  made.bound = writeSession(project, BOUND_TITLE, 20);
  made.imported = writeSession(project, IMPORTED_TITLE, 10);
  // The ACP adapter's record (the session's id: its file, folder and permission mode) and an import's record, in
  // `<mu home>/acp-sessions`: the profile's home is the app's.
  const store = join(home, '.mu', 'acp-sessions');
  mkdirSync(join(store, 'imports'), { recursive: true });
  const adapter = join(store, `${made.bound.id}.json`);
  writeFileSync(adapter, JSON.stringify({ cwd: project, file: made.bound.file, permissions: 'full' }));
  const imports = join(store, 'imports', 'conversation-e2e.json');
  writeFileSync(
    imports,
    JSON.stringify({ version: 1, file: made.imported.file, cwd: project, tool: 'claude', source: '/nowhere.jsonl' })
  );
  made.records = [adapter, imports];
  run.untouched.push(
    ...[made.free.file, made.bound.file, made.imported.file, ...made.records].map((path) => ({
      path,
      before: stamp(path),
    }))
  );

  await start();
  const p = page();
  await reachSidebar();
  // mu's own session is listed; the two AionCore uses are not (they would show twice: here and as its conversations).
  await expect(rows()).toHaveCount(1);
  await expect(row(made.free.id)).toContainText(OLD_TITLE);
  // Its tooltip: the title, the folder, how many messages (the profile's language is Chinese).
  await expect(row(made.free.id)).toHaveAttribute('title', `${OLD_TITLE}\n${made.elsewhere}\n消息数：2`);
  await expect(p.getByTestId('native-sidebar-group')).not.toContainText(BOUND_TITLE);
  await expect(p.getByTestId('native-sidebar-group')).not.toContainText(IMPORTED_TITLE);
  expectNoProblems();
});

test('the home page starts a native conversation in the folder picked there, and it answers', async () => {
  const p = page();
  await p.waitForURL(/#\/guid/);
  const folders = p.getByTestId('workspace-selector-btn');
  // With a folder to offer the button opens a menu (its chevron shows); without one it would open the picker.
  await expect(folders.locator('.i-icon')).toBeVisible({ timeout: 15_000 });
  await folders.click();
  // The native conversations' folders are offered beside the recent ones. The menu is a portal of its own on the page
  // (the sidebar's row names the folder too); a built app's class names are hashed.
  const menu = p.locator('body > div', { hasText: '选择其他目录' });
  const offered = menu.getByText('elsewhere', { exact: true });
  await expect(offered).toBeVisible();
  await offered.click();
  const box = p.getByTestId('guid-input');
  await box.click();
  await box.fill(FIRST_MESSAGE);
  await shot('home-native');
  await box.press('Enter');

  await p.waitForURL(/#\/conversation\/native\//, { timeout: 60_000 });
  await expect(p.getByTestId('native-conversation')).toBeVisible();
  await replyWith(PLAIN_TEXT, 90_000);
  await expect(p.getByTestId('native-header-folder')).toContainText('elsewhere');
  // It opened under the id pi's session gave it, and is listed, newest first.
  expect(p.url()).not.toContain('draft-');
  made.id = decodeURIComponent(p.url().split('/conversation/native/')[1] ?? '');
  expect(made.id).not.toBe('');
  await expect(rows()).toHaveCount(2);
  await expect(rows().first()).toHaveAttribute('data-id', made.id);
  await expect(rows().first()).toHaveAttribute('aria-current', 'page');

  const plain = requests().find((request) => request.scenario === 'plain');
  expect(plain, 'the fake model was asked for the plain reply').toMatchObject({ model: FAKE_MODEL_ID, finished: true });
  const sessions = join(paths().agentDir, 'sessions', slug(made.elsewhere));
  const file = readdirSync(sessions).find((name) => name.endsWith(`_${made.id}.jsonl`));
  expect(file, 'pi saved the conversation in the folder picked on the home page').toBeTruthy();
  made.file = join(sessions, file ?? '');
  expectNoProblems();
});

test('a row’s menu renames the conversation: the sidebar and pi’s session file take the name', async () => {
  const p = page();
  await openMenu(made.id);
  await still('row-menu');
  await menuItem('rename').click();
  const field = p.getByTestId('native-rename-input');
  await expect(field).toHaveValue(/从首页开始/);
  await field.fill(NEW_NAME);
  await still('rename');
  await p.getByTestId('native-rename-save').click();
  await expect(field).toBeHidden();
  await expect(row(made.id)).toContainText(NEW_NAME);
  // The host is live: pi named its session (set_session_name) and saved the name as a session_info entry.
  await expect
    .poll(
      () =>
        readFileSync(made.file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .findLast((entry) => entry.type === 'session_info')?.name,
      { timeout: 15_000 }
    )
    .toBe(NEW_NAME);
  expectNoProblems();
});

test('a row’s menu pins it above the newer one, the pin outlives a reload, and unpinning puts it back', async () => {
  const p = page();
  // Newest first: the conversation the home page made, then the old one.
  await expect(rows().first()).toHaveAttribute('data-id', made.id);
  await openMenu(made.free.id);
  await menuItem('pin').click();
  await expect(rows().first()).toHaveAttribute('data-id', made.free.id);
  await expect(rows().first()).toHaveAttribute('data-pinned', 'true');
  await expect(rows().first().getByTestId('native-sidebar-pinned')).toBeVisible();
  await still('pinned');
  // The window's storage keeps it over a reload.
  await p.reload();
  await expect(rows()).toHaveCount(2, { timeout: 30_000 });
  await expect(rows().first()).toHaveAttribute('data-id', made.free.id);
  await openMenu(made.free.id);
  await expect(menuItem('pin')).toContainText('取消置顶');
  await menuItem('pin').click();
  await expect(rows().first()).toHaveAttribute('data-id', made.id);
  await expect(row(made.free.id)).not.toHaveAttribute('data-pinned', 'true');
  // Its menu has faded out: the next step opens another row's.
  await expect(menuItem('pin')).toHaveCount(0);
  expectNoProblems();
});

test('a row’s menu deletes the conversation after a confirmation: its session file goes to the bin, nothing else', async () => {
  const p = page();
  const app = run.state?.app;
  if (!app) throw new Error('the app is not running');
  made.bin = join(paths().root, 'bin');
  // The system's bin is the person's own: the app's is the test's, a folder in the profile. The app looks the bin up at
  // each call (shell.trashItem), so replacing it here is enough; the check below makes sure it took.
  const replaced = await app.evaluate(({ shell }, bin) => {
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    /** @type {string[]} */
    const trashed = [];
    Object.defineProperty(globalThis, '__muE2eTrashed', { value: trashed, configurable: true });
    const fake = async (/** @type {string} */ file) => {
      trashed.push(file);
      fs.mkdirSync(bin, { recursive: true });
      fs.renameSync(file, path.join(bin, path.basename(file)));
    };
    shell.trashItem = fake;
    return shell.trashItem === fake;
  }, made.bin);
  expect(replaced, 'the bin is the test’s own').toBe(true);

  await openMenu(made.id);
  await menuItem('delete').click();
  await expect(p.getByTestId('native-delete')).toContainText(NEW_NAME);
  await still('delete-confirm');
  await p.getByTestId('native-delete-confirm').click();
  // Its page is gone: home instead; the row is gone, the other stays.
  await p.waitForURL(/#\/guid/, { timeout: 15_000 });
  await expect(rows()).toHaveCount(1);
  await expect(row(made.free.id)).toBeVisible();
  await still('after-delete');
  // A row with no host running, hovered: its "…" button takes the place of the dot, over no text.
  await menuButtonOf(row(made.free.id));
  await still('row-hover');

  const trashed = await app.evaluate(() => /** @type {any} */ (globalThis).__muE2eTrashed);
  expect(trashed, 'the one file the bin was handed').toEqual([made.file]);
  expect(existsSync(made.file)).toBe(false);
  expect(existsSync(join(made.bin, basename(made.file)))).toBe(true);
  // The other sessions and AionCore's records are as they were.
  for (const { path, before } of run.untouched) expect(stamp(path), `${path} left alone`).toBe(before);
  expectNoProblems();
});

test('a session the command line made shows in the list when the window comes back to the front', async () => {
  const p = page();
  // `mu` in a terminal wrote a session while the app was open: nothing in the app made it, so no change comes.
  const cli = writeSession(made.elsewhere, CLI_TITLE, 0);
  await expect(rows()).toHaveCount(1);
  // The window comes to the front (the list is read again at most once a second).
  await expect
    .poll(
      async () => {
        await p.evaluate(() => window.dispatchEvent(new Event('focus')));
        return rows().count();
      },
      { timeout: 30_000, intervals: [1200] }
    )
    .toBe(2);
  await expect(rows().first()).toHaveAttribute('data-id', cli.id);
  await expect(rows().first()).toContainText(CLI_TITLE);
  await still('cli-session');
  expectNoProblems();
});

test('the test stayed in its profile, and left nothing running', async () => {
  await stop();
  expectNoProblems();
  await expectNothingLeft();
  expect(
    existsSync(join(homedir(), '.mu', 'agent', 'sessions', slug(made.elsewhere))),
    "nothing in the person's ~/.mu"
  ).toBe(false);
  for (const { path, before } of run.untouched) expect(stamp(path), `${path} left alone`).toBe(before);
  run.passed = true;
});
