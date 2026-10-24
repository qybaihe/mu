---
title: Getting started
summary: Install the desktop app or the command line, connect a model and run a first task.
---

## The desktop app {#desktop-app}

1. Download the build for your system from [Releases](https://github.com/qybaihe/mu/releases/latest), or from the [home page](@home#install), which picks your system for you.

   | System | File |
   | --- | --- |
   | macOS, Apple silicon | `mu-<version>-mac-arm64.dmg` |
   | macOS, Intel | `mu-<version>-mac-x64.dmg` |
   | Windows x64 / Arm | `mu-<version>-win-x64.exe` / `mu-<version>-win-arm64.exe` |
   | Linux x64 / Arm (Debian, Ubuntu) | `mu-<version>-linux-amd64.deb` / `mu-<version>-linux-arm64.deb` |

   The Windows builds aren't code-signed yet, so SmartScreen warns the first time: choose **More info**, then **Run anyway**.
2. Open it. The first-run guide walks through four steps: a model, a permission mode, a judge and a start.
   - **Model.** Paste an API key, and mu recognizes the service from the key's format (OpenAI, Anthropic, Google Gemini, xAI, OpenRouter, DeepSeek, Kimi, Qwen, GLM, SiliconFlow and more) and checks it with one request. Or sign in with a ChatGPT, Grok or Google subscription.
   - **Permissions.** *Judge mode* is preselected; see [Permissions and safety](@docs/permissions).
   - **Judge.** On a Mac that can run [mude 1.0](@docs/judges#mude), mu's own decision model, it's preselected, and one click installs it. Otherwise, with no key, Jev (TypeSafe's hosted judge model) answers for free through OpenCode Zen. To send nothing to a judge, choose **No judge**.
   - **Start.** If mu finds Claude Code, Codex or ZCode conversations, it offers to import them.
3. Pick a folder and start a conversation.

## The command line {#command-line}

```bash
npm i -g mu-agent      # Node.js 22.19 or newer
mu setup               # connect a model and choose the judge
mu                     # a session in the current directory
```

To use a ChatGPT, Grok or Google subscription instead of a key, choose it in `mu setup`: mu then starts on `/login`, and you finish signing in in the browser. For scripts, `mu setup --help` shows the non-interactive forms; a key is read from standard input, never from the command line.

Some things to try:

| Command | What it does |
| --- | --- |
| `mu "fix the failing test in src/pager.test.ts"` | Start with a prompt |
| `mu -p "summarize this repository"` | Answer once and exit |
| `mu -c` / `mu -r` | Continue the last session / pick one to resume |
| `mu import --list` | Find Claude Code, Codex and ZCode conversations to bring in |
| `mu doctor` | Check the installation, the judges and the connections |
| `mu ledger 3` | What the judge decided in the last three sessions |

## Your first task {#first-task}

Open a project folder and say what you want done, in your own words. What happens next:

1. **The judge reads your message first** and shows a one-line verdict, such as *multi-step task · full effort*. This takes well under a second; press <kbd>Esc</kbd> to skip it.
2. **The model works.** Long tool output is filtered before it reaches the model; in *Judge mode*, anything the judge isn't sure the task needs waits for you.
3. **When it says it's done**, mu checks whether anything verified the work and nudges it once if not.

To keep it going until a condition holds, use [goal mode](@docs/goal): `/goal all tests in packages/api pass`.

## The judge {#judge}

You don't have to set up a judge: with no Jev key, the free Jev on OpenCode Zen answers, and mu says so once a day. On a Mac with Apple silicon, `mu setup` and the app recommend [mude 1.0](@docs/judges#mude), mu's own decision model, which runs on your Mac. To use your own key, a local judge or another model, see [Judges](@docs/judges).

{points_active} of the {points} decision points act on their verdicts from the start, and each verdict is logged: `/status`, `mu ledger` or the Judge tab in the app. To watch the judge before trusting it, put the decision points in shadow mode: they're still asked and logged, but change nothing.

```json
{ "modes": { "default": "shadow" } }
```

That goes in `~/.mu/agent/mu.json`; `/mu mode default shadow` does the same for the current session only.

## Where things live {#files}

| Path | What |
| --- | --- |
| `~/.mu/agent/mu.json` | mu's settings: judges, modes, features |
| `~/.mu/agent/auth.json`, `models.json`, `settings.json` | pi's sign-ins, providers and preferences |
| `~/.mu/agent/sessions/` | Sessions, shared by the app and the command line |
| `~/.mu/agent/mu/lessons.jsonl` | The lessons library |
| `~/.mu/agent/mu/permissions.json` | The permission mode you last chose |
| `~/.mu/backups/` | Copies `mu setup` makes before it changes a file |

On Windows, `~` is your user folder (`%USERPROFILE%`).
