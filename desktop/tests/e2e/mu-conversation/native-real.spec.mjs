// @ts-check
/* oxlint-disable no-await-in-loop -- each session is opened, and each step up taken, after the one before */
// The real app on a copy of real sessions. MU_E2E_REAL_SESSIONS names a folder of pi session files (a mu home's
// `agent/sessions`); it is COPIED into the throwaway profile, so the app never opens the originals. The sessions a
// person really has hold what the fakes do not: months of tool calls with huge outputs, images, thinking, compactions,
// sessions imported from other tools. The steps: the sidebar lists every session; each of a spread of them (the biggest,
// the longest, the ones with images, tool calls, thinking, a compaction, the newest, the oldest, and a few more) opens
// and draws rows without an error; the longest reads back to its first message; the palette finds a session by its
// title; and a message is sent to one session of each kind (imported from Codex, imported from Claude Code, made by
// AionCore, made by mu, the biggest file), which must reach the fake model with the session's history and be answered
// in the same file. Those are pointed, in the COPY, at the test's own project folder first, so that continuing one never
// touches a folder of the person's. Prints how long each takes. Off when the variable is not set (nobody else has these
// files); keep the profile with MU_E2E_KEEP=1 to look at the screenshots, and remove it afterwards: it holds a copy of
// the sessions.
import { expect, test } from '@playwright/test';
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeWorld } from './nativeWorld.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REAL = process.env.MU_E2E_REAL_SESSIONS;

test.skip(!REAL, 'MU_E2E_REAL_SESSIONS is not set');

const {
  run,
  page,
  paths,
  requests,
  start,
  stop,
  expectNoProblems,
  expectNothingLeft,
  shot,
  reachSidebar,
  send,
  replyWith,
} = createNativeWorld({ desktopRoot });

/** The rows the message list has drawn. */
const rowsInDom = () => page().locator('[data-testid="message-list-content"] [id^="message-"]');
const sidebarRows = () => page().getByTestId('native-sidebar-item');

/** The text of a message's content: a string, or the text parts of an array. */
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (content ?? []).map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('');

/** What a session file holds, counted (never printed: the text is the person's). */
function look(file) {
  const found = {
    file,
    id: '',
    cwd: '',
    size: statSync(file).size,
    timestamp: '',
    messages: 0,
    tools: 0,
    images: 0,
    thinking: 0,
    compactions: 0,
    /** Which tool the session was imported from (mu's import notice), '' for a session made here. */
    imported: '',
    firstUser: '',
  };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === 'session') {
      found.id = String(entry.id ?? '');
      found.cwd = String(entry.cwd ?? '');
      found.timestamp = String(entry.timestamp ?? '');
    } else if (entry.type === 'compaction') {
      found.compactions += 1;
    } else if (entry.type === 'custom_message' && entry.customType === 'mu.import') {
      found.imported = /Claude Code/i.test(textOf(entry.content)) ? 'Claude Code' : 'Codex';
    } else if (entry.type === 'message' && entry.message) {
      found.messages += 1;
      const content = entry.message.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part?.type === 'image') found.images += 1;
          if (part?.type === 'toolCall') found.tools += 1;
          if (part?.type === 'thinking') found.thinking += 1;
        }
      }
      if (!found.firstUser && entry.message.role === 'user') found.firstUser = textOf(content);
    }
  }
  return found;
}

/** Every session file under a `sessions` folder: `<folder>/<file>.jsonl`. */
function sessionFiles(root) {
  return readdirSync(root).flatMap((folder) => {
    const dir = join(root, folder);
    if (!statSync(dir).isDirectory()) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => join(dir, name));
  });
}

/** A number from an id, the same one each run, so the spread of sessions is the same each run. */
const spread = (id) => [...id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 1_000_003, 7);

/** The sessions to open: one of each kind that exists, then a few more, without repeats. */
function picks(all) {
  const best = (key) => all.filter((one) => one[key] > 0).toSorted((a, b) => b[key] - a[key])[0];
  const chosen = new Map();
  const add = (label, one) => {
    if (one && !chosen.has(one.id)) chosen.set(one.id, { ...one, label });
  };
  add('biggest file', all.toSorted((a, b) => b.size - a.size)[0]);
  add('most messages', best('messages'));
  add('most images', best('images'));
  add('most tool calls', best('tools'));
  add('most thinking', best('thinking'));
  add('most compactions', best('compactions'));
  const byTime = all.filter((one) => one.timestamp).toSorted((a, b) => a.timestamp.localeCompare(b.timestamp));
  add('oldest', byTime[0]);
  add('newest', byTime.at(-1));
  for (const one of all.toSorted((a, b) => spread(a.id) - spread(b.id)).slice(0, 6)) add('spread', one);
  return [...chosen.values()];
}

