// @ts-check
// The source tab beside a native conversation, end to end: pi runs inside the app (native is the default), the project
// folder is a git repository with one commit, and the main process reads it with the git the app's PATH finds. The
// fake model writes a new file (listed as untracked after the run), then changes the committed README.md (listed as
// changed after that run, with nothing clicked; a click shows its diff in 预览); a file the test stages shows under
// staged after the refresh button. Pictured light and dark. Run it with
// `node scripts/kyrn/e2e-conversation.mjs --native -- native-source.spec.mjs` (nativeWorld.mjs, profile.mjs).
//
// A working git first on the app's PATH: the app takes its PATH from the login shell (fix-path), which in the
// profile's home is the system's; on macOS that finds /usr/bin/git, the Xcode stub, which fails until its licence is
// accepted (never by a test). So the profile's home gets a .zprofile and a .bash_profile that put a folder holding only
// a link to a git that runs here first on PATH.
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeWorld } from './nativeWorld.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A git that runs here: the first one on PATH that answers --version, else Homebrew's or /usr/local's. */
function workingGit() {
  const exe = process.platform === 'win32' ? 'git.exe' : 'git';
  const candidates = [
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, exe)),
    '/opt/homebrew/bin/git',
    '/usr/local/bin/git',
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return realpathSync(candidate);
    } catch {
      // The Xcode stub without its licence, or something else that does not run: the next one.
    }
  }
  return undefined;
}

const GIT = workingGit();
test.skip(!GIT || process.platform === 'win32', 'No git that runs on this machine (or Windows: no login shell here)');

const { run, page, paths, sleep, start, stop, expectNoProblems, shot, reachSidebar, send, replyWith, newConversation } =
  createNativeWorld({ desktopRoot });

/** Runs the test's own git in the project: a name and address on the line, the profile's home, no system config. */
const gitIn = (...args) =>
  execFileSync(
    /** @type {string} */ (GIT),
    ['-c', 'user.name=mu E2E', '-c', 'user.email=e2e@mu.invalid', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd: paths().project,
      env: { PATH: process.env.PATH ?? '', HOME: paths().home, GIT_CONFIG_NOSYSTEM: '1' },
      encoding: 'utf8',
    }
  );

// After the world's own set-up (registered first): the project becomes a repository, and the app's PATH gets the git.
test.beforeAll(() => {
  const { root, home } = paths();
  gitIn('init', '-q', '-b', 'main');
  gitIn('add', 'README.md');
  gitIn('commit', '-q', '-m', 'E2E: the first commit');
  const bin = join(root, 'git-bin');
  mkdirSync(bin, { recursive: true });
  symlinkSync(/** @type {string} */ (GIT), join(bin, 'git'));
  const line = `export PATH='${bin}':"$PATH"\n`;
  writeFileSync(join(home, '.zprofile'), line);
  writeFileSync(join(home, '.bash_profile'), line);
  console.log(`[mu e2e] git for the app: ${GIT} (linked in ${bin})`);
});

const tab = (name) => page().locator(`[role="tab"][data-tab="${name}"]`);
const body = (name) => page().locator(`#mu-work-panel-body-${name}`);
const source = () => page().getByTestId('native-source');
const row = (path) => source().locator(`[data-testid="native-source-file"][data-path="${path}"]`);

/**
 * Opens the work panel on a tab and waits until the tab is the one shown. A tab the conversation has not used yet
 * waits under 更多 and is opened from there, as a person would.
 */
async function showTab(name) {
  const p = page();
  if ((await p.getByTestId('work-panel').getAttribute('data-open')) !== 'true') {
    await p.getByRole('button', { name: '展开工作面板' }).click();
    await expect(p.getByTestId('work-panel')).toHaveAttribute('data-open', 'true');
  }
  if (await tab(name).count()) await tab(name).click();
  else {
    await p.getByTestId('work-panel-more').click();
    await p.locator(`[data-testid="work-panel-more-tab"][data-tab="${name}"]`).click();
  }
  await expect(tab(name)).toHaveAttribute('aria-selected', 'true');
}

test('a native conversation in a repository writes a new file', async () => {
  await start();
  await reachSidebar();
  await newConversation({ permissions: '完全访问' });
  await send('E2E:WRITE notes/hello.txt');
  await replyWith('WRITE-DONE');
  expect(page().url()).not.toContain('draft-');
  run.conversationUrl = page().url();
  expectNoProblems();
});

test('源码 lists the new file as untracked, under the branch, and not the committed one', async () => {
  await showTab('source');
  await expect(source()).toHaveAttribute('data-state', 'changes', { timeout: 15_000 });
  await expect(page().getByTestId('native-source-branch')).toHaveText('main');
  await expect(row('notes/hello.txt')).toHaveAttribute('data-group', 'untracked');
  await expect(row('README.md')).toHaveCount(0);
  await shot('source-untracked');
  expectNoProblems();
});

test('a change to the committed file shows after the run, and its diff on a click', async () => {
  // The tab stays in view: the run's end has it read again, with nothing clicked.
  await send('E2E:WRITE README.md');
  await replyWith('README.md');
  await expect(row('README.md')).toHaveAttribute('data-group', 'unstaged', { timeout: 15_000 });
  await expect(row('README.md')).toHaveAttribute('data-kind', 'modified');
  await shot('source-changed');
  await row('README.md').getByRole('button').click();
  await expect(tab('preview')).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  const preview = body('preview');
  await expect(preview).toContainText('Written by the fake model for the E2E test.', { timeout: 15_000 });
  await expect(preview).toContainText('E2E project');
  await shot('source-diff');
  expectNoProblems();
});

test('a file staged outside the app shows under staged after a refresh', async () => {
  gitIn('add', 'notes/hello.txt');
  await showTab('source');
  await expect(source()).toHaveAttribute('aria-busy', 'false', { timeout: 15_000 });
  await page().getByTestId('native-source-refresh').click();
  await expect(row('notes/hello.txt')).toHaveAttribute('data-group', 'staged', { timeout: 15_000 });
  await expect(row('notes/hello.txt')).toHaveAttribute('data-kind', 'added');
  await expect(row('README.md')).toHaveAttribute('data-group', 'unstaged');
  await shot('source-staged');
  expectNoProblems();
});

test('the same tab and diff in the dark theme', async () => {
  const p = page();
  await p.getByTestId('theme-toggle').click();
  await sleep(600);
  await showTab('source');
  await sleep(200);
  await shot('source-dark');
  await row('README.md').getByRole('button').click();
  await expect(body('preview')).toContainText('Written by the fake model for the E2E test.', { timeout: 15_000 });
  await sleep(200);
  await shot('source-diff-dark');
  await p.getByTestId('theme-toggle').click();
  await sleep(600);
  await stop();
  expectNoProblems();
  run.passed = true;
});
