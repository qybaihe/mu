# Configuration

mu reads pi's settings (models, sign-ins, preferences: see [pi's documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#readme)) and its own, in `~/.mu/agent/mu.json`. The desktop app's settings write the same file; every change made there can be made by hand, and the other way round.

Only your own `mu.json` is read. A project cannot change the judge, its endpoint or its modes: the judge reads your messages.

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
    "memory.capture": ["laya", "jev"]
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
| `tiers` | The judges that answer, in order. A later judge only sees what the earlier ones left uncertain: `["laya", "jev"]` asks the local judge first. | `["jev"]` |
| `modes` | `default` plus one entry per decision point: `active` (verdicts take effect), `shadow` (asked and logged, nothing changes) or `off` (not asked). | `{ "default": "shadow" }` |
| `routes` | A decision point on its own judges, in place of `tiers`. | none |
| `judges` | Named judges of your own, added to the built-in ones. See [Judges](judges.md#your-own-judge). | none |
| `features` | Per-feature switches and options: `false` turns a feature off, an object overrides options. Every feature and option: [reference/features.md](reference/features.md). | each feature's defaults |
| `writer` | `provider/model-id` of a small generative model for what a judge cannot do: writing the task frame and lessons. Empty uses the session's model. | none |
| `recordState` | Keep the judged state in the ledger, not only the verdict. Needed to train a local judge on your sessions; off because states hold your content. | `false` |
| `mcp` | mu's own MCP servers: `{ "servers": { "<name>": { "command": … } } }`. Servers from Claude Code, Cursor and Codex settings are found too (`features.inherit`). | none |

A part mu does not understand falls back to its default instead of stopping mu. A file that cannot be parsed at all is reported when a session starts, and the defaults are used; an older `kyrn.json` is read only when there is no `mu.json`.

## Modes in practice

- Start in shadow, read the ledger (`mu ledger`, `/status`, or the judgments tab), then switch a point to active when its verdicts look right.
- `/mu mode <point> <off|shadow|active>` switches one point for the current session; `/mu mode default active` all of them. To keep a mode, put it in `mu.json` or set it in the app.
- `MU_JUDGE_MODE=active mu` sets the default for one run.

Every decision point, with what it decides: [reference/decision-points.md](reference/decision-points.md).

## Environment variables

Judges and modes:

| Variable | Effect |
| --- | --- |
| `MU_JUDGE` | Judges for this run, comma-separated: `laya`, `laya,jev`, `jev-opencode-free`, `classifier:<provider>/<model>`, `llm:<provider>/<model>`. `off` turns the kernel off. |
| `MU_JUDGE_MODE` | Default mode for this run: `off`, `shadow` or `active`. |
| `MU_WRITER` | `provider/model-id` for the writer model. |
| `MU_PERMISSIONS` | Permission mode for this run: `full`, `jev` or `ask`. |
| `MU_LOCAL_JUDGE_URL` | Address of a local judge server other than the one `mu judge start` runs. |

Keys for Jev, each used only by the service it belongs to ([Judges](judges.md#hosted-jev)): `TYPESAFE_API_KEY`, `MU_JUDGE_OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`, `OPENCODE_API_KEY`, `CLOUDFLARE_API_KEY` with `CLOUDFLARE_ACCOUNT_ID`, `MU_JUDGE_CLM_API_KEY`.

The launcher:

| Variable | Effect |
| --- | --- |
| `MU_AGENT_DIR` | The agent folder, in place of `~/.mu/agent`. |
| `MU_NO_SETUP=1` | Never ask to set up a model at the first start. |
| `MU_LANG` | A language tag (`zh-CN`, `en`, `ja`…) for mu's own messages in a session: Chinese for `zh`, English otherwise. Unset, sessions speak English; `mu setup` follows your locale. The desktop app sets it to the app's language. |
| `MU_LINK_DIR` | Where `mu link` puts the `mu` command, in place of `~/.local/bin`. |
| `MU_CHROME` | The Chrome or Chromium the built-in browser uses on the command line. |

Each `MU_` variable is also read under its old `KYRN_` spelling.

mu reads a `.env` file too: `~/.mu/.env` for the npm package, the repository's `.env` for a checkout. Lines are `KEY=VALUE`; nothing in the file is executed. `mu setup` writes the Jev key there. Variables already set in your environment win.

## Proxies

mu follows `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`. The desktop app also follows the system proxy (macOS network settings, Windows Internet settings) when no `HTTPS_PROXY` is set. pi's `httpProxy` setting works as well.

## Per-feature options

Each feature's options, defaults and ranges are generated from the same manifest the app's settings use: [reference/features.md](reference/features.md). Some that are often changed:

| Setting | What it does |
| --- | --- |
| `features.admission.testLog` | `"rules"` folds exact repeats in test logs, `"jev"` adds goal-aware selection. Off by default. |
| `features.board.defaultOn` | Start every session with the plain-language board on. |
| `features.permissions.mode` | The permission mode of a new conversation before you pick one. |
| `features.injection.tools` | Which tools' results are screened for prompt injection. |
| `features.continuation.maxNudges` | How often a run that stopped short is sent back, per message. |
| `features.swarm.models` | Model tiers sub-agents may be routed to, cheapest first. |