/** The biggest file of some sessions. */
const biggest = (list) => list.toSorted((a, b) => b.size - a.size)[0];
/** A file that is not a stress case: continuing it should take seconds. */
const modest = (one) => one.size < 3_000_000;

/** One session of each kind to continue: not too big (a stress case of its own comes last), with something to answer. */
function continuePicks(all) {
  const usable = all.filter((one) => one.messages > 1 && one.firstUser);
  const chosen = new Map();
  const add = (label, one) => {
    if (one && !chosen.has(one.id)) chosen.set(one.id, { ...one, label });
  };
  add('imported from Codex', biggest(usable.filter((one) => one.imported === 'Codex' && modest(one))));
  add('imported from Claude Code', biggest(usable.filter((one) => one.imported === 'Claude Code' && modest(one))));
  add(
    'made by AionCore',
    biggest(usable.filter((one) => one.firstUser.trimStart().startsWith('[Assistant Rules]') && modest(one)))
  );
  add('made by mu, with tool calls', biggest(usable.filter((one) => !one.imported && one.tools > 0 && modest(one))));
  add('with images', biggest(usable.filter((one) => one.images > 0 && modest(one))));
  add('the biggest file', biggest(usable));
  return [...chosen.values()];
}

/** Points a session of the copy at another project folder (its header's `cwd`). */
function retarget(file, cwd) {
  const text = readFileSync(file, 'utf8');
  const end = text.indexOf('\n');
  const header = JSON.parse(end === -1 ? text : text.slice(0, end));
  header.cwd = cwd;
  writeFileSync(file, `${JSON.stringify(header)}${end === -1 ? '' : text.slice(end)}`);
}

/** @type {ReturnType<typeof look>[]} */
let sessions = [];
/** @type {ReturnType<typeof continuePicks>} */
let continuing = [];
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

test('the sidebar lists every session of the copy', async () => {
  const target = join(paths().agentDir, 'sessions');
  cpSync(/** @type {string} */ (REAL), target, { recursive: true });
  sessions = sessionFiles(target)
    .map(look)
    .filter((one) => one.id);
  const bytes = sessions.reduce((sum, one) => sum + one.size, 0);
  const kinds = ['Codex', 'Claude Code', ''].map(
    (kind) => `${sessions.filter((one) => one.imported === kind).length} ${kind ? `from ${kind}` : 'made here'}`
  );
  console.log(`[mu e2e] real sessions: ${sessions.length} (${kinds.join(', ')}), ${(bytes / 1_048_576).toFixed(0)} MB`);
  expect(sessions.length).toBeGreaterThan(0);
  // The ones to continue run in the test's own folder, not in a folder of the person's.
  continuing = continuePicks(sessions);
  for (const one of continuing) {
    retarget(one.file, paths().project);
    one.cwd = paths().project;
  }

  const started = Date.now();
  await start();
  await reachSidebar();
  await expect(sidebarRows().first()).toBeVisible({ timeout: 60_000 });
  console.log(`[mu e2e] the sidebar shows its first rows ${seconds(Date.now() - started)} after the start`);
  const more = page().getByTestId('native-sidebar-more');
  await expect(more).toBeVisible();
  const unfolded = Date.now();
  await more.click();
  await expect(sidebarRows()).toHaveCount(sessions.length, { timeout: 60_000 });
  console.log(`[mu e2e] all ${sessions.length} rows drawn in ${Date.now() - unfolded} ms`);
  await shot('real-sidebar');
  expectNoProblems();
});

