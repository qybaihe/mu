// @ts-check
// One conversation in the mu desktop app, end to end, against a local fake model (fakeModel.mjs), in a throwaway
// profile (profile.mjs). Run it with `bun run e2e:conversation` (scripts/kyrn/e2e-conversation.mjs builds the app
// first); tests/e2e/README.md says more.
//
// The steps run in order and share one app: a failed step skips the ones after it. Every step ends by checking that
// nothing failed unhandled (page errors, a page's error screen, the main process's and the adapter's reports).
import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  endProcessLook,
  launchApp,
  leftoverProcesses,
  packagedApp,
  problems,
  processTree,
  quitApp,
  warmUpProcessLook,
} from './app.mjs';
import {
  BOARD_REPLY,
  FAKE_API_KEY,
  FAKE_MODEL_ID,
  PLAIN_CHUNKS,
  PLAIN_TEXT,
  SLOW_CHUNK_COUNT,
  startFakeModel,
} from './fakeModel.mjs';
import { createProfile } from './profile.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const PROVIDER_NAME = 'E2E Fake';
/** The id the settings give a provider named PROVIDER_NAME. */
const PROVIDER_ID = 'e2e-fake';
const FIRST_MESSAGE = 'E2E:PLAIN 你好，请分几段回答。';
const WRITTEN = 'notes/hello.txt';
const DENIED_COMMAND = 'echo denied > bash-out.txt';

test.describe.configure({ mode: 'serial' });

/**
 * What the steps share: the fake model, the profile, the running app, the processes it started (to find leftovers
 * after a quit), what the checkout's own files looked like before (to show the test left them alone).
 * @type {{
 *   fake?: Awaited<ReturnType<typeof startFakeModel>>,
 *   profile?: ReturnType<typeof createProfile>,
 *   state?: Awaited<ReturnType<typeof launchApp>>,
 *   starts: number,
 *   seen: Map<number, { pid: number, command: string }>,
 *   conversationUrl: string,
 *   untouched: Array<{ path: string, before: string }>,
 *   passed: boolean,
 * }}
 */
const run = { starts: 0, seen: new Map(), conversationUrl: '', untouched: [], passed: false };

