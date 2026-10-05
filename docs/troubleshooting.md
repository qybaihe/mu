# Troubleshooting

Start with `mu doctor` (or `/doctor` in a session): it checks the installation, the model, the judges and the connections, and says what to fix. The desktop app's logs are one click away in Settings → About.

If none of this helps, [open an issue](https://github.com/qybaihe/mu/issues/new/choose) with the version, the platform and the `mu doctor` output.

## Installing and starting

**`mu needs Node >= 22.19 (found v20…)`.** The command line needs Node.js 22.19 or newer: `nvm install 24`, or your system's package. The desktop app carries its own and needs nothing.

**Windows shows a SmartScreen warning.** The Windows builds are not code-signed yet. Choose "More info" → "Run anyway". The checksums of every download are in `SHA256SUMS` on the release page.

**Windows: the conversation says Git for Windows is missing.** mu runs commands in a POSIX shell on Windows; install [Git for Windows](https://git-scm.com/download/win) and start a new conversation.

**The app installed in `C:\Program Files\mu` cannot start mu.** Fixed in 0.1.5 ([#4](https://github.com/qybaihe/mu/issues/4)): install the latest release over the old one; your data stays.

**`mu install`, `mu list` or `mu config` starts a session instead.** Fixed after 0.1.7 ([#8](https://github.com/qybaihe/mu/issues/8)), in the next release; a checkout of `main` has it now.

## Models and networks

**No model is set up.** Run `mu setup`, or the app's first-run guide: paste an API key or sign in with a subscription.

**"User location is not supported", or requests time out, in the app but not in a terminal.** The model's service refuses your network's region, or the app does not see your proxy. Since 0.1.5 the app follows the system proxy when `HTTPS_PROXY` is not set; check that the proxy is on, or set `HTTPS_PROXY` for mu.

## The judge

**The judge seems to do nothing.** On a fresh install every decision point runs in shadow: verdicts are recorded and change nothing. `/status` shows the modes; see [Getting started](getting-started.md#turning-the-decisions-on) to switch them on.

**"No judge is available yet, so mu asks about each step."** In the *Jev approves* permission mode, mu asks you about every step that needs approval when no judge can answer: no key and the free Jev unavailable, an exhausted account, or only a local judge, which is not trusted with approvals. Set a Jev key (`mu setup`), or switch the permission mode with `/permissions`.

**The free Jev stopped answering.** It is OpenCode Zen's limited-time offer; mu says so when it ends. Set a key for one of the [Jev services](judges.md#hosted-jev), or choose another judge.

**Verdicts are slow.** Every decision point has a wait limit, after which mu carries on without the verdict; nothing blocks for long. `mu ledger --json` shows each verdict's latency. A judge far away on the network, or a busy one, can be replaced per point with `routes`.

**The local judge wants to download a model.** Laya's model is several hundred megabytes; mu downloads it only after you agree, in `mu judge setup` or in the app.

## The terminal UI

**The terminal UI crashes with "Rendered line … exceeds terminal width" when a sub-agent starts.** Fixed after 0.1.7 ([#7](https://github.com/qybaihe/mu/issues/7)). Until the next release, widen the terminal past the status line.

## Starting over

`mu setup` copies every file it changes to `~/.mu/backups/<time>/` first. To reset mu's own settings, move `~/.mu/agent/mu.json` away; mu starts with its defaults. Sessions, sign-ins and lessons are separate files (see [Getting started](getting-started.md#where-things-live)) and stay.
