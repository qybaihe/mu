# Changelog

What changed in each release of mu: the desktop app and the `mu` command line together. Releases are published under [Releases](https://github.com/qybaihe/mu/releases) with their downloads; the `mu-agent` npm package has its own, more detailed [changelog](kyrn/npm/CHANGELOG.md).

mu is in pre-release (0.1.x): names, settings and formats may still change between releases.

## [Unreleased]

### Added

- **Three decision points**, 38 in all:
  - `tool.injection`: results of `web_fetch`, `web_search`, the built-in browser and MCP servers are screened passage by passage; passages carrying instructions aimed at the AI are withheld from the model, with a note where each was. The question's wording comes from [hermes-jev-skills](https://github.com/kerpopule/hermes-jev-skills) (MIT).
  - `turn.continue`: a run that ends on "Let me run the tests next" without doing it, or asks for a go-ahead on work you asked for, is sent back to it; at most twice per message, and never toward a step that is hard to undo. After [oh-my-pi](https://github.com/can1357/oh-my-pi)'s unexpected-stop check (MIT).
  - `judge.items`: a `judge_items` tool the model uses to ask Jev one yes/no question about each of many items (files, log lines, findings), with a probability per item.
- **A judge with no setup.** With no Jev key set, the free Jev on OpenCode Zen answers, and mu says so once a day; set a key and mu uses it from the next question.
- **Classifier models as judges**: `classifier:<provider>/<model>` takes any classifier in pi's model catalog, such as Jev on OpenCode Zen or Cloudflare Workers AI and Cloudflare's Clef. The desktop app's judges page offers them.
- Built on pi 1.0.2.

### Changed

- MCP servers run on pi's built-in client. mu keeps what it adds: servers stay hidden until a task needs them, project servers need your approval, their output is screened and credentials are masked.

### Fixed

- `mu install`, `mu list`, `mu config` and pi's other commands run again instead of being sent to the model as a prompt ([#8](https://github.com/qybaihe/mu/issues/8), [#9](https://github.com/qybaihe/mu/pull/9) by [@nyxmoth](https://github.com/nyxmoth)).
- Sub-agent status no longer crashes the terminal UI in a window narrower than the status line ([#7](https://github.com/qybaihe/mu/issues/7)).
- Closing an MCP server that is still starting stops its process.

## [0.1.6] - 2026-09-30

### Changed

- **Conversations run on mu directly.** The desktop app starts mu in a process of its own and talks to it over one typed stream; the conversation list is mu's own session files, so a session started on the command line shows up in the app and the other way round.

### Added

- In the app: fork from any message, rename, pin, mark unread, archive and delete conversations, the goal line and the context ring above the send box, a queue of steering and follow-up messages you can take back, the images you sent shown in your messages, and the source tab.

### Fixed

- A message to a conversation whose folder is gone says so. A title never shows a key pasted into a message. Every thinking level of a model shows in the picker.
- A run you stop ends as stopped, not failed.

## [0.1.5] - 2026-09-27

### Added

- **Start with an API key.** The first-run guide and `mu setup` recognise the service from the key's shape, check the key with one request, and pick a model to start with ([#3](https://github.com/qybaihe/mu/issues/3)).

### Fixed

- Windows: the app installed in `C:\Program Files\mu` can start mu ([#4](https://github.com/qybaihe/mu/issues/4)).
- mu in the app follows the system's proxy when no `HTTPS_PROXY` is set, as do sign-in and the key check.
- macOS: a conversation no longer puts a bouncing icon in the Dock.

## [0.1.4] - 2026-09-25

### Added

- Choose how Jev is reached (TypeSafe, OpenRouter, the Vercel AI Gateway or your own service), each with its own key; CLM as a judge.
- Providers with an `http://` address on your computer or network, and editable thinking levels per model ([#1](https://github.com/qybaihe/mu/pull/1), [#2](https://github.com/qybaihe/mu/pull/2) by [@drunkduckdrown](https://github.com/drunkduckdrown)).
- Light and dark themes that follow the system; more of the app in your language; `/hive <question>`.

### Fixed

- Many permission, conversation, browser and Windows fixes; mu asks before more kinds of risky commands and keeps credentials away from the judge and the board. Built on pi 0.87.1.

## [0.1.3] - 2026-09-23

### Added

- The app updates itself, after you agree to the download.

### Fixed

- Windows: answering a permission request no longer breaks the conversation; a missing Git for Windows is reported with its download link.
- mu starts on small servers (about 50 MB of heap).

## [0.1.2] - 2026-09-23

Preview build.

## [0.1.1] - 2026-09-23

Preview build.

## [0.1.0] - 2026-09-23

The first preview: the desktop app for macOS (signed and notarized), Windows and Linux, x64 and arm64, with mu inside it, and `mu-agent` on npm.

[Unreleased]: https://github.com/qybaihe/mu/compare/v0.1.6...main
[0.1.6]: https://github.com/qybaihe/mu/releases/tag/v0.1.6
[0.1.5]: https://github.com/qybaihe/mu/releases/tag/v0.1.5
[0.1.4]: https://github.com/qybaihe/mu/releases/tag/v0.1.4
[0.1.3]: https://github.com/qybaihe/mu/releases/tag/v0.1.3
[0.1.2]: https://github.com/qybaihe/mu/releases/tag/v0.1.2
[0.1.1]: https://github.com/qybaihe/mu/releases/tag/v0.1.1
[0.1.0]: https://github.com/qybaihe/mu/releases/tag/v0.1.0