const page = () => {
  if (!run.state) throw new Error('the app is not running');
  return run.state.page;
};
const paths = () => {
  if (!run.profile) throw new Error('no profile');
  return run.profile.paths;
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** What the fake model was asked, oldest first. */
const requests = () => run.fake?.requests ?? [];

/** The replies' text: assistant messages render into a shadow root, which Playwright's CSS reaches into. */
const replies = () => page().locator('[data-testid="message-text-left"] .markdown-shadow-body');
const cards = () => page().getByTestId('message-acp-permission-card');
const stopButton = () => page().getByTestId('sendbox-stop-btn');
/** A tab of the work panel (看板, 文件, ...) by its key, whatever its name says. */
const workPanelTab = (tab) => page().locator(`[role="tab"][data-tab="${tab}"]`);

// A window with little room (a laptop's, a CI runner's 1024 x 768 screen) folds the sidebar to its rail of icons, and
// a row's words are hidden then: the sidebar and the settings rail are reached by what stays, their icons' test ids.

/** Opens a page of the settings (`providers`, `default-model`, `about`, ...) from the sidebar's 设置 and the rail. */
async function openSettings(path) {
  const p = page();
  if (!/#\/settings\//.test(p.url())) await p.getByTestId('sider-settings').click();
  await p.locator(`[data-settings-path="${path}"]`).click();
  await p.waitForURL(new RegExp(`#/settings/${path}`));
}

/** Leaves the settings by the sidebar's 返回聊天 (in the settings, 设置's row turns into it). */
async function backToChat() {
  const p = page();
  await p.getByTestId('sider-settings').click();
  await p.waitForURL((url) => !url.hash.startsWith('#/settings'));
}

/** Opens a conversation from the sidebar's list, by its title; a sidebar folded to its rail is opened first. */
async function openConversation(title) {
  const p = page();
  const unfold = p.getByRole('button', { name: '展开侧边栏' });
  if (await unfold.isVisible().catch(() => false)) await unfold.click();
  await p.getByText(title, { exact: true }).first().click();
}

/** A file's size and time, or `missing`: enough to show it was left alone, without reading it. */
const stamp = (path) => {
  if (!existsSync(path)) return 'missing';
  const info = statSync(path);
  return `${info.size}:${info.mtimeMs}`;
};

/**
 * Remembers the processes the app runs now (the backend, the adapter, mu), so a quit can show that none of them stayed.
 * The app's own process is followed by `quitApp`.
 */
async function noteProcesses() {
  const pid = run.state?.app.process().pid;
  if (!pid) return;
  for (const entry of await processTree(pid)) run.seen.set(entry.pid, entry);
}

/**
 * MU_E2E_WINDOW=<width>x<height> sizes the app's window, so a layout another screen gets can be tried on this one: the
 * Windows runner's 1024 x 768 screen gives a window of 819x691, where the sidebar folds to its rail beside the work panel.
 */
const windowSize = (() => {
  const size = /^(\d+)x(\d+)$/.exec(process.env.MU_E2E_WINDOW ?? '');
  return size ? { width: Number(size[1]), height: Number(size[2]) } : undefined;
})();

/**
 * The app's own folders, as Electron names them: printed at the first start, to show which of them follow the profile
 * (on Windows Electron asks the system, not the environment, for some).
 */
async function printFolders() {
  const names = ['home', 'appData', 'userData', 'temp', 'documents', 'downloads'];
  const folders = await run.state?.app.evaluate(({ app }, list) => {
    const where = (name) => {
      try {
        return app.getPath(name);
      } catch (error) {
        return `none (${error instanceof Error ? error.message : String(error)})`;
      }
    };
    return Object.fromEntries(list.map((name) => [name, where(name)]));
  }, names);
  console.log(`[mu e2e] the app's folders: ${JSON.stringify(folders)}`);
}

/**
 * Waits for everything the app ran to be gone after a quit, and fails naming what is left. The wait is by the clock,
 * not by a number of looks: one look at the processes takes a moment on a Mac, and far longer on a slow Windows
 * machine.
 */
async function expectNothingLeft(deadline = Date.now() + 60_000) {
  const left = await leftoverProcesses(run.profile, [...run.seen.values()]);
  if (left.length > 0 && Date.now() < deadline) {
    await sleep(500);
    return expectNothingLeft(deadline);
  }
  expect(left, 'processes left running after the quit').toEqual([]);
}

async function start() {
  if (!run.profile) throw new Error('no profile');
  run.starts += 1;
  run.state = await launchApp({ desktopRoot, profile: run.profile, run: run.starts, electron, window: windowSize });
  if (run.starts === 1) await printFolders();
  // The system's folder picker cannot be driven: "choosing" a folder answers with the test's project.
  await run.state.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, run.profile.paths.project);
  await noteProcesses();
}

async function stop() {
  const state = run.state;
  if (!state) return;
  await noteProcesses();
  await quitApp(state);
}

/** Nothing failed unhandled in this start of the app so far. */
function expectNoProblems() {
  if (!run.state || !run.profile) return;
  expect(problems(run.state, run.profile), 'errors nothing handled (see the logs folder)').toEqual([]);
}

/** Types a message into the conversation's send box and sends it. */
async function send(text) {
  const box = page().getByTestId('sendbox-input');
  await box.click();
  await box.fill(text);
  await box.press('Enter');
}

/** Waits until a reply contains `text` and the turn is over (the send button is back). */
async function replyWith(text, timeout = 60_000) {
  await expect(replies().filter({ hasText: text }).first()).toBeVisible({ timeout });
  await expect(stopButton()).toHaveCount(0, { timeout: 30_000 });
  await noteProcesses();
}

/**
 * Sends `message`, waits for the one permission card its turn brings, answers it with `answer`, and waits for the turn
 * to end with a reply that contains `done`. Watches the cards the whole time: the turn adds exactly one, never two at
 * once. (Cards of earlier turns stay in the list, answered.) Returns the card's text.
 */
async function sendAndAnswer(message, answer, done) {
  const before = await cards().count();
  await send(message);
  const counts = [];
  const watch = async (until) => {
    while (!(await until())) {
      counts.push(await cards().count());
      await sleep(100);
    }
  };
  const deadline = Date.now() + 60_000;
  await watch(async () => (await cards().count()) > before || Date.now() > deadline);
  await expect(cards()).toHaveCount(before + 1);
  const card = cards().nth(before);
  const option = card.getByTestId(`message-acp-permission-option-${answer}`);
  await expect(option).toBeVisible();
  const text = await card.innerText();
  await option.click();
  const settled = Date.now() + 60_000;
  await watch(
    async () =>
      Date.now() > settled ||
      ((await replies().filter({ hasText: done }).count()) > 0 && (await stopButton().count()) === 0)
  );
  counts.push(await cards().count());
  expect(Math.max(...counts) - before, 'permission cards this turn added at most').toBe(1);
  await replyWith(done, 5_000);
  // The answered card stays, and says the answer went through.
  await expect(cards()).toHaveCount(before + 1);
  await expect(card.getByTestId('message-acp-permission-status')).toBeVisible();
  return text;
}

test.beforeAll(async () => {
  warmUpProcessLook();
  run.fake = await startFakeModel();
  // MU_E2E_APP: a packaged app (its executable, the app, or electron-builder's output folder) instead of out/.
  const named = process.env.MU_E2E_APP;
  const app = named ? packagedApp(named) : undefined;
  if (named && !app)
    throw new Error(`MU_E2E_APP names no packaged app for ${process.platform}-${process.arch}: ${named}`);
  run.profile = createProfile({ desktopRoot, root: process.env.MU_E2E_ROOT, app });
  const { harness } = run.profile;
  // The conversation on AionCore is the kill switch's path: the native host is on by default, and this test is of the
  // other one.
  run.profile.env.MU_NATIVE_HOST = '0';
  // The harness's keys (a checkout's own .env; none beside the mu a packaged app carries): stamped (never read)
  // before, compared after.
  run.untouched = [join(harness.root, '.env')].map((path) => ({ path, before: stamp(path) }));
  console.log(`[mu e2e] app: ${app ? app.executable : join(desktopRoot, 'out')}`);
  console.log(`[mu e2e] profile: ${run.profile.paths.root}`);
  console.log(`[mu e2e] fake model: ${run.fake.baseUrl}`);
});

test.afterAll(async () => {
  await stop().catch(() => {});
  endProcessLook();
  await run.fake?.close();
  const root = run.profile?.paths.root;
  if (!root) return;
  if (run.passed && process.env.MU_E2E_KEEP !== '1' && !process.env.MU_E2E_ROOT) {
    rmSync(root, { recursive: true, force: true });
  } else {
    console.log(`[mu e2e] kept for a look: ${root} (logs in ${join(root, 'logs')})`);
  }
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || !run.state || !run.profile) return;
  // What the window showed, and the named controls on it, next to the logs.
  const name = `failed-${testInfo.title.replace(/[^\w]+/g, '-').slice(0, 60)}`;
  const shot = join(run.profile.paths.logs, `${name}.png`);
  if (
    await run.state.page.screenshot({ path: shot }).then(
      () => true,
      () => false
    )
  ) {
    await testInfo.attach('screen', { path: shot, contentType: 'image/png' });
  }
  const controls = await run.state.page
    .evaluate(() =>
      [...document.querySelectorAll('button, [role="tab"], [role="button"], [data-testid]')]
        .filter((element) => element.checkVisibility())
        .map((element) =>
          [
            element.getAttribute('data-testid'),
            element.getAttribute('aria-label'),
            element.textContent?.trim().slice(0, 40),
          ]
            .filter(Boolean)
            .join(' | ')
        )
        .filter(Boolean)
        .join('\n')
    )
    .catch(() => '');
  await testInfo.attach('controls', { body: controls, contentType: 'text/plain' });
  for (const file of [run.state.mainLog, run.state.rendererLog]) {
    if (existsSync(file)) await testInfo.attach(file.split(/[\\/]/).pop() ?? 'log', { path: file });
  }
});

