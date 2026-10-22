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

**The app installed in `C:\Program Files\mu` can't start mu.** Fixed in 0.1.5: install the latest release over the old one; your data stays.

**`mu install`, `mu list` or `mu config` starts a session instead.** Fixed in mu-agent 0.1.8 and desktop 0.1.7. Update to the latest release.

## Models and networks {#models}

**No model is set up.** Run `mu setup`, or the app's first-run guide: paste an API key or sign in with a subscription.

**"User location is not supported", or requests time out, in the app but not in a terminal.** The model's service refuses your network's region, or the app doesn't see your proxy. Since 0.1.5 the app follows the system proxy when `HTTPS_PROXY` isn't set; check that the proxy is on, or set `HTTPS_PROXY` for mu.

## The judge {#judge}

**The judge seems to do nothing.** A point in shadow records its verdicts and changes nothing, and one that is off isn't asked. `/status` shows each point's mode; look for `"default": "shadow"` or `"off"` in `~/.mu/agent/mu.json`, or a `MU_JUDGE_MODE` in your environment.

**"No judge is available yet, so mu asks about each step."** In *Judge mode*, mu asks about every step that needs approval when no judge can answer: no key and the free Jev unavailable, an exhausted account or only a local judge, which isn't trusted with approvals. Set a Jev key (`mu setup`), or switch the mode with `/permissions`.

**The free Jev stopped answering.** It is OpenCode Zen's limited-time offer, and mu says so when it ends. Set a key for one of the [Jev services](@docs/judges#jev), or choose another judge.

**Verdicts are slow.** Every decision point has a time limit, after which mu carries on without the verdict; nothing blocks for long. `mu ledger --json` shows each verdict's latency. A slow or distant judge can be replaced per point with `routes`.

**The local judge wants to download a model.** Laya's model is about 930 MB; mu downloads it only after you agree, in `mu judge setup` or in the app.

## The terminal {#terminal}

**The terminal UI crashes with "Rendered line … exceeds terminal width" when a subagent starts.** Fixed in mu-agent 0.1.8 and desktop 0.1.7. Update to the latest release.

## Starting over {#reset}

`mu setup` copies every file it changes to `~/.mu/backups/<time>/` first. To reset mu's own settings, move `~/.mu/agent/mu.json` away; mu starts with its defaults. Sessions, sign-ins and lessons are separate files and stay.
