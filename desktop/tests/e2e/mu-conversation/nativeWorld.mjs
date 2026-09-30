// @ts-check
// The world a native-host E2E spec runs in: the fake model, a throwaway profile that leaves MU_NATIVE_HOST alone (the
// native host is on by default) and mu's models.json / settings.json written where it reads them, the app started and
// stopped the way a person does, and the helpers every native spec needs (send a message, wait for the run's end,
// answer mu's permission question, pictures).
// Every spec file makes its own world: `const world = createNativeWorld({ desktopRoot })` at its top level registers the
// hooks (start the fake model and the profile before all, quit and clean up after all, a screenshot and the logs on a
// failure) and puts the file's tests in serial order. The test ids read are the ones docs/native-host-ui.md lists.
import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { FAKE_API_KEY, FAKE_MODEL_ID, startFakeModel } from './fakeModel.mjs';
import { createProfile } from './profile.mjs';

/** A second model and one that reasons (so the thinking levels are offered), for the pickers' tests. */
export const SECOND_MODEL_ID = 'e2e-fake-model-2';
export const THINKING_MODEL_ID = 'e2e-fake-thinker';

/**
 * Makes the world of one spec file and registers its hooks. Returns the helpers; `run` is the state they share (the
 * fake model, the profile, the running app), `sent` the messages sent so far, in order (what a reopened conversation
 * shows back). `prepare(profile)` changes the profile before the app starts, for a spec whose world differs (a mu too
 * old to run inside the app).
 */
