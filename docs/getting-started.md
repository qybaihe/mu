# Getting started

mu comes in two forms: a desktop app that bundles everything it needs, and the `mu` command line. They share accounts, settings, sessions and lessons, so you can use both.

## The desktop app

1. Download the build for your system from [Releases](https://github.com/qybaihe/mu/releases/latest):

   | System | File |
   | --- | --- |
   | macOS, Apple silicon | `mu-<version>-mac-arm64.dmg` |
   | macOS, Intel | `mu-<version>-mac-x64.dmg` |
   | Windows x64 / Arm | `mu-<version>-win-x64.exe` / `mu-<version>-win-arm64.exe` |
   | Linux x64 / Arm (Debian, Ubuntu) | `mu-<version>-linux-amd64.deb` / `mu-<version>-linux-arm64.deb` |

   `SHA256SUMS` lists the checksum of every file. The macOS builds are signed and notarized by Apple. The Windows builds aren't code-signed yet, so SmartScreen shows a warning the first time ("More info" → "Run anyway").
2. Open the app. The first-run guide asks for a model: paste an API key (mu detects the service from the key's format and checks the key with one request), or sign in with a ChatGPT, Claude, Grok or Google subscription.
3. Pick a folder and start a conversation.

There's nothing else to install: no Node.js, and no download on first launch. When a new release is out, the app offers it and downloads it only after you agree.

## The command line

```bash
npm i -g mu-agent      # Node.js 22.19 or newer
mu setup               # connect a model and choose the judge
mu                     # start a session in the current directory
```

`mu setup` walks you through each step. `mu setup --help` shows the non-interactive forms for scripts (the key is read from stdin, never from the command line). If you skip setup, the first `mu` run without a model asks you to connect one.

Some things to try:

| Command | What it does |
| --- | --- |
| `mu "fix the failing test in src/pager.test.ts"` | Start with a prompt |
| `mu -p "summarize this repository"` | Answer once and exit |
| `mu -c` / `mu -r` | Continue the last session / pick one to resume |
| `mu import --list` | Find Claude Code and Codex conversations to bring in |
| `mu doctor` | Check the installation, the judges and the connections |
| `mu ledger 3` | Show what the judge decided in the last three sessions |

Inside a session, `/status` shows the judge, each decision point's mode and the latest verdicts, and `/help` lists every command. The [README](../README.md#command-line) has the full list.

## The judge

mu asks a small, fast judge model the routine questions that come up in a session. You don't have to set one up: the default is Jev, TypeSafe's hosted judge model, and without a key the free Jev on OpenCode Zen answers. mu reminds you of this once a day. To use your own key, a local judge or another model, see [Judges](judges.md).

## Decisions and their modes

38 of the 40 decision points are **active** from the start: mu asks the judge and acts on its verdicts. `context.compact` and `output.drift` are off until you turn them on. Every verdict is logged, so you can see what the judge decided (`/status`, `mu ledger` or the Judge tab in the app).

To watch the judge before you trust it, set the default mode to **shadow**. The judge is still asked and its verdicts are logged, but they change nothing. In `~/.mu/agent/mu.json`:

```json
{ "modes": { "default": "shadow" } }
```

Or run `/mu mode default shadow` for the current session. In the app, Settings → Decision points has a switch for each point and for the default; a point in shadow mode shows as off there.

You can also put individual points in shadow or turn them off; see [Configuration](configuration.md). Two things work regardless of the mode: the permission mode you choose (*Judge mode* is how you opt in to `tool.approval`), and the `judge_items` tool when the model calls it.

## Permissions

The permission mode controls how much mu may do without asking. It's shown in the status line and in the app's composer. Switch it with `/permissions`:

- **Full access**: everything runs.
- **Judge mode** (the default): reads and edits inside the project run without asking. Anything else runs only when the judge is sure the task needs it; otherwise mu asks you.
- **Ask first**: only reads run without asking.

Risky commands (`rm -rf`, force pushes, `sudo`, running a downloaded script…) can never be allowed for a whole conversation, and the constraints you state ("don't touch the migrations") hold in every mode. More in [the permissions design note](../kyrn/docs/features/permissions.md).

## Where things live

| Path | What |
| --- | --- |
| `~/.mu/agent/mu.json` | mu's settings: judges, modes, features |
| `~/.mu/agent/auth.json`, `models.json`, `settings.json` | pi's sign-ins, providers and preferences |
| `~/.mu/agent/sessions/` | Sessions, shared by the app and the command line |
| `~/.mu/agent/mu/lessons.jsonl` | The lessons library |
| `~/.mu/agent/mu/permissions.json` | The permission mode you last chose |
| `~/.mu/backups/` | Copies `mu setup` makes before it changes a file |

On Windows, `~` is your user folder (`%USERPROFILE%`).

## Next steps

- [Configuration](configuration.md): settings, environment variables, and per-point modes and judges.
- [Judges](judges.md): which judge answers, and how to compare them.
- [Decision points](reference/decision-points.md): every question mu asks.
- [Troubleshooting](troubleshooting.md): what to do when something doesn't work.