test('each picked session opens and draws its rows', async () => {
  const p = page();
  const chosen = picks(sessions);
  console.log(`[mu e2e] opening ${chosen.length} sessions`);
  const table = [];
  for (const one of chosen) {
    const row = p.locator(`[data-testid="native-sidebar-item"][data-id="${one.id}"]`);
    const opened = Date.now();
    await row.scrollIntoViewIfNeeded();
    await row.click();
    // This session's page, with its snapshot in (the page names the conversation it holds and says while it loads).
    await expect(p.locator(`[data-testid="native-conversation"][data-id="${one.id}"]:not([data-loading])`)).toBeVisible(
      {
        timeout: 60_000,
      }
    );
    // Rows, or the empty page of a session with no message the page can show.
    await expect(rowsInDom().first().or(p.getByTestId('native-empty'))).toBeVisible({ timeout: 60_000 });
    const took = Date.now() - opened;
    const drawn = await rowsInDom().count();
    table.push({ label: one.label, mb: (one.size / 1_048_576).toFixed(1), messages: one.messages, drawn, took });
    console.log(
      `[mu e2e] ${one.label}: ${(one.size / 1_048_576).toFixed(1)} MB, ${one.messages} messages, ${one.images} images, ${one.tools} tool calls -> ${drawn} rows in ${seconds(took)}`
    );
    expect(took, `opening the ${one.label} session`).toBeLessThan(30_000);

    if (one.messages > 0) expect(drawn, `rows of the ${one.label} session`).toBeGreaterThan(0);
    if (one.label === 'biggest file' || one.label === 'most images') await shot(`real-${one.label.replace(/ /g, '-')}`);
    expectNoProblems();
  }
  const slowest = table.toSorted((a, b) => b.took - a.took)[0];
  console.log(`[mu e2e] slowest open: ${slowest.label}, ${seconds(slowest.took)}`);
  const heap = await p.evaluate(() => Math.round(/** @type {any} */ (performance).memory?.usedJSHeapSize / 1_048_576));
  console.log(`[mu e2e] page heap after them: ${heap} MB`);
});

test('the session with the most messages reads back to its first message', async () => {
  const p = page();
  const longest = sessions.toSorted((a, b) => b.messages - a.messages)[0];
  const row = p.locator(`[data-testid="native-sidebar-item"][data-id="${longest.id}"]`);
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expect(
    p.locator(`[data-testid="native-conversation"][data-id="${longest.id}"]:not([data-loading])`)
  ).toBeVisible({ timeout: 60_000 });
  await expect(rowsInDom().first()).toBeVisible({ timeout: 60_000 });
  const scroller = p.getByTestId('message-list-scroller');
  // The start of the first message's first line, as the row shows it (a probe with markup in it would not match).
  const probe = longest.firstUser
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.slice(0, 10);
  const firstMessage = probe ? p.getByTestId('native-message-user').filter({ hasText: probe }) : undefined;
  /** Where the first row in the page is: its id, and how many rows are in the page. */
  const top = () =>
    p.evaluate(() => {
      const rows = document.querySelectorAll('[data-testid="message-list-content"] [id^="message-"]');
      return { id: rows[0]?.id ?? '', count: rows.length };
    });
  const reading = Date.now();
  let steps = 0;
  // Steps up until the first message is in the page, or a step puts no earlier row above the first (the top of the
  // session). The page may keep a window of the rows, so its count does not tell: the first row's id does.
  for (;;) {
    if (firstMessage && (await firstMessage.count()) > 0) break;
    const before = await top();
    // The wheel, as a reader turns it: up over the list, hard enough to reach the top of what the page has.
    const box = await scroller.boundingBox();
    if (!box) throw new Error('the list has no box');
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p.mouse.wheel(0, -20_000);
    const moved = await expect
      .poll(async () => (await top()).id !== before.id, { timeout: 5_000 })
      .toBe(true)
      .then(
        () => true,
        () => false
      );
    if (!moved) break;
    steps += 1;
    expect(steps, 'steps up in a session of this size').toBeLessThan(200);
  }
  const total = (await top()).count;
  console.log(
    `[mu e2e] read back ${longest.messages} messages (${longest.tools} tool calls) in ${steps} steps, ${seconds(Date.now() - reading)}; ${total} rows in the page; the first message is ${firstMessage ? ((await firstMessage.count()) > 0 ? 'there' : 'NOT there') : 'not searched for'}`
  );
  if (firstMessage) await expect(firstMessage.first()).toBeVisible();
  // With every row of the session in the page, each place pi compacted it has its line (in the app's language: 压缩).
  const compactionLines = await p.getByTestId('mu-notice').filter({ hasText: '压缩' }).count();
  console.log(
    `[mu e2e] ${compactionLines} compaction lines in the page for ${longest.compactions} compactions in the file`
  );
  if (firstMessage) expect(compactionLines).toBe(longest.compactions);
  await shot('real-first-message');
  if (compactionLines > 0) {
    await p.getByTestId('mu-notice').filter({ hasText: '压缩' }).nth(1).scrollIntoViewIfNeeded();
    await shot('real-compaction-line');
  }
  expectNoProblems();
});

