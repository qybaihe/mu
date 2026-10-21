# Upstream names

The desktop app began as a fork of [AionUi](https://github.com/iOfficeAI/AionUi), and the backend it starts is AionCore, a separate program from the same organization. Everything mu names is mu's: the text the app shows in its 13 languages, its code and comments, its docs, its folders and scripts, its environment variables (`MU_…`), classes, events, globals and storage keys. The backend is "the backend" in code and docs and "the local service" in the app's copy; its built-in agent is "the built-in agent".

An upstream name is left only where something outside mu's code reads or writes it, or where the license requires it. `tests/unit/i18n/noUpstreamNames.test.ts` holds the list of both, and fails on any other line in the repository that names them.

## Names the backend uses

The backend is a separate program; these are the names it reads and writes. The app speaks them in one place each and turns the backend's answers into mu's names where they come in.

| Where                                                                 | What                                                                                                                                                                                                  |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/desktop/src/common/platform/backendNames.ts`                | Its database file, request header, conversation source, Butler id, upload suffix and built-in agent id (`BUILTIN_AGENT`); the prefix of its error codes and its ownership name                        |
| `packages/web-host/src/backend-launcher.ts`                           | The environment variables it reads (`AIONUI_…`) and the lines it prints when it listens and when it is ready (`AIONCORE_LISTENING`, `AIONCORE_READY`)                                                 |
| `packages/desktop/src/common/config/constants.ts`                     | The markers it writes into messages (`[[AION_FILES]]`, `[[AION_SESSIONS]]`, `[[AION_SESSION_MESSAGE]]`)                                                                                               |
| `packages/desktop/src/process/backend/binaryResolver.ts`              | Its binary, `aioncore` (`aioncore.exe` on Windows), as its releases ship it. It runs from `resources/bundled-backend/<platform>-<arch>/`, and `mu` finds the desktop app running by that process name |
| `packages/shared-scripts/src/prepare-backend.js`                      | Its repository, release archives and Actions artifacts, from which the build downloads it                                                                                                             |
| Extensions (`aion-extension.json`, `ExtensionSettingsPage.tsx`)       | The manifest's file name and its `engines.aionui`, and the `aion:` messages between the app and an extension's settings page                                                                          |
| Tests of text the backend sends (`httpBridge.test.ts` and the others) | The upstream names in its errors, assistants and rules, which the tests give `showAsMu`                                                                                                               |

## Names earlier versions left

| Where                                                          | What                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/desktop/src/common/platform/legacyNames.ts`          | What earlier versions wrote to people's machines: the data folder, a development build's profile and shortcuts, the config files, the browser's session partition, the built-in MCP servers' record names. And the old storage keys, CSS classes, background markers and image settings, which are moved to mu's names |
| `packages/desktop/src/process/services/database/migrations.ts` | The SQL that moves the first versions' database                                                                                                                                                                                                                                                                        |
| `resources/windows/`, `scripts/build-with-builder.js`          | What an older installer left (`MU_LEGACY_…`, `LEGACY_NSIS_…`), and the backend's folder before 0.1.10 (`resources/bundled-aioncore`), which an update still checks for a running backend                                                                                                                               |
| `packages/desktop/src/renderer/index.html`                     | The theme saved under its old key, painted before the renderer starts                                                                                                                                                                                                                                                  |

## The license

`NOTICE`, `LICENSE`, `LICENSE-APACHE` and `APACHE-FILES.txt` (made by `scripts/apacheFiles.mjs`) say which files came from AionUi and stay under the Apache License 2.0; those files keep their `Copyright 2025 AionUi (aionui.com)` headers. `kyrn/THIRD_PARTY_NOTICES.md` does the same for the code editor in `kyrn/src/vendor/codeEditor/`, and `.github/workflows/desktop.yml` says it was adapted from AionUi's build pipeline. The root README and its translations credit AionUi in one line each; the guard fails on a second.

## The words in text

What still names the upstream products reaches the screen only from outside the app's copy: an error, an assistant or a tip the backend sends. `showAsMu` (`packages/desktop/src/common/kyrn/displayName.ts`) shows it with mu's name.

| Upstream word             | In the app's own copy | In text that arrives at run time (`showAsMu`) |
| ------------------------- | --------------------- | --------------------------------------------- |
| AionUi, AionUI            | mu                    | mu                                            |
| AionCore                  | the local service     | mu                                            |
| Aion CLI, AionCLI, Aionrs | the built-in agent    | mu                                            |

## Guards

- `tests/unit/i18n/noUpstreamNames.test.ts` fails when a locale value in any of the 13 languages, or a string in the main-process files that build the window, tray, menus, notifications and dialogs, says `aion`; and when any line of the repository says it outside the files and names above. A file on its list that no longer names them has to leave the list.
- `tests/unit/kyrn/displayName.test.ts` covers what `showAsMu` rewrites and what it leaves alone.
- `tests/unit/common-config/legacyNames.dom.test.ts` checks that the old storage keys move to keys the renderer reads, and that the theme saved under an old key is still painted before the renderer starts.
