---
title: Judges
summary: Who answers the decision points, how to choose, chain and compare judges, and what each one costs.
---

## Which judge answers {#tiers}

`tiers` in `~/.mu/agent/mu.json` lists the judges in order. Each later judge only sees the questions the earlier ones left uncertain, so a cheap local judge can go first and a hosted one catch the rest:

```json
{ "tiers": ["mude", "jev"] }
```

`routes` gives one decision point its own judges:

```json
{ "routes": { "browser.step": ["jev"], "memory.capture": ["llm:anthropic/claude-haiku-4-5"] } }
```

In a session, `/mu judge <judges>` and `/mu route <point> <judges|default>` do the same; `MU_JUDGE=mude,jev mu` sets the judges for one run. `/status` shows which judge answers what, and the app's judges page sets the same things.

When no judge answers in time, each decision point does what it would do without a verdict (usually: nothing changes), and the ledger records why.

## mude 1.0, on your Mac {#mude}

mude 1.0 is mu's own decision model, optimized for coding. It has 2B parameters and answers every question in a decision in one forward pass. On a Mac with Apple silicon (macOS 14 or later, 8 GB of memory or more), it is the recommended judge: `mu setup` offers it first, and the desktop app's first-run guide has it preselected.

```bash
mu judge mude install               # download it (1.8 GB), check every file, start it and make it the judge
mu judge mude enable --local-only   # mude only: nothing goes to a hosted judge
mu judge mude status
```

