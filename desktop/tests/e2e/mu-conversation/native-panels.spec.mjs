// @ts-check
// The work panel beside a native conversation, end to end: pi runs inside the app (native is the default), the mock judge
// judges in shadow mode (what it says changes nothing pi does), the board is on for the project and written by the fake
// model, and mu's lesson store holds lessons written before the start. Each tab of the panel is opened and pictured,
// light and dark: the folder's files with the one the model wrote, a file in the preview, the folder's lessons, Jev's
// judgments, the board, the sub-agents, source control (here: no repository) and the browser. A file the model writes
// while another tab is in view puts a dot on the files tab (and one the conversation held when it opened does not).
// Run it with
// `node scripts/kyrn/e2e-conversation.mjs --native -- native-panels.spec.mjs` (nativeWorld.mjs, profile.mjs).
import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARD_REPLY, FAKE_MODEL_ID } from './fakeModel.mjs';
import { createNativeWorld } from './nativeWorld.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const WRITTEN = 'notes/hello.txt';
const PROJECT_LESSON = 'E2E-LESSON-PROJECT: run the desktop tests with Node 24 first on PATH.';
const EVERYWHERE_LESSON = 'E2E-LESSON-EVERYWHERE: answer in the language the person writes in.';
const OTHER_LESSON = 'E2E-LESSON-OTHER: this one belongs to another project.';

const { run, page, paths, sleep, start, stop, expectNoProblems, shot, reachSidebar, send, replyWith, newConversation } =
  createNativeWorld({ desktopRoot });

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

/** Opens the work panel on a tab and waits until the tab is the one shown. */
async function showTab(name) {
  const p = page();
  if ((await p.getByTestId('work-panel').getAttribute('data-open')) !== 'true') {
    const expand = p.getByRole('button', { name: '展开工作面板' });
    await expand.click();
    await expect(p.getByTestId('work-panel')).toHaveAttribute('data-open', 'true');
  }
  await tab(name).click();
  await expect(tab(name)).toHaveAttribute('aria-selected', 'true');
}

test('a native conversation writes a file, with Jev judging and the board on', async () => {
  await start();
  await reachSidebar();
  await newConversation({ permissions: '完全访问' });
  await send(`E2E:WRITE ${WRITTEN}`);
  await replyWith('WRITE-DONE');
  // The page followed the draft to the id pi's session gave it: the one a reopen comes back to.
  expect(page().url()).not.toContain('draft-');
  run.conversationUrl = page().url();
  expectNoProblems();
});

test('the work panel shows the folder, its lessons, Jev’s judgments, the board and the browser', async () => {
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
  // No host: the conversation is read from its session file, which keeps Jev's ledger but no frames.
  await expect(p.getByTestId('native-header-phase')).toHaveAttribute('data-phase', 'idle');
  await showTab('judge');
  await expect(p.getByTestId('judge-line').first()).toBeVisible({ timeout: 30_000 });
  await shot('reopened-judge');
  // The three files the conversation holds are where it stands, not news: the panel has read the view by now.
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
