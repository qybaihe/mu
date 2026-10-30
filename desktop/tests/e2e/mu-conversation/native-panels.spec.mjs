// @ts-check
// The work panel beside a native conversation, end to end: pi runs inside the app (native is the default), the mock judge
// judges in shadow mode (what it says changes nothing pi does), the board is on for the project and written by the fake
// model, and mu's lesson store holds lessons written before the start. Each tab of the panel is opened and pictured,
// light and dark: the folder's files with the one the model wrote, a file in the preview, the folder's lessons, the
// judge's judgments, the board, the sub-agents, source control (here: no repository) and the browser. A file the model writes
// while another tab is in view puts a dot on the files tab (and one the conversation held when it opened does not); one
// it writes while the workspace is in view shows in the preview (following the agent). A tool call's path, quick open
// (Cmd/Ctrl+P) and a local address a command printed each open beside the conversation. An element picked on a page
// in the browser reaches the model's request: where it is, its HTML and a picture of it, and the click never reaches
// the page.
// Run it with
// `node scripts/kyrn/e2e-conversation.mjs --native -- native-panels.spec.mjs` (nativeWorld.mjs, profile.mjs).
import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARD_REPLY, FAKE_MODEL_ID } from './fakeModel.mjs';
import { createNativeWorld } from './nativeWorld.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const WRITTEN = 'notes/hello.txt';
const PROJECT_LESSON = 'E2E-LESSON-PROJECT: run the desktop tests with Node 24 first on PATH.';
const EVERYWHERE_LESSON = 'E2E-LESSON-EVERYWHERE: answer in the language the person writes in.';
const OTHER_LESSON = 'E2E-LESSON-OTHER: this one belongs to another project.';

const {
  run,
  page,
  paths,
  sleep,
  start,
  stop,
  expectNoProblems,
  shot,
  reachSidebar,
  send,
  replyWith,
  newConversation,
  requests,
} = createNativeWorld({ desktopRoot });

/** A page with one button where the test knows it is; a click that reached the page would change its title. */
const SHOP_PAGE = `<!doctype html><html><head><title>E2E shop</title><style>
  body { margin: 0; }
  #buy { all: unset; position: absolute; left: 40px; top: 40px; width: 200px; height: 80px; background: #2563eb; color: #fff; }
</style></head><body><button id="buy" class="primary">Buy now</button>
<script>document.getElementById('buy').addEventListener('click', () => { document.title = 'CLICKED'; });</script>
</body></html>`;

/** A page that writes a warning and an error to its console as it loads, and then throws one nothing catches. */
const CONSOLE_PAGE = `<!doctype html><html><head><title>E2E console</title></head><body><h1>Half broken</h1>
<script>
  console.warn('E2E console slow');
  console.error('E2E console boom');
  setTimeout(() => { throw new Error('E2E uncaught'); }, 0);
</script>
</body></html>`;

/** One line of mu's lesson store, as the harness writes a whole lesson. */
const lessonLine = (id, text, cwd) => {
  const at = new Date().toISOString();
  return JSON.stringify({
    id,
    kind: 'pitfall',
    trigger: `when ${id} comes up`,
    lesson: text,
    scope: cwd ? { cwd } : {},
    source: { origin: 'user' },
    status: 'active',
    uses: { recalled: 0, applied: 0 },
    created: at,
    updated: at,
  });
};

// After the world's own set-up (registered first): what this spec adds to mu's folder before the app starts.
test.beforeAll(() => {
  const { agentDir, project } = paths();
  // Every model takes images here, so a picked element's picture reaches the request as itself.
  const models = join(agentDir, 'models.json');
  const written = JSON.parse(readFileSync(models, 'utf8'));
  for (const model of written.providers.e2e.models) model.input = ['text', 'image'];
  writeFileSync(models, JSON.stringify(written));
  // The mock judge in shadow mode: every decision point asks it, and nothing it says changes what pi does.
  writeFileSync(join(agentDir, 'mu.json'), `${JSON.stringify({ tiers: ['mock'], modes: { default: 'shadow' } })}\n`);
  mkdirSync(join(agentDir, 'mu'), { recursive: true });
  writeFileSync(
    join(agentDir, 'mu', 'lessons.jsonl'),
    `${[
      lessonLine('e2e-project', PROJECT_LESSON, project),
      lessonLine('e2e-everywhere', EVERYWHERE_LESSON),
      lessonLine('e2e-other', OTHER_LESSON, join(dirname(project), 'elsewhere')),
    ].join('\n')}\n`
  );
  // The board on for the project, written by the fake model (the harness's own file, as `/board on` leaves it).
  writeFileSync(
    join(agentDir, 'mu', 'board.json'),
    `${JSON.stringify({ version: 1, projects: { [project]: true }, model: `e2e/${FAKE_MODEL_ID}` })}\n`
  );
});