test('a message to a session of each kind reaches the model with its history, and is answered in the same file', async () => {
  const p = page();
  test.setTimeout(20 * 60_000);
  expect(continuing.length, 'sessions to continue').toBeGreaterThan(0);
  const target = join(paths().agentDir, 'sessions');
  const filesBefore = sessionFiles(target).length;
  let n = 0;
  for (const one of continuing) {
    n += 1;
    const word = `CONTINUE-${n}`;
    const row = p.locator(`[data-testid="native-sidebar-item"][data-id="${one.id}"]`);
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await expect(p.locator(`[data-testid="native-conversation"][data-id="${one.id}"]:not([data-loading])`)).toBeVisible(
      {
        timeout: 60_000,
      }
    );
    const asked = requests().length;
    const started = Date.now();
    await send(`E2E:ECHO ${word}`);
    await replyWith(word, 300_000);
    const request = requests()
      .slice(asked)
      .find((each) => each.lastUser.includes(word));
    expect(request, `a request carrying ${word}`).toBeDefined();
    console.log(
      `[mu e2e] continued (${one.label}): ${(one.size / 1_048_576).toFixed(1)} MB, ${one.messages} messages, ${one.tools} tool calls -> the model got ${request?.messageCount} messages (${JSON.stringify(request?.roles)}), ${((request?.bodyBytes ?? 0) / 1_048_576).toFixed(1)} MB; answered in ${seconds(Date.now() - started)}`
    );
    // The history went along with the message (pi may leave some of it out, but not all), and no notice says it failed.
    expect(request?.messageCount ?? 0).toBeGreaterThan(Math.min(one.messages, 4));
    await expect(p.getByTestId('native-command-failed')).toHaveCount(0);
    await expect(p.getByTestId('native-failed')).toHaveCount(0);
    // Written to the session's own file: the person's message and the reply, and no new session file.
    const after = readFileSync(one.file, 'utf8');
    expect(after.split(word).length - 1, `${word} in the session's file`).toBeGreaterThanOrEqual(2);
    // What pi left out of the request: it compacts a history that is over the (fake) model's window before it asks.
    console.log(
      `[mu e2e]   compactions in the file: ${one.compactions} before, ${after.split('\n').filter((line) => line.startsWith('{"type":"compaction"')).length} after`
    );
    await shot(`real-continued-${n}`);
  }
  expect(sessionFiles(target).length).toBe(filesBefore);
  expectNoProblems();
});

test('a session whose project folder is gone opens, and a message to it says what happened', async () => {
  const p = page();
  const gone = sessions
    .filter((one) => one.cwd && !existsSync(one.cwd) && one.messages > 0)
    .toSorted((a, b) => a.size - b.size)[0];
  test.skip(!gone, 'every session of the copy has its project folder');
  console.log(`[mu e2e] a session whose folder is gone: ${gone.messages} messages`);
  const row = p.locator(`[data-testid="native-sidebar-item"][data-id="${gone.id}"]`);
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expect(p.locator(`[data-testid="native-conversation"][data-id="${gone.id}"]:not([data-loading])`)).toBeVisible({
    timeout: 60_000,
  });
  await expect(rowsInDom().first()).toBeVisible({ timeout: 30_000 });
  // The message is not sent (no row of the person's comes of it): mu cannot start in a folder that is gone.
  const box = p.getByTestId('native-send-input');
  await box.click();
  await box.fill('E2E:ECHO FOLDER-GONE');
  await p.getByTestId('native-send').click();
  const failed = p.getByTestId('native-command-failed');
  const started = Date.now();
  await expect(failed).toBeVisible({ timeout: 90_000 });
  console.log(
    `[mu e2e] the message to it got a notice: ${(await failed.innerText()).replace(/\s+/g, ' ').slice(0, 300)} in ${seconds(Date.now() - started)}`
  );
  await shot('real-folder-gone');
  // Said in its own words, with the folder named, and the message still in the box.
  await expect(p.getByTestId('native-command-failed')).toHaveAttribute('data-kind', 'no-folder');
  await expect(p.getByTestId('native-command-failed')).toContainText(gone.cwd);
  await expect(p.getByTestId('native-send-input')).toHaveValue('E2E:ECHO FOLDER-GONE');
  expectNoProblems();
});

test('the palette finds a session by the start of its title', async () => {
  const p = page();
  // A title long enough to be asked for by its start, from the rows on screen.
  const titles = (await sidebarRows().allInnerTexts()).map((text) => text.split('\n')[0].trim());
  const title = titles.find((text) => Array.from(text).length >= 8);
  expect(title, 'a title of at least 8 characters among the sidebar rows').toBeDefined();
  const query = Array.from(title ?? '')
    .slice(0, 8)
    .join('');
  await p.getByTestId('sider-search').first().click();
  const palette = p.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox').fill(query);
  await expect(palette.getByRole('option').filter({ hasText: query }).first()).toBeVisible({ timeout: 10_000 });
  await p.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  expectNoProblems();
});

test('the test stayed in its profile, and left nothing running', async () => {
  await stop();
  expectNoProblems();
  await expectNothingLeft();
  run.passed = true;
});
