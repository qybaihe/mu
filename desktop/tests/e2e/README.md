# E2E Testing Guide

## Quick Start

### 1. Build the App

E2E tests launch Electron directly (`electron .`), loading pre-built files from `out/`. **Source code changes require a rebuild before tests can pick them up.**

```bash
# Full build (main + preload + renderer)
bunx electron-vite build
```

> `bun run start` (`electron-vite dev`) uses Vite's HMR and hot-reloads automatically.
> E2E tests do NOT use Vite dev server — they load static files from `out/`.

### 2. Ensure `aioncore` is on PATH

The Electron main process spawns the `aioncore` binary during startup and
exposes its port to the renderer via `window.__backendPort`. The binary is
located via `which aioncore`, so it must be reachable from the `PATH`
inherited by the Playwright runner. If it isn't, `__backendPort` will be `0`
and every HTTP call from the renderer (or from e2e helpers that use
`tests/e2e/helpers/httpBridge.ts`) will fail with `Failed to fetch`.

```bash
# Install the backend binary (builds to ~/.cargo/bin/aioncore)
cd ../AionCore && cargo install --path crates/aionui-app

# Make sure it's on PATH when running tests
export PATH="$HOME/.cargo/bin:$PATH"
```

### 3. Run Tests

```bash
# All E2E tests
bun run test:e2e

# Specific test file
npx playwright test --config playwright.config.ts tests/e2e/specs/team-workspace-migration.e2e.ts --reporter=list
```

### 3. View Results

```bash
# Open HTML report
npx playwright show-report tests/e2e/report
```

Screenshots, traces, and videos are saved to `tests/e2e/results/`.

---

## Architecture

### App Lifecycle

```
Playwright launches Electron app (singleton per worker)
    → App loads out/main/index.js
    → Main process creates BrowserWindow
    → Renderer loads out/renderer/index.html (HashRouter)
    → Tests interact with the renderer page
    → App persists across ALL test files (no restart between describes)
    → App closes when worker exits
```

**Key design decision:** One Electron instance shared across all tests. Restarting costs ~25-30 seconds, so tests reuse the same app process.

### Two Launch Modes

| Mode                      | Trigger                   | What it runs                   | Use case          |
| ------------------------- | ------------------------- | ------------------------------ | ----------------- |
| **Dev** (default locally) | `E2E_DEV=1` or no env var | `electron .` from project root | Local development |
| **Packaged**              | `E2E_PACKAGED=1` or CI    | Built app from `out/`          | CI pipelines      |

Both modes load pre-built files from `out/`. The difference is packaged mode uses `NODE_ENV=production` and the platform-specific executable.

### Directory Structure

```
tests/e2e/
├── fixtures.ts         # Electron app launch, page fixture, singleton management
├── helpers/
│   ├── index.ts        # Re-exports all helpers
│   ├── bridge.ts       # invokeBridge() — IPC communication with main process
│   ├── navigation.ts   # Route helpers (navigateTo, goToGuid, goToSettings)
│   ├── conversation.ts # Chat helpers (sendMessage, waitForAiReply, selectAgent)
│   ├── selectors.ts    # CSS selectors for UI elements
│   ├── assertions.ts   # Custom assertions (expectBodyContainsAny, error collector)
│   ├── extensions.ts   # Extension snapshot helpers
│   ├── assistantSettings.ts # Assistant CRUD helpers
│   ├── teamConfig.ts   # TEAM_SUPPORTED_BACKENDS whitelist
│   └── screenshots.ts  # Manual screenshot helper
├── specs/
│   ├── README.md       # Team E2E spec (rules for team tests)
│   ├── app-launch.e2e.ts
│   ├── team-create.e2e.ts
│   ├── team-workspace-migration.e2e.ts
│   └── ...             # ~30+ test files
├── results/            # Test artifacts (gitignored)
├── report/             # HTML report (gitignored)
└── screenshots/        # Manual screenshots (gitignored)
```

---

## Writing Tests

### Basic Pattern

