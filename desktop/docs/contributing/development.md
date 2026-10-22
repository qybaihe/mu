# Development

## What you need

- Node.js 22.19 or newer, for the repository root (CI uses Node 24)
- [Bun](https://bun.sh), for `desktop/`
- On Windows, Git for Windows: mu runs commands through its bash

## Run the app from this checkout

The app runs the mu of the same repository, so install the root first:

```bash
npm install --ignore-scripts               # at the repository root
cd desktop
bun install
node scripts/prepareBackend.js            # once: the local service the app starts (see below)
KYRN_ROOT="$(cd .. && pwd)" bun run start
```

`bun run start` starts the renderer's dev server with hot reload and the Electron app. Changes in `packages/desktop/src/renderer/` show at once; changes in the main process (`process/`) need a restart.

### The local service

The app also starts its backend, a separate local service (the `aioncore` binary). `node scripts/prepareBackend.js` downloads the version pinned in `package.json` (`backendVersion`) into `resources/bundled-backend/`. To use a binary of your own, set `MU_BACKEND_BIN` to its path; failing both, the app looks for `aioncore` on `PATH`.

## Checks

```bash
bun run lint
bun run format:check
node scripts/check-i18n.js     # after changing text: every key in all 13 languages
bun run i18n:types             # after adding or removing keys
bunx tsc --noEmit
bunx vitest run                # or one file: bunx vitest run tests/unit/<path>
```

Root checks (`npm run check`, `./test.sh`) cover everything outside `desktop/`; see [CONTRIBUTING.md](../../../CONTRIBUTING.md).

## Building installers

GitHub Actions builds the installers for macOS, Windows and Linux (`.github/workflows/desktop.yml` at the repository root) and publishes them under Releases. To package one locally, the `dist:*` scripts in `package.json` (`dist:mac`, `dist:win`, `dist:linux`) run electron-builder through `scripts/build-with-builder.js`.
