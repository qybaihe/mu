---
title: Configuration
summary: mu.json, the environment variables, proxies and where the per-feature options are.
---

mu reads pi's settings (models, sign-ins, preferences) and its own, in `~/.mu/agent/mu.json`. The desktop app's settings write the same file: every change made there can be made by hand, and vice versa.

Only your own `mu.json` is read. A project can't change the judge, its address or its modes, because the judge reads your messages.

## mu.json {#mu-json}

```json
{
  "tiers": ["jev"],
  "modes": {
    "default": "active",
    "turn.continue": "shadow",
    "output.drift": "off"
  },
  "routes": {
    "browser.step": ["jev"],
    "memory.capture": ["laya", "jev"]
  },
  "features": {
    "admission": { "testLog": "rules" },
    "board": { "defaultOn": true },
    "ttsr": false
  },
  "writer": "anthropic/claude-haiku-4-5",
  "recordState": false
}
```

| Key | Meaning | Default |
| --- | --- | --- |
| `tiers` | The judges that answer, in order. A later judge only sees what the earlier ones left uncertain. | `["jev"]` |
| `modes` | `default` plus one entry per decision point: `active`, `shadow` or `off` | `{ "default": "active" }` |
| `routes` | A decision point on its own judges, in place of `tiers` | none |
| `judges` | Your own named judges; see [Judges](@docs/judges#custom) | none |
| `features` | Per-feature switches and options: `false` turns a feature off, an object overrides options. Every option is listed under [Features and options](@docs/options). | each feature's defaults |
| `writer` | A small model, as `provider/model`, for what a judge can't do: writing the task frame and lessons. Empty uses the session's model. | none |
| `recordState` | Keep the judged state in the ledger, not only the verdict. Needed to train a judge of your own; off because states hold your content. | `false` |
| `mcp` | mu's own MCP servers: `{ "servers": { "<name>": { "command": … } } }`. Servers from Claude Code, Cursor and Codex are found too. | none |

A part mu doesn't understand falls back to its default instead of stopping mu. A file that can't be parsed at all is reported when a session starts, and the defaults are used.

## Modes in practice {#modes}

- {points_active} of the {points} points act from the start: `context.compact` and `output.drift` stay off until you turn them on, `swarm.patch` is off, and `notify.routing`, `input.interjection` and `turn.drift` are in shadow, recording their verdicts only. To try a judge, or a point you're unsure of, put it in shadow, read the ledger (`mu ledger`, `/status` or the app's Judge tab), then set it back to active.
- `/mu mode <point> <off|shadow|active>` switches one point for the current session; `/mu mode default shadow` all of them. To keep a mode, put it in `mu.json`.
- `MU_JUDGE_MODE=shadow mu` sets the default for one run.

## Environment variables {#env}

Judges and modes:

| Variable | Effect |
| --- | --- |
| `MU_JUDGE` | Judges for this run, comma-separated: `laya`, `laya,jev`, `jev-opencode-free`, `classifier:<provider>/<model>`, `llm:<provider>/<model>`. `off` turns the kernel off. |
| `MU_JUDGE_MODE` | Default mode for this run: `off`, `shadow` or `active` |
| `MU_WRITER` | `provider/model` for the writing model |
| `MU_PERMISSIONS` | Permission mode for this run: `full`, `judge` or `ask` |
| `MU_LOCAL_JUDGE_URL` | Address of a local judge server other than the one `mu judge start` runs |

Keys for the hosted judges, each sent only to its own service: `TYPESAFE_API_KEY`, `MU_JUDGE_OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`, `OPENCODE_API_KEY`, `CLOUDFLARE_API_KEY` with `CLOUDFLARE_ACCOUNT_ID`, `MU_JUDGE_CLM_API_KEY`.

The launcher:

| Variable | Effect |
| --- | --- |
| `MU_AGENT_DIR` | The agent folder, in place of `~/.mu/agent` |
| `MU_NO_SETUP=1` | Never ask to set up a model at the first start |
| `MU_LANG` | mu's own messages in a session: Chinese for `zh…`, English otherwise. The desktop app sets it to the app's language; `mu setup` follows your locale. |
| `MU_LINK_DIR` | Where `mu link` puts the `mu` command, in place of `~/.local/bin` |
| `MU_CHROME` | The Chrome or Chromium the built-in browser uses on the command line |

Each `MU_` variable is also read under its old `KYRN_` spelling.

mu also reads a `.env` file: `~/.mu/.env` for the npm package. Lines are `KEY=VALUE`; nothing in it is executed. `mu setup` writes the Jev key there. Variables already set in your environment win.

## Proxies {#proxies}

mu follows `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`. The desktop app also follows the system proxy (macOS network settings, Windows Internet settings) when no `HTTPS_PROXY` is set. pi's `httpProxy` setting works as well.

## Options people often change {#common}

| Setting | What it does |
| --- | --- |
| `features.admission.testLog` | `"rules"` folds exact repeats in test logs; `"jev"` adds goal-aware selection. Off by default. |
| `features.board.defaultOn` | Start every project with the plain-language board on |
| `features.permissions.mode` | The permission mode of a new conversation before you pick one |
| `features.injection.tools` | Which tools' results are screened for prompt injection |
| `features.continuation.maxNudges` | How often a run that stopped short is sent back, per message |
| `features.swarm.models` | Model tiers subagents may be routed to, cheapest first |
| `features.goal.checkModel` | The model that checks whether a goal holds |

Every feature and option, with defaults and ranges: [Features and options](@docs/options).
