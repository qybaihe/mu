# Troubleshooting

Start with `mu doctor` (or `/doctor` in a session). It checks the installation, the model, the judges and the connections, and tells you what to fix. In the desktop app, the logs are one click away in Settings → About.

If that doesn't help, [open an issue](https://github.com/qybaihe/mu/issues/new/choose) with the version, the platform and the `mu doctor` output.

## Installing and starting

**`mu needs Node >= 22.19 (found v20…)`.** The command line needs Node.js 22.19 or newer: run `nvm install 24`, or install Node.js with your system's package manager. The desktop app bundles its own Node.js and needs nothing.

**Windows shows a SmartScreen warning.** The Windows builds aren't code-signed yet. Choose "More info" → "Run anyway". The checksums of every download are in `SHA256SUMS` on the release page.

**Windows: the conversation says Git for Windows is missing.** mu runs commands in a POSIX shell on Windows. Install [Git for Windows](https://git-scm.com/download/win) and start a new conversation.

**The app installed in `C:\Program Files\mu` can't start mu.** Fixed in 0.1.5 ([#4](https://github.com/qybaihe/mu/issues/4)). Install the latest release over the old one; your data is kept.

**`mu install`, `mu list` or `mu config` starts a session instead.** Fixed in mu-agent 0.1.8 and the desktop app 0.1.7 ([#8](https://github.com/qybaihe/mu/issues/8)). Update to the latest release.

## Models and networks

**No model is set up.** Run `mu setup`, or follow the app's first-run guide: paste an API key or sign in with a subscription.

**"User location is not supported", or requests time out, in the app but not in a terminal.** Either the model's service doesn't serve your network's region, or the app can't see your proxy. Since 0.1.5 the app follows the system proxy when `HTTPS_PROXY` isn't set. Check that the proxy is on, or set `HTTPS_PROXY` for mu.

## The judge

**The judge seems to do nothing.** A point in shadow mode records its verdicts and changes nothing, and a point that's off isn't asked at all. `/status` shows each point's mode. Look for `"default": "shadow"` or `"off"` in `~/.mu/agent/mu.json`, or `MU_JUDGE_MODE` in your environment. See [Getting started](getting-started.md#decisions-and-their-modes).

**"No judge is available yet, so mu asks about each step."** In *Judge mode*, mu asks you about every step that needs approval when no judge can answer. That happens when there's no key and the free Jev is unavailable, when your judge account has hit its limit, or when your only judges aren't trusted with approvals. Set a Jev key (`mu setup`), or switch the permission mode with `/permissions`.

**The free Jev stopped answering.** It's a limited-time offer from OpenCode Zen, and mu tells you when it ends. Set a key for one of the [Jev services](judges.md#hosted-jev), or choose another judge.

**Verdicts are slow.** Every decision point has a time limit, after which mu carries on without the verdict, so nothing blocks for long. `mu ledger --json` shows each verdict's latency. If a judge is far away on the network or busy, you can replace it per point with `routes`.

**"Laya is no longer built in."** mu used to include Laya, a local judge, and no longer does. Where your `mu.json` named it, mu now uses mude 1.0 if it's set up on this Mac, otherwise your other judges or Jev, and it has updated the file (a copy of the old one is in `~/.mu/backups`). `mu judge setup`, `start`, `stop` and `status` are gone too. For a decision model on your Mac, use [mude 1.0](judges.md#mude-10-on-your-mac) or [add one from Hugging Face](judges.md#other-decision-models).

**mude 1.0 isn't answering.** `mu judge mude status` shows whether its server is running, and `mu judge mude start` starts it. `mu doctor` checks the server and its key. Until it answers, its fallback judges answer instead, or, with `--local-only`, each decision point uses its default. See [mude 1.0](judges.md#mude-10-on-your-mac).

**The mude 1.0 install stopped.** Run `mu judge mude install` again, or press **Continue installing** in the app. It picks up where it left off.

## The terminal UI

**The terminal UI crashes with "Rendered line … exceeds terminal width" when a subagent starts.** Fixed in mu-agent 0.1.8 and the desktop app 0.1.7 ([#7](https://github.com/qybaihe/mu/issues/7)). Update to the latest release.

## Starting over

`mu setup` copies every file it changes to `~/.mu/backups/<time>/` first. To reset mu's own settings, move `~/.mu/agent/mu.json` out of the way, and mu starts with its defaults. Sessions, sign-ins and lessons live in separate files (see [Getting started](getting-started.md#where-things-live)) and aren't affected.