test('first start: the guide opens, and a custom endpoint added in the settings becomes the model', async () => {
  await start();
  const p = page();

  await test.step('the guide opens on a fresh profile', async () => {
    await expect(p.getByTestId('mu-welcome')).toBeVisible({ timeout: 60_000 });
    await expect(p.getByTestId('mu-welcome-begin')).toBeVisible();
    await p.getByText('跳过引导', { exact: true }).click();
    await p.waitForURL(/#\/guid/);
  });

  await test.step('the fake model is added as an OpenAI-compatible endpoint', async () => {
    await p.getByTestId('sider-settings').click();
    await p.waitForURL(/#\/settings\/providers/);
    await p.getByTestId('mu-provider-add').click();
    const editor = p.getByTestId('mu-provider-editor');
    await editor.getByLabel('显示名称').fill(PROVIDER_NAME);
    await editor.getByLabel('接口地址（Base URL）').fill(run.fake?.baseUrl ?? '');
    await editor.getByLabel('API 密钥').fill(FAKE_API_KEY);
    await editor.getByText('测试连接', { exact: true }).click();
    // The connection test lists the endpoint's models; the fake one is offered and taken.
    await p.getByTestId(`mu-model-offer-${FAKE_MODEL_ID}`).click({ timeout: 20_000 });
    await p.getByRole('button', { name: '保存' }).click();
    await expect(p.getByText('已保存。', { exact: false }).first()).toBeVisible({ timeout: 20_000 });

    const models = JSON.parse(readFileSync(join(paths().agentDir, 'models.json'), 'utf8'));
    const provider = models.providers?.[PROVIDER_ID];
    expect(provider?.baseUrl).toBe(run.fake?.baseUrl);
    expect(provider?.models?.map((model) => model.id)).toContain(FAKE_MODEL_ID);
    // The key goes to the harness's .env, here the test's own; models.json only names it.
    expect(JSON.stringify(provider)).not.toContain(FAKE_API_KEY);
  });

  await test.step('the fake model is picked as the default model', async () => {
    await openSettings('default-model');
    const card = p.getByTestId('mu-defaults');
    await card.getByRole('combobox', { name: '提供商' }).click();
    await p.locator('.arco-select-popup:visible .arco-select-option', { hasText: PROVIDER_NAME }).click();
    await card.getByRole('combobox', { name: '模型' }).click();
    await p.locator('.arco-select-popup:visible .arco-select-option', { hasText: FAKE_MODEL_ID }).click();
    await p.getByRole('button', { name: '保存' }).click();
    await expect
      .poll(() => JSON.parse(readFileSync(join(paths().agentDir, 'settings.json'), 'utf8')), { timeout: 15_000 })
      .toMatchObject({ defaultProvider: PROVIDER_ID, defaultModel: FAKE_MODEL_ID });
  });

  expect(existsSync(join(paths().home, '.mu', 'agent')), 'mu used MU_AGENT_DIR, not ~/.mu/agent').toBe(false);
  expectNoProblems();
});

test('a plain reply streams in, in several pieces', async () => {
  const p = page();
  await backToChat();
  await p.waitForURL(/#\/guid/);

  await test.step('the test project is chosen as the folder to work in', async () => {
    await p.getByTestId('workspace-selector-btn').click();
    // With a recent folder the button opens a menu first; on a fresh profile it opens the picker right away.
    const other = p.getByText('选择其他目录', { exact: true });
    if (await other.isVisible().catch(() => false)) await other.click();
    await expect(p.getByText('project', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  });

  const seen = [];
  await test.step('the first message starts the conversation, and the reply grows piece by piece', async () => {
    const box = p.getByTestId('guid-input');
    await box.click();
    await box.fill(FIRST_MESSAGE);
    await box.press('Enter');
    await p.waitForURL(/#\/conversation\//, { timeout: 60_000 });
    run.conversationUrl = p.url();
    // MU_NATIVE_HOST=0: the conversation is AionCore's, and the sidebar has no group of the native host's.
    expect(run.conversationUrl).not.toContain('/conversation/native/');
    await expect(p.getByTestId('native-sidebar-group')).toHaveCount(0);
    const reply = replies().last();
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const text = await reply.innerText({ timeout: 250 }).catch(() => '');
      if (text && seen[seen.length - 1] !== text) seen.push(text);
      if (text.includes(PLAIN_TEXT)) break;
      await sleep(25);
    }
    expect(seen[seen.length - 1]).toContain(PLAIN_TEXT);
    // Seven pieces, 150 ms apart: the reply showed at least three partial states before the whole.
    expect(seen.filter((text) => !text.includes(PLAIN_TEXT)).length).toBeGreaterThanOrEqual(3);
    await expect(stopButton()).toHaveCount(0, { timeout: 30_000 });
  });

  const plain = requests().find((request) => request.scenario === 'plain');
  expect(plain, 'the fake model was asked for the plain reply').toBeTruthy();
  expect(plain).toMatchObject({
    stream: true,
    model: FAKE_MODEL_ID,
    authorization: `Bearer ${FAKE_API_KEY}`,
    sentChunks: PLAIN_CHUNKS.length,
    finished: true,
  });
  expect(plain?.tools).toEqual(expect.arrayContaining(['write', 'bash']));
  await expect(p.getByTestId('composer-model-pill')).toContainText(FAKE_MODEL_ID);
  await noteProcesses();
  expectNoProblems();
});

test('最小权限: a write asks once, 允许 writes the file, and the turn finishes', async () => {
  const p = page();
  await test.step('the conversation is switched to 最小权限', async () => {
    await p.getByTestId('mode-selector').click();
    await p.getByTestId('aionrs-mode-option-ask').click();
    await expect(p.getByTestId('mode-selector')).toHaveAttribute('data-current-mode', 'ask', { timeout: 20_000 });
  });

  const card = await sendAndAnswer(`E2E:WRITE ${WRITTEN}`, 'mu:once', 'WRITE-DONE');
  expect(card).toContain(WRITTEN);
  expect(readFileSync(join(paths().project, WRITTEN), 'utf8')).toBe('Written by the fake model for the E2E test.\n');
  // The write keeps its own row beside the card, and it says the write worked.
  await expect(p.locator('[aria-label^="write · "]').first()).toHaveAttribute('aria-label', 'write · 成功');
  const done = requests().findLast((request) => request.scenario === 'write' && request.kind === 'text');
  expect(done?.toolResult).toContain(WRITTEN);
  expectNoProblems();
});

test('a bash call answered 不允许 reaches the model as a refusal, and the conversation goes on', async () => {
  const p = page();
  const card = await sendAndAnswer(`E2E:BASH ${DENIED_COMMAND}`, 'mu:deny', 'BASH-SAW');
  expect(card).toContain(DENIED_COMMAND);
  expect(existsSync(join(paths().project, 'bash-out.txt')), 'the refused command did not run').toBe(false);
  const refusal = requests().findLast((request) => request.scenario === 'bash' && request.kind === 'text');
  expect(refusal?.toolResult, 'the model was told the command was refused').toContain(DENIED_COMMAND);
  expect(refusal?.toolResult).toMatch(/not allow|refus|denied|不允许|拒绝/i);
  // The card says what was decided, about which command; the call's row says quietly that it did not run, never
  // "错误" and never the refusal written for the model.
  const answered = cards().last().getByTestId('message-acp-permission-status');
  await expect(answered).toHaveAttribute('data-outcome', 'deny');
  await expect(answered).toContainText(`你没允许：${DENIED_COMMAND}`);
  const row = p.locator('[aria-label^="bash · "]').first();
  await expect(row).toHaveAttribute('aria-label', 'bash · 未允许');
  await expect(p.getByTestId('tool-call-denied').first()).toHaveText('没有运行：你没有允许。');
  // The question reads before what came of the call it asked about.
  const questionFirst = await cards()
    .last()
    .evaluate(
      (question, call) => Boolean(call && question.compareDocumentPosition(call) & Node.DOCUMENT_POSITION_FOLLOWING),
      await row.elementHandle()
    );
  expect(questionFirst, 'the card stands above the call it asked about').toBe(true);

  await send('E2E:ECHO AFTER-REFUSAL-OK');
  await replyWith('AFTER-REFUSAL-OK');
  expectNoProblems();
});

test('a reply stopped halfway stays stopped, and the next message works', async () => {
  await send('E2E:SLOW 请慢慢说。');
  const reply = replies().filter({ hasText: 'SLOW-001' }).last();
  await expect(reply).toContainText('SLOW-005', { timeout: 60_000 });
  await noteProcesses();
  await stopButton().click();
  await expect(stopButton()).toHaveCount(0, { timeout: 15_000 });
  await expect(page().getByTestId('sendbox-send-btn')).toBeVisible();
  const stoppedAt = await reply.innerText();
  await sleep(2_500);
  expect(await reply.innerText(), 'nothing more arrives after the stop').toBe(stoppedAt);
  expect(stoppedAt.match(/SLOW-\d{3}/g)?.length ?? 0).toBeLessThan(SLOW_CHUNK_COUNT);
  const slow = requests().find((request) => request.scenario === 'slow');
  expect(slow, 'the model request was cut off').toMatchObject({ finished: false, aborted: true });
  // A stopped reply would read as a finished one: the line after it says it was stopped.
  await expect(page().locator('[data-testid="mu-notice"][data-code="stopped"]').last()).toHaveText(
    '你停止了这次回复。'
  );

  await send('E2E:ECHO AFTER-STOP-OK');
  await replyWith('AFTER-STOP-OK');
  expectNoProblems();
});

test('the files tab lists the written file, and the board is written by the fake model', async () => {
  const p = page();
  await test.step('文件 lists the file the model wrote', async () => {
    const expand = p.getByRole('button', { name: '展开工作面板' });
    if (await expand.isVisible().catch(() => false)) await expand.click();
    // By the tab's key: a tab with news the person has not seen is named "文件，有新内容", and the write is news.
    await workPanelTab('files').click();
    const files = p.locator('#mu-work-panel-body-files');
    await files.getByText('notes', { exact: true }).click();
    await expect(files.getByText('hello.txt', { exact: true })).toBeVisible({ timeout: 15_000 });
  });

  await test.step('the fake model is picked to write the board', async () => {
    await openSettings('default-model');
    const card = p.getByTestId('mu-board-model');
    await card.getByRole('combobox', { name: '提供商' }).click();
    await p.locator('.arco-select-popup:visible .arco-select-option', { hasText: PROVIDER_NAME }).click();
    await card.getByRole('combobox', { name: '模型' }).click();
    await p.locator('.arco-select-popup:visible .arco-select-option', { hasText: FAKE_MODEL_ID }).last().click();
    await p.getByRole('button', { name: '保存' }).click();
    await expect
      .poll(() => JSON.parse(readFileSync(join(paths().agentDir, 'mu', 'board.json'), 'utf8')).model, {
        timeout: 15_000,
      })
      .toBe(`${PROVIDER_ID}/${FAKE_MODEL_ID}`);
    await backToChat();
    if (p.url() !== run.conversationUrl) await openConversation(FIRST_MESSAGE);
    await p.waitForURL(run.conversationUrl, { timeout: 30_000 });
    await expect(p.getByTestId('sendbox-input')).toBeVisible({ timeout: 30_000 });
  });

  await test.step('看板 on for this project shows the plain lines, without Jev', async () => {
    const expand = p.getByRole('button', { name: '展开工作面板' });
    if (await expand.isVisible().catch(() => false)) await expand.click();
    await workPanelTab('board').click();
    const toggle = p.getByTestId('mu-board-switch');
    await expect(toggle).toBeEnabled({ timeout: 30_000 });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 60_000 });
    await expect(p.getByTestId('mu-board-pending')).toHaveCount(0, { timeout: 60_000 });
    const board = p.getByTestId('mu-board');
    await expect(board).toContainText(BOARD_REPLY.now, { timeout: 60_000 });
    await expect(board).toContainText(BOARD_REPLY.progress);
    await expect(board).toContainText(BOARD_REPLY.note);
    const stored = JSON.parse(readFileSync(join(paths().agentDir, 'mu', 'board.json'), 'utf8'));
    expect(stored.projects?.[paths().project]).toBe(true);
    const writer = requests().find((request) => request.scenario === 'board');
    expect(writer, 'the board was written by the fake model').toMatchObject({ model: FAKE_MODEL_ID });
  });
  await noteProcesses();
  expectNoProblems();
});

test('after a quit and a new start the conversation opens with its history, and a new message works', async () => {
  await stop();
  expectNoProblems();
  await expectNothingLeft();

  await start();
  const p = page();
  await openConversation(FIRST_MESSAGE);
  await p.waitForURL(run.conversationUrl, { timeout: 30_000 });
  for (const text of [PLAIN_TEXT, 'WRITE-DONE', 'BASH-SAW', 'AFTER-REFUSAL-OK', 'SLOW-005', 'AFTER-STOP-OK']) {
    await expect(replies().filter({ hasText: text }).first()).toBeVisible({ timeout: 30_000 });
  }
  await expect(p.getByTestId('mode-selector')).toHaveAttribute('data-current-mode', 'ask');
  await send('E2E:ECHO AFTER-RELAUNCH-OK');
  await replyWith('AFTER-RELAUNCH-OK');
  expectNoProblems();
});

test('关于 shows the version, and 检查更新 downloads nothing', async () => {
  const p = page();
  const app = run.state?.app;
  if (!app) throw new Error('the app is not running');
  const fakeAssets = `${run.fake?.baseUrl.replace(/\/v1$/, '')}/__e2e/asset`;
  const version = '99.0.0';
  // The app's own version (a packaged app's is the one it was built with), its downloads folder, and how it checks: an
  // installed app on macOS and Windows asks electron-updater, which reads GitHub's release feed through a session of its
  // own (the releases' atom feed, then the newest release's latest-mac.yml or latest.yml); the others ask GitHub's API
  // with fetch.
  const own = await app.evaluate(({ app: electronApp }) => ({
    packaged: electronApp.isPackaged,
    version: electronApp.getVersion(),
    downloads: electronApp.getPath('downloads'),
  }));
  const restarts = own.packaged && (process.platform === 'darwin' || process.platform === 'win32');
  const appVersion = own.packaged
    ? own.version
    : JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')).version;
  const feed = 'https://github.com/qybaihe/mu/releases.atom';
  const channel = `https://github.com/qybaihe/mu/releases/download/v${version}/${
    process.platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml'
  }`;
  const listDownloads = () => (existsSync(own.downloads) ? readdirSync(own.downloads).toSorted() : []);
  const downloadsBefore = listDownloads();
  // GitHub is answered here, both ways, with a newer release: a check must offer it and download nothing. Every
  // request the main process makes either way is kept.
  await app.evaluate(
    ({ session }, { assets, version: newer, feedUrl, channelUrl, platform }) => {
      const scope = /** @type {any} */ (globalThis);
      scope.__e2eRequests = [];
      scope.__e2eFetch ??= scope.fetch;
      scope.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        scope.__e2eRequests.push(url);
        if (url.startsWith('https://api.github.com/repos/qybaihe/mu/releases')) {
          const names = [`mu-${newer}-mac-arm64.dmg`, `mu-${newer}-mac-x64.dmg`, `mu-${newer}-win-x64.exe`];
          const release = {
            tag_name: `v${newer}`,
            name: `mu ${newer}`,
            html_url: `https://github.com/qybaihe/mu/releases/tag/v${newer}`,
            prerelease: true,
            draft: false,
            assets: [...names, `mu-${newer}-linux-amd64.deb`].map((name) => ({
              name,
              browser_download_url: `${assets}/${name}`,
              size: 123_456_789,
            })),
          };
          return new Response(JSON.stringify([release]), { status: 200 });
        }
        return scope.__e2eFetch(input, init);
      };
      // electron-updater's session (NET_SESSION_NAME in electron-updater's electronHttpExecutor.js): GitHub's feed of
      // the releases, newest first, and the update file of the newest one, which lists its installers.
      const files =
        platform === 'darwin'
          ? [`mu-${newer}-mac-arm64.zip`, `mu-${newer}-mac-x64.zip`]
          : [`mu-${newer}-win-x64.exe`, `mu-${newer}-win-arm64.exe`];
      const sha512 = `${'A'.repeat(86)}==`;
      const updateFile = [
        `version: ${newer}`,
        'files:',
        ...files.flatMap((file) => [`  - url: ${file}`, `    sha512: ${sha512}`, '    size: 123456789']),
        `path: ${files[0]}`,
        `sha512: ${sha512}`,
        "releaseDate: '2026-09-25T00:00:00.000Z'",
        '',
      ].join('\n');
      const atom = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">',
        '  <id>tag:github.com,2008:https://github.com/qybaihe/mu/releases</id>',
        '  <title>Release notes from mu</title>',
        '  <updated>2026-09-25T00:00:00Z</updated>',
        '  <entry>',
        `    <id>tag:github.com,2008:Repository/1/v${newer}</id>`,
        '    <updated>2026-09-25T00:00:00Z</updated>',
        `    <link rel="alternate" type="text/html" href="https://github.com/qybaihe/mu/releases/tag/v${newer}"/>`,
        `    <title>mu ${newer}</title>`,
        '    <content type="html">No content.</content>',
        '  </entry>',
        '</feed>',
        '',
      ].join('\n');
      session.fromPartition('electron-updater', { cache: false }).protocol.handle('https', async (request) => {
        scope.__e2eRequests.push(request.url);
        if (request.url === feedUrl) return new Response(atom, { headers: { 'content-type': 'application/atom+xml' } });
        if (request.url === channelUrl) return new Response(updateFile, { headers: { 'content-type': 'text/yaml' } });
        return new Response('not in the E2E feed', { status: 404 });
      });
    },
    { assets: fakeAssets, version, feedUrl: feed, channelUrl: channel, platform: process.platform }
  );

  await openSettings('about');
  await expect(p.getByTestId('about-version')).toContainText(`v${appVersion}`);
  await p.getByTestId('about-content').getByRole('button', { name: '检查更新' }).click();
  await expect(p.getByTestId('about-update-status')).toContainText(version, { timeout: 30_000 });
  await sleep(3_000);

  const asked = /** @type {string[]} */ (await app.evaluate(() => /** @type {any} */ (globalThis).__e2eRequests));
  const outside = asked.filter((url) => !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url));
  expect(outside, 'the check asked only for the release list').toEqual(
    restarts ? [feed, channel] : ['https://api.github.com/repos/qybaihe/mu/releases']
  );
  expect(
    (run.fake?.hits ?? []).filter((hit) => hit.path.startsWith('/__e2e/asset')),
    'no installer was fetched'
  ).toEqual([]);
  expect(listDownloads(), 'nothing downloaded').toEqual(downloadsBefore);
  expectNoProblems();
});

