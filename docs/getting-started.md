# Getting started

mu comes two ways: a desktop app that carries everything it needs, and the `mu` command line. They share accounts, settings, sessions and lessons, so you can use both.

## The desktop app

1. Download the build for your system from [Releases](https://github.com/qybaihe/mu/releases/latest):

   | System | File |
   | --- | --- |
   | macOS, Apple silicon | `mu-<version>-mac-arm64.dmg` |
   | macOS, Intel | `mu-<version>-mac-x64.dmg` |
   | Windows x64 / Arm | `mu-<version>-win-x64.exe` / `mu-<version>-win-arm64.exe` |
   | Linux x64 / Arm (Debian, Ubuntu) | `mu-<version>-linux-amd64.deb` / `mu-<version>-linux-arm64.deb` |

   `SHA256SUMS` lists the checksum of every file. The macOS builds are signed and notarized by Apple. The Windows builds are not code-signed yet, so SmartScreen shows a warning the first time ("More info" → "Run anyway").
2. Open it. The first-run guide asks for a model: paste an API key (mu recognises the service from its shape and checks the key with one request), or sign in with a ChatGPT, Claude, Grok or Google subscription.
3. Pick a folder and start a conversation.

Nothing else needs installing: no Node.js, no download at the first start. When a new release is out, the app offers it and downloads it only after you agree.

## The command line

```bash
npm i -g mu-agent      # Node.js 22.19 or newer
mu setup               # connect a model and choose the judge
mu                     # a session in the current directory
```

`mu setup` asks step by step; `mu setup --help` shows the forms for scripts (the key read from stdin, never from the command line). If you skip it, the first `mu` with no model asks once.

Some things to try:

| | |
| --- | --- |
| `mu "fix the failing test in src/pager.test.ts"` | start with a prompt |
| `mu -p "summarise this repository"` | answer once and exit |
| `mu -c` / `mu -r` | continue the last session / pick one to resume |
| `mu import --list` | find Claude Code and Codex conversations to bring in |
| `mu doctor` | check the installation, the judges and the connections |
| `mu ledger 3` | what the judge decided in the last three sessions |

Inside a session, `/status` shows the judge, each decision point's mode and the latest verdicts; `/help` lists every command. The [README](../README.md#command-line) has the full list.

## The judge

mu asks a small, fast judge the routine questions of a session. You do not have to set one up: with no Jev key, the free Jev on OpenCode Zen answers, and mu tells you once a day. To use your own key, a local judge, or another model, see [Judges](judges.md).

## Decisions and their modes

Every decision point is **active** from the start: the judge is asked and mu acts on its verdicts. Each verdict is logged, so you can read what it decided (`/status`, `mu ledger`, or the judgments tab in the app).

To watch the judge before trusting it, set the default mode to **shadow**: the judge is still asked and its verdicts are logged, but they change nothing. In `~/.mu/agent/mu.json`:

```json
{ "modes": { "default": "shadow" } }
```

or `/mu mode default shadow` for the current session. The app's settings (Settings → decision points) switch each point, and the default, on or off; a point in shadow shows as off there.

Single points can be set to shadow or switched off on their own; see [Configuration](configuration.md). Two things work regardless of the mode: the permission mode you choose (*Jev approves* is the opt-in for `tool.approval`), and the `judge_items` tool when the model calls it.

## Permissions

How much mu may do without asking is the permission mode, shown in the status line and in the app's send box. Switch with `/permissions`:

- **Full access**: everything runs.
- **Jev approves** (the default): reading and edits inside the project run; anything else runs only when the judge is sure the task needs it, and otherwise mu asks you.
- **Minimal permissions**: only reading runs without asking.

Risky commands (`rm -rf`, force pushes, `sudo`, a downloaded script…) are never allowed for a whole conversation, and the constraints you state ("don't touch the migrations") hold in every mode. More in [the permissions design note](../kyrn/docs/features/permissions.md).

## Where things live

| Path | What |
| --- | --- |
| `~/.mu/agent/mu.json` | mu's settings: judges, modes, features |
| `~/.mu/agent/auth.json`, `models.json`, `settings.json` | pi's sign-ins, providers and preferences |
| `~/.mu/agent/sessions/` | sessions, shared by the app and the command line |
| `~/.mu/agent/mu/lessons.jsonl` | the lessons library |
| `~/.mu/agent/mu/permissions.json` | the permission mode you last chose |
| `~/.mu/backups/` | copies `mu setup` makes before it changes a file |

On Windows, `~` is your user folder (`%USERPROFILE%`).

## Next

- [Configuration](configuration.md): settings, environment variables, per-point modes and judges.
- [Judges](judges.md): which judge answers, and how to compare them.
- [Decision points](reference/decision-points.md): every question mu asks.
- [Troubleshooting](troubleshooting.md): when something does not work.
