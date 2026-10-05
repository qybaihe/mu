# Contributing to mu

Thank you for helping. Bug reports, fixes, new decision points, measurements of judges, translations and documentation are all welcome, from anyone, in English or Chinese.

> **中文简介**：欢迎用中文提 issue 和 PR。报 bug 请用 Bug 模板，写清版本、系统和复现步骤；想加功能或新判定点，先开 issue 讨论；提交前在本地跑 `npm run check` 和 `./test.sh`（改了桌面端再跑 `desktop/` 里的检查），PR 模板里的清单逐条确认即可。下面是完整说明。

## Contents

- [Ways to contribute](#ways-to-contribute)
- [Ground rules](#ground-rules)
- [The repository](#the-repository)
- [Setting up](#setting-up)
- [Checks and tests](#checks-and-tests)
- [Code style](#code-style)
- [Commits and pull requests](#commits-and-pull-requests)
- [Larger changes](#larger-changes)
- [Dependencies](#dependencies)
- [Upstream: pi and AionUi](#upstream-pi-and-aionui)
- [License of contributions](#license-of-contributions)

## Ways to contribute

- **Report a bug** with the [bug report form](https://github.com/qybaihe/mu/issues/new?template=bug_report.yml). A short report with the version, the platform and the steps to reproduce it is worth more than a long one.
- **Propose a feature** with the [feature request form](https://github.com/qybaihe/mu/issues/new?template=feature_request.yml), or a **new decision point** with the [decision point form](https://github.com/qybaihe/mu/issues/new?template=decision_point.yml).
- **Fix something.** Issues labelled [`good first issue`](https://github.com/qybaihe/mu/labels/good%20first%20issue) and [`help wanted`](https://github.com/qybaihe/mu/labels/help%20wanted) are a good start. Say in the issue that you are on it, so two people do not do the same work.
- **Measure a judge.** Run a decision point in `shadow` with another judge and compare the ledgers (`mu ledger --json`). Numbers on real sessions are the most useful thing a judge change can come with.
- **Translate.** The desktop app speaks 13 languages and the README five; see [docs/translations.md](docs/translations.md).
- **Improve the documentation** in [docs/](docs/README.md). Small fixes can go straight to a pull request.
- **Ask and answer** in [Discussions](https://github.com/qybaihe/mu/discussions).

Security problems are not reported in public issues: see [SECURITY.md](SECURITY.md).

## Ground rules

- **Understand your change.** If you cannot explain what your change does and how it interacts with the rest of mu, it will not be merged. Using AI to write code or text is fine; sending what you have not read and understood is not. When an AI wrote most of an issue or a pull request description, say so in one line.
- **Keep it small and focused.** One fix or one feature per pull request. A refactor that a fix needs goes in its own commit.
- **Behaviour comes with tests.** A fix comes with a test that fails without it; a feature with tests of what it does. Reference the issue next to a regression test (`// https://github.com/qybaihe/mu/issues/7`).
- **Be kind.** Everyone here follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## The repository

mu is a fork of [pi](https://github.com/earendil-works/pi)'s monorepo with a judgment kernel added, plus a desktop app built on [AionUi](https://github.com/iOfficeAI/AionUi).

| Path | What is there |
| --- | --- |
| `packages/kyrn-judge/` | The judgment kernel: decision points (`src/decisions/`), the features that ask them (`src/extension/features/`), judges (`src/providers/`), the ledger, the settings manifest (`src/manifest.ts`, `i18n/manifest.json`, generated `manifest.json`) |
| `packages/coding-agent/`, `packages/ai/`, `packages/agent/`, `packages/tui/`, … | pi's packages: the agent, providers and models, the terminal UI. mu keeps changes here small and marked, so pi can be merged in |
| `kyrn/bin/mu.mjs` | The `mu` launcher: `mu setup`, `mu doctor`, `mu import`, and starting pi with the kernel |
| `kyrn/npm/` | The `mu-agent` npm package and its [changelog](kyrn/npm/CHANGELOG.md) |
| `kyrn/local-judge/` | Laya, the local judge's sidecar |
| `kyrn/docs/` | Design notes and measurements, mostly in Chinese |
| `desktop/` | The desktop app (Electron); mu's parts are under `desktop/packages/desktop/src/**/kyrn/` and `KyrnPanel/` |
| `docs/` | User and contributor documentation |

Both "kyrn" and "mu" appear in names: the project was called KYRN until 2026-09-21. New code says mu where a name is visible to users.

## Setting up

You need Node.js 22.19 or newer (CI uses Node 24) and, for the desktop app, [Bun](https://bun.sh).

```bash
git clone https://github.com/qybaihe/mu.git
cd mu
npm install --ignore-scripts
node kyrn/bin/mu.mjs          # mu from this checkout; Node runs the TypeScript directly
```

To try your build as `mu` everywhere, `node kyrn/bin/mu.mjs link` puts a `mu` command on your PATH that runs this checkout (`mu unlink` removes it).

The desktop app runs against the mu in the same checkout:

```bash
cd desktop
bun install
KYRN_ROOT="$(cd .. && pwd)" bun run start
```

A first start without a model asks for one (`mu setup`). With no Jev key set, the free Jev on OpenCode Zen answers the judge's questions; see [docs/judges.md](docs/judges.md).

## Checks and tests

Run these before you open a pull request. CI runs the same, on Linux, and the kernel's and the app's unit tests on Windows too.

```bash
npm run check      # formatting, lint and types for everything outside desktop/
./test.sh          # unit tests; tests that need a model or a key are skipped without one
```

One test file, from its package:

```bash
cd packages/kyrn-judge
node ../../node_modules/vitest/dist/cli.js --run test/injection.test.ts
```

If your shell has provider keys set (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and the like), unset them for test runs: some end-to-end tests turn on when a key is present and would call a real model.

Tests of the kernel use the mock judge (`MockJudgeProvider`, which answers what the test scripts and a neutral 0.5 otherwise) and pi's test harness (`packages/coding-agent/test/suite/harness.ts`) with its faux model, so they need no network and no key.

For the desktop app:

```bash
cd desktop
bun run lint
bun run format:check
node scripts/check-i18n.js
bunx tsc --noEmit
bunx vitest run
```

## Code style

`npm run check` enforces most of it. Beyond that:

- TypeScript that Node can run by stripping types: no `enum`, `namespace`, parameter properties or `import =`. No `any` unless there is no other way. Imports at the top of the file only.
- Comments say why, not what. Names and messages in plain words.
- Text users see in the kernel comes in Chinese and English (`say({ zh, en })`). Text the desktop app shows is an i18n key, in every one of its 13 languages ([docs/translations.md](docs/translations.md)).
- A key binding is never hard-coded: add it to the defaults, so it stays configurable.
- Decision points never make the model ask the user: a verdict changes what the model does, not whether it asks.

[AGENTS.md](AGENTS.md) holds the full rules for this monorepo; coding agents read it automatically, and it applies to people too.

## Commits and pull requests

Commit messages follow `type(scope): summary`:

- type: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
- scope: `coding-agent` (the harness and the kernel), `desktop`, `ai`, `agent`, `tui`, or none
- summary: what changes for a user, in the present tense, without a trailing period

```
fix(coding-agent): sub-agent status before the first snapshot fits a narrow terminal
```

Put `fixes #123` in the body to close an issue when the change is merged.

Pull requests:

1. Fork, branch from `main`, commit.
2. Fill in the template: what changed, why, how you checked it.
3. CI must pass. A first-time contributor's CI runs after a maintainer approves them, usually within a day.
4. A maintainer reviews. Small follow-ups may be pushed by the maintainer, on your branch or right after the merge.
5. Pull requests are squash-merged, so the title becomes the commit message.

Do not edit the changelogs: maintainers write them when they prepare a release.

## Larger changes

Open an issue before you start on anything that adds a feature, a setting, a decision point or a dependency, or that changes how mu talks to models or stores data. A short description of the problem and the approach saves rework on both sides.

A new decision point needs a question a small judge can answer from a small state, a safe fallback for when no judge answers, tests with the mock judge, settings text and desktop labels. [docs/adding-a-decision-point.md](docs/adding-a-decision-point.md) walks through all of it.

## Dependencies

- Direct dependencies are pinned to exact versions, and lockfile changes are reviewed like code.
- Install with `npm install --ignore-scripts`: lifecycle scripts do not run unless a maintainer decides they must.
- A dependency with an install script needs an explicit allowlist entry (`scripts/generate-coding-agent-install-lock.mjs`).

## Upstream: pi and AionUi

mu merges pi's releases regularly. A bug that is also in pi is best fixed in [pi](https://github.com/earendil-works/pi) first (mention it in your mu issue); one in the desktop shell that AionUi shares can go to [AionUi](https://github.com/iOfficeAI/AionUi). Such issues get the `upstream` label.

## License of contributions

By contributing you agree that your contribution is licensed under the license of the part of the repository it changes: MIT for everything outside `desktop/` ([LICENSE](LICENSE)), Apache 2.0 for `desktop/` ([desktop/LICENSE](desktop/LICENSE)).