test('the test stayed in its profile, and left nothing running', async () => {
  await stop();
  expectNoProblems();
  await expectNothingLeft();

  const { project, home, agentDir } = paths();
  const slug = `--${project.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  expect(existsSync(join(agentDir, 'sessions', slug)), "mu kept the conversation's session in MU_AGENT_DIR").toBe(true);
  expect(existsSync(join(home, '.mu', 'agent')), 'nothing in the profile home ~/.mu/agent').toBe(false);
  const realMu = join(homedir(), '.mu');
  expect(existsSync(join(realMu, 'agent', 'sessions', slug)), "nothing in the person's ~/.mu/agent").toBe(false);
  for (const name of existsSync(join(home, '.mu', 'acp-sessions'))
    ? readdirSync(join(home, '.mu', 'acp-sessions'))
    : []) {
    expect(existsSync(join(realMu, 'acp-sessions', name)), `nothing in the person's ~/.mu/acp-sessions (${name})`).toBe(
      false
    );
  }
  // The person's board settings may change while the test runs (their own mu), but never name the test's project.
  const realBoard = join(realMu, 'agent', 'mu', 'board.json');
  if (existsSync(realBoard)) expect(readFileSync(realBoard, 'utf8'), "the person's board.json").not.toContain(project);
  for (const { path, before } of run.untouched) expect(stamp(path), `${path} left alone`).toBe(before);
  run.passed = true;
});
