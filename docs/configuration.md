# Configuration

mu reads pi's settings (models, sign-ins and preferences; see [pi's documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#readme)) and its own, in `~/.mu/agent/mu.json`. The desktop app's settings write to the same file, so anything you change there you can also change by hand, and vice versa.

mu reads only your own `mu.json`. A project can't change the judge, its endpoint or the modes, because the judge reads your messages.

## mu.json

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
    "memory.capture": ["mude", "jev"]
  },
  "judges": {
    "my-relay": {
      "type": "typesafe",
      "baseUrl": "https://relay.example.com/v1/systemone",
      "apiKeyEnv": "MY_RELAY_KEY"
    }
  },
  "features": {
    "admission": { "testLog": "rules" },
    "injection": { "tools": ["web_fetch", "web_search", "browse", "mcp__*"] },
    "ttsr": false
  },
  "writer": "anthropic/claude-haiku-4-5",
  "recordState": false
}
```

| Key | Meaning | Default |
| --- | --- | --- |
| `tiers` | The judges that answer, in order. A later judge only sees what the earlier ones left uncertain: `["mude", "jev"]` asks mude 1.0, on your Mac, first. | `["jev"]` |
| `modes` | `default`, plus one entry per decision point: `active` (verdicts take effect), `shadow` (asked and logged, nothing changes) or `off` (not asked). | `{ "default": "active" }` |
| `routes` | Gives a decision point its own judges, in place of `tiers`. | none |
| `judges` | Your own named judges, added to the built-in ones. See [Judges](judges.md#your-own-judge). | none |
| `features` | Per-feature switches and options: `false` turns a feature off, and an object overrides its options. Every feature and option is listed in [reference/features.md](reference/features.md). | Each feature's defaults |
| `writer` | `provider/model-id` of a small generative model for the things a judge can't do: writing the task frame and lessons. If empty, the session's model is used. | none |
| `recordState` | Keep the judged state in the ledger, not just the verdict. You need this to train a local judge on your sessions. Off by default because the states contain your content. | `false` |
| `mcp` | mu's own MCP servers: `{ "servers": { "<name>": { "command": … } } }`. Servers configured for Claude Code, Cursor and Codex are picked up too (`features.inherit`). | none |

If mu doesn't understand part of the file, that part falls back to its default and mu keeps running. If the file can't be parsed at all, mu reports it when a session starts and uses the defaults. An older `kyrn.json` is read only when there's no `mu.json`.

## Modes in practice

- 34 of the 40 points act from the start: `context.compact` and `output.drift` are off until you turn them on, `capability.disclosure` and `swarm.patch` are off, and `notify.routing` and `turn.drift` are in shadow. With `capability.disclosure` off, packs and MCP servers stay hidden and the model opens one with `find_capability`; `"capability.disclosure": "active"` in `modes` has the judge open them again. To try out a judge, or a point you're unsure of, put the point in shadow mode, read the ledger (`mu ledger`, `/status` or the app's Judge tab), then set it back to active once its verdicts look right.
- `/mu mode <point> <off|shadow|active>` switches one point for the current session, and `/mu mode default shadow` switches all of them. To make a mode stick, put it in `mu.json`; the app's settings turn points on or off.
- `MU_JUDGE_MODE=shadow mu` sets the default mode for one run.

Every decision point, with what it decides: [reference/decision-points.md](reference/decision-points.md).

## Environment variables

Judges and modes:

| Variable | Effect |
| --- | --- |
| `MU_JUDGE` | Judges for this run, comma-separated: `jev`, `mude,jev`, `jev-opencode-free`, `classifier:<provider>/<model>`, `llm:<provider>/<model>`. `off` turns the kernel off. |
| `MU_JUDGE_MODE` | Default mode for this run: `off`, `shadow` or `active`. |
| `MU_WRITER` | `provider/model-id` for the writer model. |
| `MU_PERMISSIONS` | Permission mode for this run: `full`, `judge` or `ask`. |

Keys for the hosted judges, each sent only to the service it belongs to (see [Judges](judges.md#hosted-jev)): `TYPESAFE_API_KEY`, `MU_JUDGE_OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`, `OPENCODE_API_KEY`, `CLOUDFLARE_API_KEY` with `CLOUDFLARE_ACCOUNT_ID`, and `MU_JUDGE_CLM_API_KEY`.

Time:

| Variable | Effect |
| --- | --- |
| `MU_TIME_BUDGET_S` | The run's time budget in seconds, counted from when mu starts. With it, a reply that's only thinking is cut off early enough to leave time for a retry, and the model is told how many minutes are left at 50% and 80% of the budget ([`features.deadline`](reference/features.md#deadline)). Benchmark harnesses set it from the task's timeout. Without it, nothing changes. |

The launcher:

| Variable | Effect |
| --- | --- |
| `MU_AGENT_DIR` | The agent folder, in place of `~/.mu/agent`. |
| `MU_NO_SETUP=1` | Never offer to set up a model on first launch. |
| `MU_LANG` | A language tag (`zh-CN`, `en`, `ja`…) for mu's own messages in a session: Chinese for `zh`, English for anything else. If it's unset, sessions use English, and `mu setup` follows your locale. The desktop app sets it to the app's language. |
| `MU_LINK_DIR` | Where `mu link` puts the `mu` command, in place of `~/.local/bin`. |
| `MU_CHROME` | The Chrome or Chromium binary the built-in browser uses on the command line. |

Every `MU_` variable is also read under its old `KYRN_` name.

mu also reads a `.env` file: `~/.mu/.env` for the npm package, or the repository's `.env` in a checkout. Lines are `KEY=VALUE`, and nothing in the file is executed. `mu setup` writes the Jev key there. Variables already set in your environment take precedence.

## Proxies

mu follows `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`. When `HTTPS_PROXY` isn't set, the desktop app also uses the system proxy settings (macOS network settings, Windows Internet settings). pi's `httpProxy` setting works as well.

## Per-feature options

Each feature's options, defaults and ranges are listed in a reference generated from the same manifest the app's settings use: [reference/features.md](reference/features.md). Some that people often change:

| Setting | What it does |
| --- | --- |
| `features.admission.testLog` | `"rules"` folds exact repeats in test logs; `"jev"` adds goal-aware selection. Off by default. |
| `features.board.defaultOn` | Start every session with the plain-language board on. |
| `features.permissions.mode` | The permission mode for a new conversation, before you pick one. |
| `features.injection.tools` | Which tools' results are screened for prompt injection. |
| `features.continuation.maxNudges` | How many times per message a run that stopped short is sent back to work. |
| `features.swarm.models` | Model tiers that subagents can be routed to, cheapest first. |