By default, the judges you had before stay in `tiers` after it as fallbacks: they answer what mude can't (its server is stopped, or it's unsure) and handle the two injection checks mude isn't trusted with yet. With `--local-only`, mude is the only judge, and when it can't answer, the decision point uses its default. mude answers in about 0.1 s, and what it reads never leaves your Mac. Its server uses about 4 GB of memory while it runs, and mu starts it before a session when your configuration names it. If an install stops (Ctrl-C, a lost connection, a power cut), running it again picks up where it left off. On other platforms, serve the [full model](https://huggingface.co/qybaihe/mude-1.0) with its own System One server and add it as a `typesafe` judge, as its model card shows.

### Other decision models {#models}

`mu judge model` adds other decision models from Hugging Face the same way: paste a link or `owner/name`. mu pins the commit and every file's hash, downloads the model with resume and progress, runs it in mude's Python environment and makes it the judge. The model must be packaged like mude 1.0's MLX edition, with its own `d3_server_mac.py`, which runs on your Mac: add only models you trust.

```bash
mu judge model add https://huggingface.co/owner/name   # or owner/name@revision; run it again to resume
mu judge model list                                    # mude 1.0 and the models you added
mu judge model use mude                                # switch back to mude 1.0, or to another model
mu judge model remove name
```

One decision model runs at a time: switching stops the other one's server. In the desktop app, you can do the same under Settings → Judges, below mude 1.0.

## Jev, hosted {#jev}

Jev is a judgment model by TypeSafe, made for this kind of question. The built-in `jev` judge reaches it through the first service whose key is set:

| Order | Service | Key | Built-in name |
| --- | --- | --- | --- |
| 1 | TypeSafe | `TYPESAFE_API_KEY` | `jev-direct` |
| 2 | OpenRouter (a key for Jev only) | `MU_JUDGE_OPENROUTER_API_KEY` | `jev-openrouter` |
| 3 | Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `jev-gateway` |
| 4 | OpenCode Zen | `OPENCODE_API_KEY` | `jev-opencode` |
| 5 | Cloudflare Workers AI | `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` | `jev-cloudflare` |
| none set | OpenCode Zen, free for a limited time | no key | `jev-opencode-free` |

A key is only ever sent to the service it belongs to. Name a route directly, such as `"tiers": ["jev-openrouter"]`, to skip the order. `mu setup` or the app's judges page writes the key for you.

**The free Jev.** With no key at all, Jev 1.13 on OpenCode Zen answers. What it judges goes to OpenCode, which doesn't train on it; mu says so once a day. It is OpenCode's limited-time offer: when it ends, mu says so and the decision points fall back until you set a key. `mu setup --judge free` chooses it explicitly.

**Speed and cost.** Measured in the authors' own sessions: one question on a warm connection in about 0.3 s; 16 chunks of tool output judged in one request in 0.44 s, the state billed once. While a session is in use, one tiny question every 50 seconds keeps the connection warm, so the questions before a turn skip 1 to 3 seconds of connecting.

## OpenAI's decision model {#openai}

The built-in `openai` judge asks `gpt-6-luna` through OpenAI's [Decisions API](https://developers.openai.com/api/docs/guides/decisions) (`POST /v1/decisions`), with an OpenAI API key. Its key is `MU_JUDGE_OPENAI_KEY`. Without it, the judge uses the OpenAI API key mu already has for its `openai` provider (from `mu setup`, `/login` or `OPENAI_API_KEY`); Sign in with ChatGPT doesn't count. `mu setup --judge openai` or the app's judges page sets it up, or put it in `mu.json`:

```json
{ "tiers": ["openai"] }
```

OpenAI charges $0.10 per million uncached input tokens, and nothing for output. Not measured on mu's questions yet.

To reach it through a relay or proxy that serves the same Decisions endpoint, give it a `baseUrl` and a key of its own. The key of mu's `openai` provider only ever goes to `api.openai.com`:

```json
{ "judges": { "relay": { "type": "openai", "baseUrl": "https://relay.example.com/v1", "apiKeyEnv": "MU_JUDGE_RELAY_KEY" } } }
```

## If your configuration still names Laya {#laya}

Laya, the third-party local judge mu shipped until 0.2.4, is no longer built in. A `mu.json` that still names it, in `tiers`, in a route or as a judge of type `local`, keeps working: mude 1.0 takes its place when it's set up on your Mac; otherwise the judges left in the list answer, or Jev when none are left. mu updates `mu.json` once, changing only those entries and keeping a copy of the old file in `~/.mu/backups`, and tells you which judge took over. If `MU_JUDGE` names `laya`, mu skips it. For another decision model on your machine, [add one from Hugging Face](@docs/judges#models).

## Classifier models and LLMs {#other-judges}

- **`classifier:<provider>/<model>`**: any classifier in pi's model catalog, reached with the sign-in or key you already have for that provider. Cloudflare's Clef is built in as `clef` and `clef-flash`; the System One models on OpenRouter and the Vercel AI Gateway, and llama.cpp classifiers, work too.
- **`llm:<provider>/<model>`**: any chat model, asked to answer as JSON. Slower, and every decision costs tokens, but it needs nothing beyond the model you already use. `mu setup --judge model` makes the session's model the judge.
- **`clm`**: CLM-8B behind a `clm-serve` (`http://127.0.0.1:8700` by default). Not measured on mu's questions yet.

## Your own judge {#custom}

Under `judges` in `mu.json`, give a name and a type:

```json
{
  "judges": {
    "relay": { "type": "typesafe", "baseUrl": "https://relay.example.com/v1/systemone", "apiKeyEnv": "RELAY_KEY" },
    "lab": { "type": "http", "baseUrl": "http://10.0.0.5:9000", "path": "/evaluate", "apiKeyEnv": "LAB_KEY" },
    "fast": { "type": "llm", "model": "anthropic/claude-haiku-4-5", "thinking": "off", "timeoutMs": 4000 }
  },
  "tiers": ["relay", "jev"]
}
```

| Type | What it talks to |
| --- | --- |
| `typesafe` | Any service that speaks TypeSafe's System One protocol at `baseUrl` |
| `http` | Any endpoint that takes `{ state, questions }` and returns `{ answers }` |
| `llm` | A chat model from pi's registry |
| `classifier` | A classifier from pi's catalog |
| `clm` | A `clm-serve` |
| `openai` | OpenAI's Decisions API at `baseUrl`, OpenAI's own by default |

The key never goes in the file: `apiKeyEnv` names the environment variable that holds it, set in your environment or in mu's `.env`.

## Modes: active, shadow, off {#modes}

Every decision point has a mode:

- **active** (the default): the verdict takes effect.
- **shadow**: the judge is asked and the verdict is logged, but nothing changes.
- **off**: the point isn't asked.

Set them in `mu.json` under `modes` (a `default` plus one entry per point), for one session with `/mu mode` or in the app's settings, where a point in shadow shows as off. Two things work whatever the mode: the permission mode you choose (*Judge mode* is itself the opt-in for `tool.approval`), and the `judge_items` tool when the model calls it.

## Comparing judges {#compare}

1. Put the decision point in shadow and route it to the judge you want to try, or run every point in shadow.
2. Work as usual for a while.
3. Read the verdicts: `mu ledger [n]` prints the last n sessions, `mu ledger --json` gives every record with its probabilities and timings, and the app's Judge tab shows each verdict with its question.
4. Switch the point back to active when its verdicts look right.

`"recordState": true` also keeps the judged state in the ledger, which you need to train a judge of your own. It is off by default because the states hold your content.