const tab = (name) => page().locator(`[role="tab"][data-tab="${name}"]`);
const dot = (name) => tab(name).getByTestId('work-panel-dot');
const body = (name) => page().locator(`#mu-work-panel-body-${name}`);

/**
 * Opens the work panel on a tab and waits until the tab is the one shown. A tab the conversation has not used yet
 * waits under 更多 and is opened from there, as a person would.
 */
async function showTab(name) {
  const p = page();
  if ((await p.getByTestId('work-panel').getAttribute('data-open')) !== 'true') {
    const expand = p.getByRole('button', { name: '展开工作面板' });
    await expand.click();
    await expect(p.getByTestId('work-panel')).toHaveAttribute('data-open', 'true');
  }
  if (await tab(name).count()) await tab(name).click();
  else {
    await p.getByTestId('work-panel-more').click();
    await p.locator(`[data-testid="work-panel-more-tab"][data-tab="${name}"]`).click();
  }
  await expect(tab(name)).toHaveAttribute('aria-selected', 'true');
}

test('a native conversation writes a file, with the judge judging and the board on', async () => {
  await start();
  await reachSidebar();
  await newConversation({ permissions: '完全访问' });
  await send(`E2E:WRITE ${WRITTEN}`);
  await replyWith('WRITE-DONE');
  // The page followed the draft to the id pi's session gave it: the one a reopen comes back to.
  expect(page().url()).not.toContain('draft-');
  run.conversationUrl = page().url();
  // The panel counts a finished write when it next reads the view, at most half a second after the reply, and
  // follows it to 预览 if it is open on the workspace by then. It is closed here; the next test opens 文件 at once, so
  // without this pause the write could be counted after that and turn the panel to 预览 under its click (it did on a
  // macOS runner). A closed panel shows no sign of the count to wait for (in a narrow window it is not drawn at all).
  await sleep(2_000);
  expectNoProblems();
});

test('the work panel shows the folder, its lessons, the judge’s judgments, the board and the browser', async () => {
  const p = page();

  await test.step('文件 lists the folder and the file the model wrote', async () => {
    await showTab('files');
    const files = p.getByTestId('native-files');
    await expect(files).toBeVisible();
    await expect(files.getByText('README.md', { exact: true })).toBeVisible();
    await files.getByText('notes', { exact: true }).click();
    await expect(files.getByText('hello.txt', { exact: true })).toBeVisible({ timeout: 15_000 });
    await shot('panel-files');
  });

  await test.step('a file opens in 预览', async () => {
    await p.getByTestId('native-files').getByText('hello.txt', { exact: true }).click();
    await expect(tab('preview')).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
    await expect(body('preview').locator('[data-project-preview-region]')).toBeVisible({ timeout: 15_000 });
    await expect(body('preview')).toContainText('Written by the fake model', { timeout: 15_000 });
    await shot('panel-preview');
  });

  await test.step('经验 lists the project’s lessons and those for everywhere, not another project’s', async () => {
    await showTab('lessons');
    const lessons = p.getByTestId('mu-lessons');
    await expect(lessons).toContainText(PROJECT_LESSON, { timeout: 15_000 });
    await expect(lessons).toContainText(EVERYWHERE_LESSON);
    await expect(lessons).not.toContainText(OTHER_LESSON);
    await expect(p.getByTestId('kernel-no-lessons')).toHaveCount(0);
    await shot('panel-lessons');
  });

  await test.step('判定 shows the judgments of the turn', async () => {
    await showTab('judge');
    await expect(p.getByTestId('kyrn-judge')).toBeVisible();
    await expect(p.getByTestId('judge-line').first()).toBeVisible({ timeout: 30_000 });
    const codes = await p.getByTestId('judge-line').evaluateAll((lines) => lines.map((line) => line.dataset.code));
    console.log(`[mu e2e] judge lines: ${codes.join(', ')}`);
    await shot('panel-judge');
  });

  await test.step('看板 shows the board the fake model wrote', async () => {
    await showTab('board');
    const board = p.getByTestId('mu-board');
    await expect(board).toContainText(BOARD_REPLY.now, { timeout: 60_000 });
    await expect(board).toContainText(BOARD_REPLY.progress);
    await shot('panel-board');
  });

  await test.step('蜂群, 源码 and 浏览器 open beside it', async () => {
    await showTab('hive');
    await expect(p.getByTestId('kyrn-hive')).toBeVisible();
    await shot('panel-hive');
    await showTab('source');
    // This project is no repository, and the app's PATH may find no git that runs (the Xcode stub on a Mac): the tab
    // says which (native-source.spec.mjs has a repository and a git).
    await expect(p.getByTestId('native-source')).toHaveAttribute('data-state', /^(no-git|not-repository)$/, {
      timeout: 15_000,
    });
    await expect(p.getByTestId('native-source-note')).toBeVisible();
    await shot('panel-source');
    await showTab('browser');
    await expect(body('browser')).toBeVisible();
    await shot('panel-browser');
  });

  await test.step('the same tabs in the dark theme', async () => {
    await p.getByTestId('theme-toggle').click();
    await sleep(600);
    const picture = async (name) => {
      await showTab(name);
      await sleep(200);
      await shot(`panel-${name}-dark`);
    };
    for (const name of ['files', 'lessons', 'judge', 'board', 'hive', 'source', 'browser']) {
      // oxlint-disable-next-line no-await-in-loop -- one tab after another, as a person clicks them
      await picture(name);
    }
    await p.getByTestId('theme-toggle').click();
    await sleep(600);
  });
  expectNoProblems();
});