```ts
import { test, expect } from '../fixtures';
import { invokeBridge, navigateTo } from '../helpers';

test.describe('Feature Name', () => {
  test('what it should do', async ({ page, electronApp }) => {
    // 1. Navigate
    await navigateTo(page, '#/some-route');

    // 2. Interact
    const input = page.locator('textarea').first();
    await input.fill('Hello');
    await input.press('Enter');

    // 3. Assert UI
    await expect(page.locator('text=Hello')).toBeVisible({ timeout: 10_000 });

    // 4. Assert backend (optional)
    const data = await invokeBridge(page, 'some.bridge-key', { param: 'value' });
    expect(data.field).toBe('expected');
  });
});
```

### Key Helpers

| Helper                           | Purpose                                            | Import from  |
| -------------------------------- | -------------------------------------------------- | ------------ |
| `invokeBridge(page, key, data)`  | Call main process IPC                              | `../helpers` |
| `navigateTo(page, hash)`         | Navigate via sidebar UI                            | `../helpers` |
| `waitForAiReply(page)`           | Wait for AI response (handles Shadow DOM)          | `../helpers` |
| `selectAgent(page, backend)`     | Select an available assistant for a backend        | `../helpers` |
| `sendMessageFromGuid(page, msg)` | Send message and get conversation ID               | `../helpers` |
| `deleteConversation(page, id)`   | Delete conversation by ID (cleanup)                | `../helpers` |
| `MODE_SELECTOR`                  | Mode selector pill `[data-testid="mode-selector"]` | `../helpers` |
| `modeMenuItemByValue(value)`     | Mode dropdown item `[data-mode-value="..."]`       | `../helpers` |

### invokeBridge Rules

| Allowed                                                 | Forbidden                                         |
| ------------------------------------------------------- | ------------------------------------------------- |
| **Setup:** read initial state (`team.list`, `team.get`) | **Trigger operations** (add member, send message) |
| **Assert:** verify backend matches UI                   | Operations MUST go through UI interaction         |
| **Cleanup:** delete test data (`team.remove`)           |                                                   |

### Timeout Guidelines

| Operation                                | Timeout            |
| ---------------------------------------- | ------------------ |
| UI element visibility                    | 5,000 - 15,000ms   |
| Navigation + settle                      | 10,000ms           |
| AI response (single model)               | 120,000ms          |
| Team operations (leader inference + MCP) | 60,000 - 120,000ms |
| Member initialization                    | 60,000ms           |

### Mocking Native Dialogs (Electron)

```ts
// Mock file open dialog
await electronApp.evaluate(async ({ dialog }, targetPath) => {
  dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [targetPath] });
}, '/path/to/target');
```

### Shadow DOM

AI message text renders inside Shadow DOM (`.markdown-shadow`). Use the `waitForAiReply()` helper which handles this automatically. If you need raw access:

```ts
const text = await page.evaluate(() => {
  const el = document.querySelector('.message-item.text.justify-start:last-child');
  const shadow = el?.querySelector('.markdown-shadow');
  return shadow?.shadowRoot?.textContent?.trim() ?? '';
});
```

### Screenshots

```ts
// Manual screenshot (saved to tests/e2e/results/)
await page.screenshot({ path: 'tests/e2e/results/my-step.png' });
```

Failed tests automatically get screenshots attached to the HTML report.

---

## The mu conversation test

`tests/e2e/mu-conversation/` runs one whole conversation through the app against a local fake model, with no
account, no key and no network:

```bash
bun run e2e:conversation                 # builds out/, then runs the test
bun run e2e:conversation --skip-build    # out/ is already fresh
bun run e2e:conversation --native        # the native host's tests (the default) instead of the conversation on AionCore (MU_NATIVE_HOST=0)
MU_E2E_KEEP=1 bun run e2e:conversation   # keep the profile after a pass too
bun run e2e:conversation --app out --arch arm64   # the packaged app electron-builder left in out/
MU_E2E_WINDOW=819x691 bun run e2e:conversation --skip-build   # the window a 1024 x 768 screen gives (Windows runner)
```

What it does, in order (each step fails on any error nothing handled: page errors, a page's error screen, the main
process's and the adapter's reports):

