# Judges

A judge answers the bounded questions of mu's decision points: yes or no, one of a few named answers, or a score, each with a probability. The decision points never know which judge answered; you choose, per installation or per point, and can compare judges on your own sessions before switching.

## Which judge answers

`tiers` in `~/.mu/agent/mu.json` (or `MU_JUDGE` for one run) lists the judges in order. Each later judge only sees the questions the earlier ones left uncertain, so a cheap local judge can go first and a hosted one catch the rest:

```json
{ "tiers": ["laya", "jev"] }
```

`routes` gives a decision point its own judges:

```json
{ "routes": { "browser.step": ["jev"], "memory.capture": ["llm:anthropic/claude-haiku-4-5"] } }
```

In a session: `/mu judge <tiers>` and `/mu route <point> <tiers|default>`. `/status` shows which judge answers what; the desktop app's judges page sets the same things.

When no judge answers in time, each decision point falls back to what it does without a verdict (usually: nothing changes), and the ledger records why.

## Hosted Jev

Jev is a judgment model by TypeSafe, built for this kind of question. The built-in `jev` judge reaches it through the first service whose key is set:

| Order | Service | Key | Built-in name |
| --- | --- | --- | --- |
| 1 | TypeSafe | `TYPESAFE_API_KEY` | `jev-direct` |
| 2 | OpenRouter (a key for Jev only) | `MU_JUDGE_OPENROUTER_API_KEY` | `jev-openrouter` |
| 3 | Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `jev-gateway` |
| 4 | OpenCode Zen | `OPENCODE_API_KEY` | `jev-opencode` |
| 5 | Cloudflare Workers AI | `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` | `jev-cloudflare` |
| none set | OpenCode Zen, free for a limited time | no key | `jev-opencode-free` |

After these, a Vercel AI Gateway key that pi keeps from `/login` is used. A key is only ever sent to the service it belongs to. Name a route directly (`"tiers": ["jev-openrouter"]`) to skip the order.

**The free Jev.** With no key at all, Jev 1.13 on OpenCode Zen answers. What it judges goes to OpenCode, which does not train on it; mu says so once a day. It is OpenCode's limited-time offer: when it ends, mu says so and the decision points fall back until you set a key. `mu setup --judge free` chooses it explicitly.

Measured from the authors' own sessions: one warm question in about 0.3 s; 16 chunks of tool output judged in one request in 0.44 s, the state billed once.

## Laya, the local judge

A 322M-parameter judge that runs on your machine and never touches the network.

```bash
mu judge setup     # asks before downloading the model
mu judge start     # starts the sidecar
mu judge status
```

The desktop app sets it up in one step, also after asking. Laya is reliable on simple predicates (does this text describe an error?) and weak on questions about relations or the request itself; mu knows this and never sends it a question it cannot answer well, so in a cascade such as `["laya", "jev"]` those go straight to the next judge. Run it in shadow next to Jev and read the ledger before giving it a decision point on its own. The measurements are in [kyrn/docs/03-local-judge.md](../kyrn/docs/03-local-judge.md) (in Chinese).

## Classifier models and LLMs

- `classifier:<provider>/<model>`: any classifier in pi's model catalog, reached with your existing sign-in or key for that provider: Cloudflare's Clef (built in as `clef` and `clef-flash`), the System One models on OpenRouter and the Vercel AI Gateway, a llama.cpp classifier.
- `llm:<provider>/<model>`: any chat model, prompted to answer as JSON. Slower, and every decision costs tokens, but it needs nothing beyond the model you already use. `mu setup --judge model` makes the session's model the judge.
- `clm`: [CLM-8B](https://github.com/Contrastive-LM/CLM) behind a `clm-serve` (`http://127.0.0.1:8700` by default, `MU_JUDGE_CLM_API_KEY` when the server asks for a key). Not measured on mu's questions yet.

## Your own judge

Under `judges` in `mu.json`, a name and a type:

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
| `typesafe` | Any service that speaks TypeSafe's System One protocol (`POST { model, state, questions }`) at `baseUrl` |
| `http` | Any endpoint that takes `{ state, questions }` and returns `{ answers }` |
| `llm` | A chat model from pi's registry |
| `classifier` | A classifier from pi's catalog |
| `local` | A Laya-compatible sidecar |
| `clm` | A `clm-serve` |

The key itself never goes in the file: `apiKeyEnv` names the environment variable that holds it (set it in your environment or in mu's `.env`).

## Comparing judges

1. Put the decision point in `shadow` and route it to the judge you want to try, or run the whole kernel in shadow.
2. Work as usual for a while.
3. Read the verdicts: `mu ledger [n]` prints the last n sessions, `mu ledger --json` gives every record with its probabilities and timings, and the desktop app's judgments tab shows each verdict with its question.
4. Switch the point to `active` when its verdicts look right.

`"recordState": true` also keeps the judged state in the ledger, which you need to train or distil a judge of your own on your sessions. It is off by default because the states hold your content.
