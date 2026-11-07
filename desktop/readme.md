# mu desktop

The desktop app of [mu](../README.md). It runs pi and mu's judgment kernel in an Electron utility process and shows each conversation with the judge's verdicts beside it: the work panel, the kernel bar, the settings drawn from the kernel's manifest, and the first-run guide. People who use mu download it from [Releases](https://github.com/qybaihe/mu/releases); this page is for working on it.

## Run it from this checkout

Install the root dependencies first, so the app runs the mu in the same repository:

```bash
npm install --ignore-scripts               # at the repository root
npm run hydrate:model-catalog              # also at the root: the model list mu reads
cd desktop
bun install
node scripts/prepareBackend.js            # once: the local service the app starts
KYRN_ROOT="$(cd .. && pwd)" bun run start
```

More in [docs/contributing/development.md](docs/contributing/development.md).

## Checks

```bash
bun run lint
bun run format:check
node scripts/check-i18n.js     # after changing text: every key in all 13 languages
bunx tsc --noEmit
bunx vitest run
```

## Where things are

| Path                                                   | What                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `packages/desktop/src/process/`                        | The main process: windows, the native host that runs pi and the kernel, updates |
| `packages/desktop/src/renderer/`                       | The interface: conversations, the work panel, settings, the first-run guide     |
| `packages/desktop/src/common/`                         | What both share, such as the native bridge contract                             |
| `packages/desktop/src/renderer/services/i18n/locales/` | The 13 languages                                                                |
| `tests/unit/`                                          | Unit tests (Vitest)                                                             |

The conventions for code, CSS and text are in [AGENTS.md](AGENTS.md). How mu fits together is in [docs/architecture.md](../docs/architecture.md).

## Origin and license

The app is under the MIT license ([LICENSE](LICENSE)). The files listed in [APACHE-FILES.txt](APACHE-FILES.txt) stay under the Apache License 2.0 ([LICENSE-APACHE](LICENSE-APACHE)). [NOTICE](NOTICE) has the details.