1. A fresh start opens the guide; the fake model is added in 设置 → 提供商 as an OpenAI-compatible endpoint (测试连接
   lists its model) and picked as the default model.
2. A plain reply streams in, in several pieces.
3. In 最小权限 a `write` asks with exactly one card; 允许这一次 writes the file and the turn finishes.
4. A `bash` call answered 不允许 reaches the model as a refusal; the conversation goes on.
5. A reply stopped halfway stays stopped; the next message works.
6. 文件 lists the written file; 看板, switched on for the project with the fake model as its writer, shows its lines
   (no Jev needed).
7. After a quit and a new start the conversation opens with its history, and a new message works.
8. 关于 shows the app's version (the checkout's `package.json`, or a packaged app's own); 检查更新 (against a canned
   GitHub answer offering a newer version) downloads nothing.
9. Nothing kept running after the quit, and nothing landed outside the profile.

How it stays apart from your own setup: everything lives in one temporary folder (`$TMPDIR/mu-e2e-*`, or
`MU_E2E_ROOT`): a home folder (`HOME`; on Windows `USERPROFILE` too, with `APPDATA` and `LOCALAPPDATA` inside it, and
the user's own folders, Documents, Downloads and the rest, which Windows looks for there and must find),
Electron's user data (`AIONUI_E2E_USER_DATA_DIR`), mu's agent folder (`MU_AGENT_DIR`, with the offline mock judge and
every decision point off), the project, and for the checkout's build a linked view of the harness checkout with its own
`.env` (symlinks; on Windows junctions and copies). The environment is built from a short list, so no key of yours
reaches the app; PATH is the system's own folders. The backend's Node.js runtime is declined (`MU_NODE_RUNTIME=later`),
so nothing is downloaded. The app runs in its E2E mode: no mu:// registration, no single-instance lock, no tray, no
update checks.

A packaged app (`--app`, or `MU_E2E_APP`) is the app electron-builder made: `--app` takes its executable, the app (a
`.app`, or the unpacked folder on Windows and Linux) or the builder's output folder, where the app for this system and
`--arch` is taken. It runs the mu and the backend it carries, on its own binary: no harness checkout, AionCore binary or
Node is named to it, and it starts from the profile's home, not the checkout. It checks for updates through
electron-updater on macOS and Windows, whose GitHub feed the test answers in the app's own session for it. The public
repository's `desktop.yml` runs it this way after every build, on Windows x64 and arm64, macOS arm64 and Linux x64 and
arm64 (not on the Intel Mac: its app, built on an arm64 runner, sees an arm64 Mac there and asks for the arm64 app); a
failure uploads the report and the profile's logs as the artifact `conversation-<platform>`. On Windows the test looks
at the processes through one PowerShell it keeps for the run: a new one takes up to 22 s to load what a look needs.

The window keeps the size the app gives it on the screen at hand (80% of its width, 95% of its height): a small
screen (a CI runner's 1024 x 768) folds the sidebar to its rail of icons beside the work panel, so the test finds the
settings and the conversations by what stays visible there. `MU_E2E_WINDOW=<width>x<height>` sets the size, to try another screen's layout.

The fake model (`fakeModel.mjs`, Node's http only) answers by a marker in the last user message (`E2E:PLAIN`,
`E2E:WRITE <path>`, `E2E:BASH <command>`, `E2E:SLOW`, `E2E:ECHO <text>`) and records every request.
`node tests/e2e/mu-conversation/fakeModel.mjs --port 8765` runs it alone.

Needs, for the checkout's build: the harness checkout beside this one (`../KYRN`) or `MU_ROOT`; the AionCore binary
in `resources/bundled-aioncore/<platform>-<arch>/` (or `AIONUI_BACKEND_BIN`); a Node 22.19 or newer on `PATH` or in
nvm (or `MU_E2E_NODE`); an Electron executable: `MU_E2E_ELECTRON`, else `ELECTRON_EXEC_PATH`, else the checkout's
`electron` package, else `kyrn/node_modules/electron` (the one `scripts/kyrn/start` uses; a worktree looks in its main
checkout too). A checkout installed without install scripts has no Electron in its `electron` package: the test then
names the folders it looked in. A packaged app needs none of them. On Linux without a display, run it under
`xvfb-run -a -s "-screen 0 1280x800x24"` (xvfb-run's own screen, 640 x 480, is smaller than the app's narrowest
window). A run takes about four minutes (a minute of it the build); the whole run stops after 20 minutes. After a
failure the profile is kept and its path printed: `logs/main-*.log` (main process output), `logs/renderer-*.log`
(renderer console), `userData/logs/` (backend, with the adapter's errors, and on Windows and Linux the main process's
log), `home/Library/Logs/` (the main process's log on macOS, the only one a packaged app writes), `agent/sessions/`
(mu's sessions). The HTML report is in `tests/e2e/report/mu-conversation`.

---

## Environment Variables

| Variable         | Default                     | Purpose                      |
| ---------------- | --------------------------- | ---------------------------- |
| `E2E_PACKAGED=1` | unset (dev mode)            | Use packaged app from `out/` |
| `E2E_DEV=1`      | unset                       | Force dev mode               |
| `TEAM_AGENT`     | all (`claude,codex,gemini`) | Filter team leader types     |
| `CI`             | unset                       | Auto-selects packaged mode   |

Variables set automatically during test launch:

| Variable                     | Value | Purpose                  |
| ---------------------------- | ----- | ------------------------ |
| `AIONUI_E2E_TEST`            | `1`   | App recognizes test mode |
| `AIONUI_DISABLE_AUTO_UPDATE` | `1`   | No update checks         |
| `AIONUI_DISABLE_DEVTOOLS`    | `1`   | No DevTools windows      |
| `AIONUI_CDP_PORT`            | `0`   | CDP disabled             |

---

## NPM Scripts

| Command                           | Scope                    |
| --------------------------------- | ------------------------ |
| `bun run test:e2e`                | All E2E tests            |
| `bun run test:e2e:team`           | All `team-*.e2e.ts`      |
| `bun run test:e2e:team:create`    | Team creation only       |
| `bun run test:e2e:team:lifecycle` | Add + fire members       |
| `bun run test:e2e:team:whitelist` | Agent whitelist dropdown |
| `bun run test:e2e:team:comm`      | Message sending          |

### Examples

```bash
# Run all E2E locally (dev mode, requires build first)
bunx electron-vite build && bun run test:e2e

# Run only team tests with list reporter
bun run test:e2e:team

# Run specific test file
npx playwright test --config playwright.config.ts tests/e2e/specs/app-launch.e2e.ts

# Only test gemini leader type
TEAM_AGENT=gemini bun run test:e2e:team

# Run in packaged mode (CI-like)
E2E_PACKAGED=1 bun run test:e2e
```

---

## Troubleshooting

### Tests fail with stale UI / old behavior

**Cause:** Source changes not rebuilt.

```bash
bunx electron-vite build
```

### `Bridge invoke timeout: xxx`

**Cause:** The IPC provider for `xxx` doesn't exist or wasn't registered.

- Check `src/common/adapter/ipcBridge.ts` for the endpoint definition
- Check the corresponding bridge file (e.g., `src/process/bridge/teamBridge.ts`) for `.provider()` registration
- Rebuild: `bunx electron-vite build`

### App launches but page is blank

**Cause:** Renderer build is missing or corrupted.

```bash
bunx electron-vite build
```

### Tests are flaky with AI responses

- Increase timeout (AI inference varies by load)
- Use `expect.poll()` instead of fixed `waitForTimeout()`
- Add retry logic for MCP confirmation dialogs (see `autoApproveMcpDialogs` pattern)

### Leftover test data in sidebar

```bash
# Clean via database
sqlite3 "~/Library/Application Support/AionUi-Dev/aionui/aionui.db" \
  "DELETE FROM teams WHERE name LIKE 'E2E%';"
```

Or add cleanup at test start:

```ts
const teams = await invokeBridge(page, 'team.list', { userId: 'system_default_user' });
for (const t of teams) {
  if (t.name.startsWith('E2E')) {
    await invokeBridge(page, 'team.remove', { id: t.id }).catch(() => {});
  }
}
```
