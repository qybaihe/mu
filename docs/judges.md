# Judges

A judge answers the bounded questions asked at mu's decision points: yes or no, one of a few named answers, or a score, each with a probability. Decision points never know which judge answered. You choose the judge, for the whole installation or per point, and you can compare judges on your own sessions before you switch.

## Which judge answers

`tiers` in `~/.mu/agent/mu.json` (or `MU_JUDGE` for one run) lists the judges in order. Each later judge only sees the questions the earlier ones left uncertain, so a fast local judge can go first and a hosted one can catch the rest:

```json
{ "tiers": ["mude", "jev"] }
```

`routes` gives a decision point its own judges:

```json
{ "routes": { "browser.step": ["jev"], "memory.capture": ["llm:anthropic/claude-haiku-4-5"] } }
```

In a session, use `/mu judge <tiers>` and `/mu route <point> <tiers|default>`. `/status` shows which judge answers what, and Settings → Judges in the desktop app sets the same things.

If no judge answers in time, the decision point falls back to what it does without a verdict (usually, nothing changes), and the ledger records why.

## mude 1.0, on your Mac

mude 1.0 is mu's own decision model, optimized for coding. It has 2B parameters and answers every question in a decision in one forward pass. On a Mac with Apple silicon (macOS 14 or later, 8 GB of memory or more), it's the recommended judge: `mu setup` offers it first, and the desktop app's first-run guide has it preselected.

```bash
mu judge mude install               # download it (1.8 GB), check every file, start it and make it the judge
mu judge mude enable --local-only   # mude only: nothing goes to a hosted judge
mu judge mude status
```

