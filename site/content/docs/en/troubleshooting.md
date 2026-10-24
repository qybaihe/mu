---
title: Troubleshooting
summary: What to check when mu doesn't start, can't reach a model or the judge seems to do nothing.
---

Start with `mu doctor`, or `/doctor` in a session: it checks the installation, the model, the judges and the connections, and says what to fix. In the desktop app, the logs are one click away under Settings → About.

If none of this helps, [open an issue](https://github.com/qybaihe/mu/issues/new/choose) with the version, the platform and the `mu doctor` output.

## Installing and starting {#install}

**`mu needs Node >= 22.19 (found v20…)`.** The command line needs Node.js 22.19 or newer: `nvm install 24`, or your system's package. The desktop app carries its own and needs nothing.

**Windows shows a SmartScreen warning.** The Windows builds aren't code-signed yet. Choose **More info**, then **Run anyway**. The checksums of every download are in `SHA256SUMS` on the release page.

**Windows: the conversation says Git for Windows is missing.** mu runs commands in a POSIX shell on Windows. Install [Git for Windows](https://git-scm.com/download/win) and start a new conversation.

## Models and networks {#models}

**No model is set up.** Run `mu setup`, or the app's first-run guide: paste an API key or sign in with a subscription.

**"User location is not supported", or requests time out, in the app but not in a terminal.** The model's service refuses your network's region, or the app doesn't see your proxy. The app follows the system proxy when `HTTPS_PROXY` isn't set; check that the proxy is on, or set `HTTPS_PROXY` for mu.

## The judge {#judge}

**The judge seems to do nothing.** A point in shadow records its verdicts and changes nothing, and one that is off isn't asked. `/status` shows each point's mode; look for `"default": "shadow"` or `"off"` in `~/.mu/agent/mu.json`, or a `MU_JUDGE_MODE` in your environment.

**"No judge is available yet, so mu asks about each step."** In *Judge mode*, mu asks you about every step that needs approval when no judge can answer: when there's no key and the free Jev is unavailable, or when your judge account has hit its limit. Set a Jev key (`mu setup`), or switch the mode with `/permissions`.

**The free Jev stopped answering.** It is OpenCode Zen's limited-time offer, and mu says so when it ends. Set a key for one of the [Jev services](@docs/judges#jev), or choose another judge.

**Verdicts are slow.** Every decision point has a time limit, after which mu carries on without the verdict; nothing blocks for long. `mu ledger --json` shows each verdict's latency. A slow or distant judge can be replaced per point with `routes`.

**mu says Laya is no longer built in.** Your configuration still named Laya, the local judge mu had until 0.2.4. mu has already put another judge in its place: mude 1.0 if it's set up on your Mac, otherwise the other judges in your list, or Jev. It also updated `mu.json` (the old file is in `~/.mu/backups`). See [Judges](@docs/judges#laya).

**mude 1.0 isn't answering.** `mu judge mude status` shows whether its server is running, and `mu judge mude start` starts it; `mu doctor` checks the server and its key. Until it answers, its fallback judges answer instead, or, with `--local-only`, each decision point uses its default.

**The mude 1.0 install stopped.** Run `mu judge mude install` again, or press **Continue installing** in the app: it picks up where it left off.

## Starting over {#reset}

`mu setup` copies every file it changes to `~/.mu/backups/<time>/` first. To reset mu's own settings, move `~/.mu/agent/mu.json` away; mu starts with its defaults. Sessions, sign-ins and lessons are separate files and stay.