export function createNativeWorld({ desktopRoot, prepare }) {
  /** The messages the person sends in the steps, in order. */
  const sent = [];

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

  const userRows = () => page().getByTestId('native-message-user');
  /** The replies' text: mu's messages render into a shadow root, which Playwright's CSS reaches into. */
  const replies = () => page().locator('[data-testid="native-message-assistant"] .markdown-shadow-body');
  const status = () => page().getByTestId('native-status');
  const dialogs = () => page().getByTestId('native-dialog');
  const toolCalls = () => page().getByTestId('native-tool-call');

  /** Why mu's host stopped, in the words the screen has for it and mu's last output (folded on screen), or undefined. */
  async function hostFailure() {
    const failed = page().getByTestId('native-failed');
    if ((await failed.count()) === 0) return undefined;
    return failed.first().evaluate((element) => element.textContent ?? '');
  }

  /** Waits for `promise`, and fails at once, saying why, if mu's host stops meanwhile: nothing here waits for that. */
  async function orHostFailure(promise) {
    let over = false;
    const watch = (async () => {
      while (!over) {
        const why = await hostFailure().catch(() => undefined);
        if (why !== undefined) throw new Error(`mu's host stopped: ${why}`);
        await sleep(500);
      }
      return undefined;
    })();
    try {
      return await Promise.race([promise, watch]);
    } finally {
      over = true;
      watch.catch(() => {});
    }
  }

  /** A file's size and time, or `missing`: enough to show it was left alone, without reading it. */
  const stamp = (path) => {
    if (!existsSync(path)) return 'missing';
    const info = statSync(path);
    return `${info.size}:${info.mtimeMs}`;
  };

  /** Remembers the processes the app runs now (the backend, the conversation's host), so a quit can show none stayed. */
  async function noteProcesses() {
    const pid = run.state?.app.process().pid;
    if (!pid) return;
    for (const entry of await processTree(pid)) run.seen.set(entry.pid, entry);
  }

  /** MU_E2E_WINDOW=<width>x<height> sizes the app's window (see conversation.spec.mjs). */
  const windowSize = (() => {
    const size = /^(\d+)x(\d+)$/.exec(process.env.MU_E2E_WINDOW ?? '');
    return size ? { width: Number(size[1]), height: Number(size[2]) } : undefined;
  })();

  /** Waits for everything the app ran to be gone after a quit, and fails naming what is left. */
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

  /** A picture of the window, kept in the profile's logs (and in the report) for a look. */
  async function shot(name) {
    const file = join(paths().logs, `shot-${name}.png`);
    await page().screenshot({ path: file });
    console.log(`[mu e2e] screenshot: ${file}`);
  }

  /** Leaves the guide (a fresh profile opens on it) and unfolds a sidebar that a small window folded to its rail. */
  async function reachSidebar() {
    const p = page();
    const welcome = p.getByTestId('mu-welcome');
    const group = p.getByTestId('native-sidebar-group');
    const unfold = p.getByRole('button', { name: '展开侧边栏' });
    // The guide and the sidebar can both be there (a start with no model shows the guide over the app).
    await expect(welcome.or(group).or(unfold).first()).toBeVisible({ timeout: 60_000 });
    if (await welcome.isVisible().catch(() => false)) {
      await p.getByText('跳过引导', { exact: true }).click();
      await p.waitForURL(/#\/guid/);
    }
    if (await unfold.isVisible().catch(() => false)) await unfold.click();
    await expect(group).toBeVisible({ timeout: 30_000 });
    // The classic list under the group has no conversations in this world, and its placeholder ("no conversation
    // history") would say there are none right under the native ones.
    await expect(p.locator('.layout-sider .arco-empty')).toHaveCount(0);
  }

  /**
   * Types a message into the conversation's send box and sends it; returns once the person's row shows. (The row shows
   * at once: the run it starts does not begin until Jev has read the message and pi took it.)
   */
  async function send(text) {
    const rows = await userRows().count();
    const box = page().getByTestId('native-send-input');
    await box.click();
    await box.fill(text);
    await page().getByTestId('native-send').click();
    await expect(userRows()).toHaveCount(rows + 1, { timeout: 15_000 });
    sent.push(text);
  }

  /** Waits for the run the last message started to end, by how the view says it ended. */
  async function runEnds(ending = /^(settled|aborted|error)$/, timeout = 60_000) {
    await orHostFailure(
      (async () => {
        await expect(status()).toHaveAttribute('data-sending', 'false', { timeout });
        await expect(status()).toHaveAttribute('data-status', ending, { timeout });
      })()
    );
    await noteProcesses();
  }

  /** Waits until one of mu's messages contains `text` and the run is over. */
  async function replyWith(text, timeout = 60_000) {
    await orHostFailure(expect(replies().filter({ hasText: text }).first()).toBeVisible({ timeout }));
    await runEnds(/^settled$/, timeout);
  }

  /** Opens the tool box of the newest stretch of calls, when it is folded (a single call is not), so its rows exist. */
  async function openToolBox() {
    const header = page().locator('[data-testid="tool-activity-group"] > button').last();
    if ((await header.count()) === 0) return;
    if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  }

  /**
   * Sends `message`, waits for the one permission question its run brings, answers it with the option at `which`
   * (`first`: allow once, `last`: don't allow), and waits for a reply that contains `done`. Watches the dialogs the whole
   * time: the run asks exactly once, never twice at once. Returns the question's text.
   */
  async function sendAndAnswer(message, which, done) {
    await send(message);
    const counts = [];
    const deadline = Date.now() + 60_000;
    while ((await dialogs().count()) === 0 && Date.now() < deadline) {
      const why = await hostFailure();
      if (why !== undefined) throw new Error(`mu's host stopped: ${why}`);
      await sleep(50);
    }
    await expect(dialogs()).toHaveCount(1);
    await expect(dialogs()).toHaveAttribute('data-method', 'select');
    const text = await dialogs().innerText();
    await shot(`permission-${which}`);
    const options = dialogs().getByTestId('native-dialog-option');
    await expect(options.first()).toBeVisible();
    await (which === 'first' ? options.first() : options.last()).click();
    const settled = Date.now() + 60_000;
    while (Date.now() < settled) {
      counts.push(await dialogs().count());
      if ((await replies().filter({ hasText: done }).count()) > 0) break;
      await sleep(100);
    }
    expect(Math.max(...counts), 'permission questions this run asked at once').toBeLessThanOrEqual(1);
    await replyWith(done, 15_000);
    await expect(dialogs()).toHaveCount(0);
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
    const { harness, paths: where } = run.profile;
    // Nothing names MU_NATIVE_HOST: the native host is on by itself, where the app finds a mu that can run inside it,
    // as it is for a person who never heard of the variable. mu has the fake model and no decision point on (each
    // takes its fixed fallback): the same world the classic test builds through the settings, written where mu reads it.
    expect(run.profile.env.MU_NATIVE_HOST, 'the profile leaves the native host to its default').toBeUndefined();
    mkdirSync(where.agentDir, { recursive: true });
    const provider = {
      baseUrl: run.fake.baseUrl,
      api: 'openai-completions',
      apiKey: FAKE_API_KEY,
      models: [{ id: FAKE_MODEL_ID }, { id: SECOND_MODEL_ID }, { id: THINKING_MODEL_ID, reasoning: true }],
    };
    writeFileSync(join(where.agentDir, 'models.json'), JSON.stringify({ providers: { e2e: provider } }));
    writeFileSync(
      join(where.agentDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'e2e', defaultModel: FAKE_MODEL_ID })
    );
    prepare?.(run.profile);
    // The harness's keys (a checkout's own .env; none beside the mu a packaged app carries): stamped (never read)
    // before, compared after.
    run.untouched = [join(harness.root, '.env')].map((path) => ({ path, before: stamp(path) }));
    console.log(`[mu e2e] app: ${app ? app.executable : join(desktopRoot, 'out')}`);
    console.log(`[mu e2e] profile: ${where.root}`);
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
    const file = join(run.profile.paths.logs, `${name}.png`);
    if (
      await run.state.page.screenshot({ path: file }).then(
        () => true,
        () => false
      )
    ) {
      await testInfo.attach('screen', { path: file, contentType: 'image/png' });
    }
    const controls = await run.state.page
      .evaluate(() =>
        [...document.querySelectorAll('button, [role="tab"], [role="button"], [data-testid]')]
          .filter((element) => element.checkVisibility())
          .map((element) =>
            [
              element.getAttribute('data-testid'),
              element.getAttribute('data-status'),
              element.getAttribute('aria-label'),
              element.textContent?.trim().slice(0, 40),
            ]
              .filter(Boolean)
              .join(' | ')
          )
      )
      .catch(() => []);
    console.log(`[mu e2e] controls on screen at the failure:\n${controls.join('\n')}`);
    for (const log of [run.state.mainLog, run.state.rendererLog]) {
      if (existsSync(log)) await testInfo.attach(log.split(/[\\/]/).pop() ?? 'log', { path: log });
    }
  });

  /**
   * Makes a native conversation the way a person does: the sidebar's "+", the permission mode (`permissions`: the
   * mode's title as the profile's language shows it, `最小权限`, or none for mu's default), the folder picker (the
   * test answers it with the profile's project). Returns once the conversation's page is open.
   */
  async function newConversation({ permissions } = {}) {
    const p = page();
    await p.getByTestId('native-new').click();
    await expect(p.getByTestId('native-new-panel')).toBeVisible();
    if (permissions) {
      await p.getByTestId('native-permissions').click();
      await p.locator('.arco-select-popup:visible .arco-select-option', { hasText: permissions }).click();
    }
    await p.getByTestId('native-project').click();
    await p.waitForURL(/#\/conversation\/native\//, { timeout: 30_000 });
    run.conversationUrl = p.url();
    await expect(p.getByTestId('native-conversation')).toBeVisible();
  }

  /**
   * A sidebar row's menu button, once it shows. It shows while the row is hovered, and a row that is redrawn under a
   * pointer that stays still (the list settling after a reload, or a window that is not in front) loses the hover, so
   * the pointer goes over the row again until the button is there.
   */
  async function menuButtonOf(row) {
    const button = row.getByTestId('native-sidebar-item-menu');
    await expect(async () => {
      await row.hover();
      await expect(button).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    return button;
  }

  return {
    run,
    sent,
    page,
    paths,
    sleep,
    requests,
    userRows,
    replies,
    status,
    dialogs,
    toolCalls,
    hostFailure,
    orHostFailure,
    stamp,
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
    openToolBox,
    sendAndAnswer,
    newConversation,
    menuButtonOf,
  };
}