test('the panel reads the folder again after the next run, with the files tab in view', async () => {
  const p = page();
  await showTab('files');
  // Not following the agent here: the files tab stays in view while the model writes.
  await p.getByTestId('work-panel-follow').click();
  await expect(p.getByTestId('work-panel-follow')).toHaveAttribute('aria-pressed', 'false');
  const files = p.getByTestId('native-files');
  await expect(files.getByText('hello.txt', { exact: true })).toBeVisible();
  await expect(files.getByText('second.txt', { exact: true })).toHaveCount(0);
  await send('E2E:WRITE notes/second.txt');
  // The reply says what the tool said, which names the file: the first reply's WRITE-DONE does not.
  await replyWith('second.txt');
  // Nothing was clicked: the run's end had the folder read again.
  await expect(files.getByText('second.txt', { exact: true })).toBeVisible({ timeout: 15_000 });
  expectNoProblems();
});

test('following the agent, and what opens beside the conversation: a path, quick open, a local address', async () => {
  const p = page();

  await test.step('a file the model writes shows in 预览 while the workspace is in view', async () => {
    await showTab('files');
    await p.getByTestId('work-panel-follow').click();
    await expect(p.getByTestId('work-panel-follow')).toHaveAttribute('aria-pressed', 'true');
    await send('E2E:WRITE notes/fourth.txt');
    await replyWith('fourth.txt');
    await expect(tab('preview')).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
    await expect(body('preview')).toContainText('fourth.txt', { timeout: 15_000 });
    await expect(body('preview')).toContainText('Written by the fake model');
    await shot('panel-follow');
  });

  await test.step('a tool call’s path opens its file in 预览', async () => {
    await showTab('board');
    await p.getByTestId('tool-call-path').filter({ hasText: 'second.txt' }).first().click();
    await expect(tab('preview')).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
    await expect(body('preview')).toContainText('second.txt', { timeout: 15_000 });
  });

  await test.step('quick open finds a file of the folder by its name', async () => {
    await showTab('board');
    await p.keyboard.press('ControlOrMeta+P');
    const box = p.getByTestId('quick-open');
    await expect(box).toBeVisible();
    await expect(box.locator('[data-path="notes/hello.txt"]')).toBeVisible({ timeout: 15_000 });
    await box.getByRole('combobox').fill('hello');
    await shot('quick-open');
    await p.keyboard.press('Enter');
    await expect(box).toHaveCount(0);
    await expect(tab('preview')).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
    await expect(body('preview')).toContainText('hello.txt', { timeout: 15_000 });
  });

  await test.step('a local address a command printed opens in 浏览器', async () => {
    await showTab('board');
    await send('E2E:BASH echo "ready on http://localhost:5173/"');
    await replyWith('BASH-SAW');
    const chip = p.getByTestId('tool-local-url').filter({ hasText: 'localhost:5173' }).first();
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await shot('local-url-chip');
    await chip.click();
    await expect(tab('browser')).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  });
  expectNoProblems();
});

