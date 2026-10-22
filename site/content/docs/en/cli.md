---
title: The command line
summary: mu's commands, the slash commands inside a session and what comes from pi unchanged.
---

The `mu` command is pi, the coding agent, with mu's judgment kernel loaded. Everything pi does works as before; mu adds its own commands and the decision points.

```bash
npm i -g mu-agent      # needs Node.js 22.19 or newer
mu                     # an interactive session in the current directory
```

## Starting mu {#starting}

| Command | What it does |
| --- | --- |
| `mu` | An interactive session in the current directory |
| `mu "prompt"` | Interactive, starting with this prompt |
| `mu -p "prompt"` | One shot: print the answer and exit |
| `mu -c` | Continue the last session |
| `mu -r` | Pick a session to resume |
| `mu --help` | Every flag of the agent |

`mu install`, `remove`, `update`, `list` and `config` manage pi packages, as in pi.

## mu's own commands {#commands}

| Command | What it does |
| --- | --- |
| `mu setup` | Connect a model (an API key, or a service from a list) and choose the judge. `mu setup --help` shows the forms for scripts. |
| `mu doctor` | Check the installation, the model, the judges and the connections, and say what to fix |
| `mu ledger [n] [--json]` | What the judge decided in the last n sessions. `--json` gives every record with its probabilities and timings. |
| `mu import --list` | Find your Claude Code and Codex conversations |
| `mu import <file>…` | Bring them into mu, to continue there |
| `mu judge setup \| start \| stop \| status` | The local judge, Laya. `setup` asks before downloading the model. |
| `mu link` / `mu unlink` | Put the `mu` command on your PATH (`~/.local/bin`), or remove it |
| `mu auth status \| login <provider> \| logout <provider>` | Subscription sign-in, as used by the desktop app |
| `mu migrate [--dry-run]` | One-time: move the old `~/.kyrn` folder to `~/.mu` |

## Commands inside a session {#slash-commands}

| Command | What it does |
| --- | --- |
| `/status` | The judge, each decision point's mode, what was left out of the context, the latest verdicts |
| `/mu judge <judges>` | Which judges answer, in order: `laya`, `laya,jev`, `jev-opencode-free`, `classifier:<provider>/<model>`, `llm:<provider>/<model>` |
| `/mu route <point> <judges>` | Give one decision point its own judges |
| `/mu mode <point> <off\|shadow\|active>` | Switch one decision point, or `default` for all, for this session |
| `/frame` | The task frame: the goal, your constraints and where you said them, the acceptance items |
| `/goal <condition>` | Keep working until the condition holds; `/goal clear` ends it |
| `/permissions` | Full access, *Judge mode* or *Ask first* |
| `/board` | Switch the plain-language board on or off for this project; `/board model` picks its model |
| `/remember <text>`, `/lessons`, `/forget <id>` | Keep a lesson, list the lessons, retire one |
| `/review`, `/commit` | Review the changes, findings sorted P0 to P3; split the changes into commits |
| `/checkpoints`, `/rewind` | List the checkpoints; go back to one (`/rewind undo` undoes it) |
| `/agents`, `/swarm` | List subagent roles; see what each subagent is doing |
| `/hive <question>` | Start a hive on a hard question |
| `/browse`, `/jobs` | The built-in browser; background commands |
| `/capabilities`, `/ledger` | Which capabilities are installed and which are open; the latest verdicts |
| `/inherit` | What was taken over from Claude Code, Cursor and Codex, and what wasn't |
| `/import-chat` | Import a Claude Code or Codex conversation |
| `/doctor` | Check the configuration and the connections |

pi's own commands stay as they are: `/model`, `/thinking`, `/login`, `/resume`, `/tree`, `/fork`, `/compact`, `/export`, `/mcp` and the rest.

## The verdict line {#verdict-line}

Before a turn starts, mu waits briefly for the judge's reading of your message and shows it above the editor, for example *◆ jev-1.13-free  multi-step task · full effort · 699 ms*. Press <kbd>Esc</kbd> to start without waiting. The status line shows the permission mode and, while one runs, the goal.

## Environment variables for one run {#env}

| Variable | Effect |
| --- | --- |
| `MU_JUDGE=laya,jev mu` | Judges for this run only. `MU_JUDGE=off` turns the kernel off. |
| `MU_JUDGE_MODE=shadow mu` | Every decision point in shadow for this run |
| `MU_PERMISSIONS=ask mu` | The permission mode for this run: `full`, `judge` or `ask` |
| `MU_LANG=zh-CN mu` | mu's own messages in Chinese (`zh`) or English (anything else) |

The full list is under [Configuration](@docs/configuration#env).