By default, the judges you had before stay in `tiers` after it as fallbacks. They answer what mude can't (its server is stopped, or it's unsure) and handle the two injection checks mude isn't trusted with yet. With `--local-only`, mude is the only judge, and when it can't answer, the decision point uses its default. mude answers in about 0.1 s, and what it reads never leaves your Mac. Its server uses about 4 GB of memory while it runs, and mu starts it before a session when your configuration names it. If an install stops (Ctrl-C, a lost connection, a power cut), running it again picks up where it left off. On other platforms, serve the [full model](https://huggingface.co/qybaihe/mude-1.0) with its own System One server and add it as a `typesafe` judge, as its model card shows.

### Other decision models

`mu judge model` adds other decision models from Hugging Face the same way: paste a link or `owner/name`. mu pins the commit and every file's hash, downloads the model with resume and progress, runs it in mude's Python environment and makes it the judge. It must be packaged like mude 1.0's MLX edition, with its own `d3_server_mac.py`, which runs on your Mac: add only models you trust.

```bash
mu judge model add https://huggingface.co/owner/name   # or owner/name@revision; run it again to resume
mu judge model list                                    # mude 1.0 and the models you added; which one is the judge
mu judge model use mude                                # switch the judge back to mude 1.0 (or to another model)
mu judge model remove name
```

One decision model runs at a time: switching stops the other one's server. In the desktop app, Settings → Judges has the same, next to mude 1.0.

### Laya

Earlier versions of mu included Laya, a third-party local judge. mu no longer does. A `mu.json` that still names `laya` (in `tiers` or a route), or a judge of type `local`, is read without it: mude 1.0 takes its place when it's set up on this Mac, and otherwise the judges that remain answer, or Jev when none remain. mu fixes `mu.json` once, at the start of the next session in the terminal or the app, keeps a copy of the old file in `~/.mu/backups`, and tells you. `MU_JUDGE` naming `laya` is skipped. For another decision model, use mude 1.0 or add one from Hugging Face as above.

## Hosted Jev

Jev is a judgment model from TypeSafe, built for this kind of question. The built-in `jev` judge reaches it through the first service whose key is set:

| Order | Service | Key | Built-in name |
| --- | --- | --- | --- |
| 1 | TypeSafe | `TYPESAFE_API_KEY` | `jev-direct` |
| 2 | OpenRouter (a key used only for Jev) | `MU_JUDGE_OPENROUTER_API_KEY` | `jev-openrouter` |
| 3 | Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `jev-gateway` |
| 4 | OpenCode Zen | `OPENCODE_API_KEY` | `jev-opencode` |
| 5 | Cloudflare Workers AI | `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` | `jev-cloudflare` |
| none set | OpenCode Zen, free for a limited time | no key | `jev-opencode-free` |

After these, mu falls back to a Vercel AI Gateway key that pi saved at `/login`. A key is only ever sent to the service it belongs to. To skip the order, name one directly by its built-in name (`"tiers": ["jev-openrouter"]`).

**The free Jev.** With no key at all, Jev 1.13 on OpenCode Zen answers. What it judges goes to OpenCode, which doesn't train on it, and mu reminds you of this once a day. It's a limited-time offer from OpenCode: when it ends, mu tells you, and the decision points fall back until you set a key. `mu setup --judge free` chooses it explicitly.

Measured in the authors' own sessions: a warm question takes about 0.3 s, and 16 chunks of tool output are judged in a single request in 0.44 s, with the shared state billed once.

## OpenAI's decision model

The built-in `openai` judge asks `gpt-6-luna` through OpenAI's [Decisions API](https://developers.openai.com/api/docs/guides/decisions) (`POST /v1/decisions`), with an OpenAI API key. Its key is `MU_JUDGE_OPENAI_KEY`. Without it, the judge uses the OpenAI API key mu already has for its `openai` provider (from `mu setup`, `/login` or `OPENAI_API_KEY`); Sign in with ChatGPT doesn't count. `mu setup --judge openai` or Settings → Judges in the desktop app sets it up, or put it in `mu.json`:

```json
{ "tiers": ["openai"] }
```

OpenAI charges $0.10 per million uncached input tokens, and nothing for output. Not yet measured on mu's questions.

To reach it through a relay or proxy that serves the same Decisions endpoint, give it a `baseUrl` and a key of its own. The key of mu's `openai` provider only ever goes to `api.openai.com`:

```json
{ "judges": { "relay": { "type": "openai", "baseUrl": "https://relay.example.com/v1", "apiKeyEnv": "MU_JUDGE_RELAY_KEY" } } }
```

## Classifier models and LLMs

- `classifier:<provider>/<model>`: any classifier in pi's model catalog, reached with the sign-in or key you already have for that provider. Examples: Cloudflare's Clef (built in as `clef` and `clef-flash`), the System One models on OpenRouter and the Vercel AI Gateway, or a llama.cpp classifier.
- `llm:<provider>/<model>`: any chat model, prompted to answer in JSON. It's slower, and every decision costs tokens, but it needs nothing beyond the model you already use. `mu setup --judge model` makes the session's model the judge.
- `clm`: [CLM-8B](https://github.com/Contrastive-LM/CLM) behind a `clm-serve` (`http://127.0.0.1:8700` by default; set `MU_JUDGE_CLM_API_KEY` if the server requires a key). Not yet measured on mu's questions.

## Your own judge

Add it under `judges` in `mu.json`, with a name and a type:

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
| `typesafe` | Any service at `baseUrl` that speaks TypeSafe's System One protocol (`POST { model, state, questions }`) |
| `http` | Any endpoint that takes `{ state, questions }` and returns `{ answers }` |
| `llm` | A chat model from pi's registry |
| `classifier` | A classifier from pi's catalog |
| `clm` | A `clm-serve` |
| `openai` | OpenAI's Decisions API, at `baseUrl` (OpenAI's own by default) |

The key itself never goes in the file: `apiKeyEnv` names the environment variable that holds it (set it in your environment or in mu's `.env`).

## Comparing judges

1. Put the decision point in `shadow` and route it to the judge you want to try, or run the whole kernel in shadow mode.
2. Work as usual for a while.
3. Read the verdicts: `mu ledger [n]` prints the verdicts from the last n sessions, `mu ledger --json` gives every record with its probabilities and timings, and the desktop app's Judge tab shows each verdict with its question.
4. Switch the point to `active` once its verdicts look right.

`"recordState": true` also keeps the judged state in the ledger, which you need to train your own judge on your sessions. It's off by default because the states contain your content.