test('an element picked on a page in the browser reaches the model’s request, with a picture of it', async () => {
  const p = page();
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(SHOP_PAGE);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', () => done(undefined)));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
  /** The page's own title, read in the main process. */
  const shopTitle = () =>
    run.state.app.evaluate(
      ({ webContents }, at) =>
        webContents
          .getAllWebContents()
          .find((contents) => contents.getType() === 'webview' && contents.getURL().startsWith(at))
          ?.getTitle() ?? null,
      url
    );
  try {
    await test.step('the page opens in 浏览器', async () => {
      await showTab('browser');
      const field = p.getByTestId('browser-panel').getByRole('textbox', { name: '输入网址或搜索内容' });
      await field.fill(url);
      await field.press('Enter');
      await expect.poll(shopTitle, { timeout: 15_000 }).toBe('E2E shop');
    });

    await test.step('the picker takes the button the pointer clicks, and the page never hears the click', async () => {
      const pick = p.getByTestId('browser-pick-element');
      await pick.click();
      await expect(pick).toHaveAttribute('aria-pressed', 'true');
      const view = p.getByTestId('browser-panel').locator(`webview[src="${url}"]`);
      const box = await view.boundingBox();
      expect(box, 'the page is on screen').not.toBeNull();
      const x = (box?.x ?? 0) + 140;
      const y = (box?.y ?? 0) + 80;
      await p.mouse.move(x, y, { steps: 4 });
      await sleep(300);
      await shot('element-picker');
      await p.mouse.click(x, y);
      const snippet = p.locator('[data-composer-zone]').getByText('button#buy.primary', { exact: true });
      const taken = await snippet
        .waitFor({ timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      if (!taken) {
        // Where the driver's pointer does not reach into a page, the same pointer events in the page itself.
        console.log('[e2e] the pointer did not reach the page: pointing with events in the page');
        await run.state.app.evaluate(async ({ webContents }, at) => {
          const shop = webContents
            .getAllWebContents()
            .find((contents) => contents.getType() === 'webview' && contents.getURL().startsWith(at));
          await shop?.executeJavaScript(`(() => {
            const box = document.getElementById('buy').getBoundingClientRect();
            const at = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
            window.dispatchEvent(new MouseEvent('mousemove', at));
            window.dispatchEvent(new MouseEvent('click', { ...at, button: 0, cancelable: true }));
          })()`);
        }, url);
      }
      await expect(snippet).toBeVisible({ timeout: 15_000 });
      await expect(pick).toHaveAttribute('aria-pressed', 'false');
      // The picture is the chip's own: it shows on the chip once taken.
      await expect(p.getByTestId('sendbox-dom-snippet')).toHaveAttribute('data-picture', 'true', { timeout: 15_000 });
      expect(await shopTitle(), 'the click stayed with the picker').toBe('E2E shop');
      await shot('element-picked');
    });

    await test.step('the message carries where the element is, its HTML and its picture', async () => {
      await send('E2E:ECHO PICK-OK');
      await replyWith('PICK-OK');
      // The conversation's own request: the board's summary of the run quotes the reply too.
      const asked = requests().findLast((request) => request.lastUser.includes('<button id="buy"'));
      expect(asked?.lastUser).toContain('selector: `#buy`');
      expect(asked?.lastUser).toContain('<button id="buy" class="primary">Buy now</button>');
      expect(asked?.images, 'the picture went as an image').toBe(1);
      await expect(p.getByTestId('sendbox-dom-snippet')).toHaveCount(0);
    });
  } finally {
    server.close();
  }
  expectNoProblems();
});

test('a page’s screenshot and what its console said reach the model’s request', async () => {
  const p = page();
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(CONSOLE_PAGE);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', () => done(undefined)));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
  const consoleButton = p.getByTestId('browser-send-console');
  try {
    await test.step('the page opens in 浏览器, and its console’s count shows on its button', async () => {
      await showTab('browser');
      const field = p.getByTestId('browser-panel').getByRole('textbox', { name: '输入网址或搜索内容' });
      await field.fill(url);
      await field.press('Enter');
      await expect(consoleButton).toBeVisible({ timeout: 15_000 });
      await expect(consoleButton).toHaveAttribute('data-errors', '2', { timeout: 15_000 });
      await shot('browser-console-count');
    });

    await test.step('the screenshot and the console go into the message as two chips, the screenshot with its picture', async () => {
      await p.getByTestId('browser-send-screenshot').click();
      const chips = p.getByTestId('sendbox-dom-snippet');
      await expect(chips.filter({ hasText: '127.0.0.1' })).toHaveCount(1, { timeout: 15_000 });
      await expect(chips.first()).toHaveAttribute('data-picture', 'true');
      await consoleButton.click();
      await expect(chips).toHaveCount(2);
      // Sent again: the newer console chip takes the earlier one's place.
      await consoleButton.click();
      await expect(chips).toHaveCount(2);
      await shot('browser-console-chips');
    });

    await test.step('the message carries the page’s console, oldest first, and the screenshot as an image', async () => {
      await send('E2E:ECHO CONSOLE-OK');
      await replyWith('CONSOLE-OK');
      const asked = requests().findLast((request) => request.lastUser.includes('E2E console boom'));
      // The fake model keeps the message's last 400 characters: the screenshot's line is cut at its start.
      const lines = asked?.lastUser ?? '';
      expect(lines).toContain(`${url} ("E2E console") as it was on screen: the attached image.`);
      expect(lines).toContain(`Console of the page ${url} ("E2E console") since it loaded: 2 errors and 1 warning`);
      expect(lines.indexOf('[warning] E2E console slow')).toBeGreaterThan(-1);
      expect(lines.indexOf('[error] E2E console boom')).toBeGreaterThan(lines.indexOf('[warning] E2E console slow'));
      expect(lines).toContain('Uncaught Error: E2E uncaught');
      expect(asked?.images, 'the screenshot went as an image').toBe(1);
      await expect(p.getByTestId('sendbox-dom-snippet')).toHaveCount(0);
    });
  } finally {
    server.close();
  }
  expectNoProblems();
});

test('a file the model writes while another tab is in view puts a dot on the files tab, and looking at it takes it off', async () => {
  const p = page();
  await showTab('board');
  await expect(dot('files')).toHaveCount(0);
  await send('E2E:WRITE notes/third.txt');
  await replyWith('third.txt');
  await expect(dot('files')).toBeVisible({ timeout: 15_000 });
  await shot('panel-files-dot');
  await tab('files').click();
  await expect(tab('files')).toHaveAttribute('aria-selected', 'true');
  await expect(dot('files')).toHaveCount(0);
  await expect(p.getByTestId('native-files').getByText('third.txt', { exact: true })).toBeVisible({ timeout: 15_000 });
  expectNoProblems();
});

test('after a quit, the reopened conversation’s panel reads its file: judgments, lessons, files', async () => {
  await stop();
  expectNoProblems();
  await start();
  const p = page();
  await reachSidebar();
  await p.getByTestId('native-sidebar-item').click();
  await p.waitForURL(run.conversationUrl, { timeout: 30_000 });
  await expect(p.getByTestId('native-conversation')).toBeVisible();
  // No host: the conversation is read from its session file, which keeps the judge's ledger but no frames.
  await expect(p.getByTestId('native-header-phase')).toHaveAttribute('data-phase', 'idle');
  await showTab('judge');
  await expect(p.getByTestId('judge-line').first()).toBeVisible({ timeout: 30_000 });
  await shot('reopened-judge');
  // The files the conversation holds are where they stand, not news: the panel has read the view by now.
  await sleep(1500);
  await expect(dot('files')).toHaveCount(0);
  await showTab('lessons');
  await expect(p.getByTestId('mu-lessons')).toContainText(PROJECT_LESSON, { timeout: 15_000 });
  await showTab('files');
  await p.getByTestId('native-files').getByText('notes', { exact: true }).click();
  await expect(p.getByTestId('native-files').getByText('second.txt', { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await shot('reopened-files');
  await stop();
  expectNoProblems();
  run.passed = true;
});
