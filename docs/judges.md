# Judges

A judge answers the bounded questions asked at mu's decision points: yes or no, one of a few named answers, or a score, each with a probability. Decision points never know which judge answered. You choose the judge, for the whole installation or per point, and you can compare judges on your own sessions before you switch.

## Which judge answers

To choose the judge without editing a file, run `mu judge` in a terminal. It shows the judge in use, asks the judge question of `mu setup` alone and leaves your model as it is. The judge you pick replaces the ones `mu.json` names, and takes effect in the next session you start.

The question lists the judges that are ready to use as things stand: mude 1.0 on a Mac that can run it, Jev with the key you have or the free Jev, and OpenAI's or Nebius's model when mu already has that key. The rest are under **More judges**, which names them: Jev with a key of your own, OpenAI's decision model when it still needs a key, and the model you just set up as its own judge.

`tiers` in `~/.mu/agent/mu.json` (or `MU_JUDGE` for one run) lists the judges in order. The first one answers. A later judge answers only what the ones before it couldn't: a judge that failed (stopped, too slow, no key), or a kind of question it isn't trusted with. So a fast local judge can go first, with a hosted one behind it for when it is down:

```json
{ "tiers": ["mude", "jev"] }
```

An answer stands as its judge gave it, sure or not. Where a judge is unsure, the decision point does what it does without a verdict; the question does not go on to the next judge. Up to mu 0.3.12 it did, and that was measured to do harm: a fine-tuned 4B judge alone scored 68.2 on real held-out requests, and 20.0 with Nemotron 3 Ultra answering what it was unsure of ([docs/nebius.md](nebius.md)). The questions a judge finds hard are the ones where doing nothing is safest, and a second judge's confident answer there cost more than it gained.

`routes` gives a decision point its own judges:

```json
{ "routes": { "browser.step": ["jev"], "memory.capture": ["llm:anthropic/claude-haiku-4-5"] } }
```

In a session, use `/mu judge <tiers>` and `/mu route <point> <tiers|default>`. `/status` shows which judge answers what, and Settings → Judges in the desktop app sets the same things.

If no judge answers in time, the decision point falls back to what it does without a verdict (usually, nothing changes), and the ledger records why.

If a judge's service turns its key down or can't charge the account behind it, mu tells you once per session and stops asking that service: after two refusals in a row, calls fail at once instead of waiting for the same refusal, and one call a minute tries again. Meanwhile the next judge in the order answers, or the decision point falls back. A judge that is slow or unreachable is still asked every time. At the start of a terminal session mu checks the judge of each route as well as the shared one, and `/doctor` lists them.

## mude 1.0, on your Mac

mude 1.0 is mu's own decision model, optimized for coding. It has 2B parameters and answers every question in a decision in one forward pass. On a Mac with Apple silicon (macOS 14 or later, 8 GB of memory or more), it's the recommended judge: `mu setup` offers it first, and the desktop app's first-run guide has it preselected.

```bash
mu judge mude install               # download it (1.8 GB), check every file, start it and make it the judge
mu judge mude enable --local-only   # mude only: nothing goes to a hosted judge
mu judge mude status
```

By default, the judges you had before stay in `tiers` after it as fallbacks. They answer when mude can't (its server is stopped or too slow) and handle the two injection checks mude isn't trusted with yet. What mude answers stays on your Mac, also where it is unsure: the decision point then does what it does without a verdict. With `--local-only`, mude is the only judge, and when it can't answer, the decision point uses its default. mude answers in about 0.1 s, and what it reads never leaves your Mac. Its server uses about 4 GB of memory while it runs, and mu starts it before a session when your configuration names it. The server answers one request at a time, so mu lines its requests up and sends the most urgent one next ([A judge that answers one request at a time](#a-judge-that-answers-one-request-at-a-time)). If an install stops (Ctrl-C, a lost connection, a power cut), running it again picks up where it left off. On other platforms, serve the [full model](https://huggingface.co/qybaihe/mude-1.0) with its own System One server and add it as a `typesafe` judge, as its model card shows. If that server answers one request at a time too, give the judge `"concurrency": 1`.

### Other decision models

`mu judge model` adds other decision models from Hugging Face the same way: paste a link or `owner/name`. mu pins the commit and every file's hash, downloads the model with resume and progress, runs it in mude's Python environment and makes it the judge. It must be packaged like mude 1.0's MLX edition, with its own `d3_server_mac.py`, which runs on your Mac: add only models you trust.

```bash
mu judge model add https://huggingface.co/owner/name   # or owner/name@revision; run it again to resume
mu judge model list                                    # mude 1.0 and the models you added; which one is the judge
mu judge model use mude                                # switch the judge back to mude 1.0 (or to another model)
mu judge model remove name
```

One decision model runs at a time: switching stops the other one's server. In the desktop app, you can do the same under Settings → Judges, next to mude 1.0.

### Laya

Earlier versions of mu included Laya, a third-party local judge. mu no longer does. A `mu.json` that still names `laya` (in `tiers` or a route), or a judge of type `local`, is read without it: mude 1.0 takes its place when it's set up on this Mac, and otherwise the judges that remain answer, or Jev when none remain. mu updates `mu.json` once, at the start of the next session in the terminal or the app, and keeps a copy of the old file in `~/.mu/backups`. It tells you which judge took over when you send your next message. If `MU_JUDGE` names `laya`, mu skips it. For another decision model, use mude 1.0 or add one from Hugging Face as above.

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

When a service in this order turns its key down or can't charge the account (a revoked key, a closed account, no payment method), the same call goes on to the next service whose key is set, and last to the free Jev. mu tells you which service refused and what it said. A service that is slow or unreachable is not skipped, because another service is another place your judged text would go. A judge you name directly (`jev-direct`, `jev-gateway`) never moves to another service.

**The free Jev.** With no key at all, or when every service whose key is set turned it down, Jev 1.13 on OpenCode Zen answers. What it judges goes to OpenCode, which doesn't train on it, and mu reminds you of this once a day. It's a limited-time offer from OpenCode: when it ends, mu tells you, and the decision points fall back until you set a key. `mu setup --judge free` chooses it explicitly.

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

## NVIDIA Nemotron on Nebius Token Factory

- `nemotron`: Nemotron 3 Ultra on [Nebius Token Factory](https://tokenfactory.nebius.com), asked like `llm:` with thinking off, so each request gets one JSON answer (0.9 s at the median). Set `NEBIUS_API_KEY`, or choose it in `mu setup` with a Token Factory key (`--judge nemotron`). On 1,353 held-out judge requests from mu's own sessions it was the only Nemotron on Token Factory that clearly beat having no judge; Super, Nano 30B and Lightning missed the answer format or decided worse.
- `nemotron-local`: Nemotron 3 Nano 4B, fine-tuned for mu's judge ([mu-judge-nemotron](https://github.com/qybaihe/mu-judge-nemotron)), served on your machine over System One at `http://127.0.0.1:8770`. It reads every answer off one token, so a decision costs nothing and stays on the machine.

- `nemotron-think`: Nemotron 3 Ultra with thinking on, for the decision points where it decides much better that way (see [docs/nebius.md](nebius.md)); 2.5 s at the median.

Put them in order, `"tiers": ["nemotron-local", "nemotron"]`, and Ultra answers when the local server isn't running.

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
| `systemone` | Any other System One server at `baseUrl`, such as `mu-judge-nemotron`'s; sends `apiKeyEnv` (default `MU_JUDGE_SYSTEMONE_API_KEY`) only when it is set |
| `logprob` | An OpenAI-compatible model at `baseUrl`, one question per request, the answer read off the first token's logprobs |
| `openai` | OpenAI's Decisions API, at `baseUrl` (OpenAI's own by default) |

The key itself never goes in the file: `apiKeyEnv` names the environment variable that holds it (set it in your environment or in mu's `.env`).

## A judge that answers one request at a time

A model served on your own machine usually answers one request at a time: mude's server runs the model under a lock. A message makes mu ask several things at once (what kind of turn it is, which skills apply, the task frame, the lessons to recall). Sent as they come, a small question the turn is waiting for stands behind a large one at the server, and its time runs out there. In the authors' sessions with mude, the task frame's 430-token request took 3.4 s at the median behind the 14,000-token skills request, and came after its 3 s wait 48 times in 57.

So a judge can say how many requests it answers at a time, and mu keeps the line itself:

```json
{ "judges": { "lab": { "type": "http", "baseUrl": "http://127.0.0.1:9000", "concurrency": 1 } } }
```

- At most `concurrency` requests are with the judge at a time. When it's free, the most urgent waiting request goes next: a question that holds the agent up, then a question that races other work, then a question nobody waits for (a point in shadow mode, a background check). Between two equally urgent requests, the smaller goes first, then the earlier.
- A question whose turn has gone on without it goes behind the questions still waited for.
- A request still in line after the judge's time limit (`timeoutMs`) is dropped without being sent, and the ledger records a `timeout`. For a request that is sent, the time limit counts from when it's sent.
- A request already with the judge finishes, even when a more urgent one arrives.
- Tiers and routes that name the same server share one line.

`mude` and the decision models that `mu judge model` adds are set to `1`. A model you added with mu 0.3.12 or earlier gets it when you run `mu judge model use <name>` again. Hosted judges have no `concurrency`, and their requests go out as they come. The ledger records how long a request stood in line (`queuedMs`) and whether its verdict came after mu had stopped waiting (`late`); `mu ledger --tally` adds both up by decision point.

Each mu process keeps its own line, so two sessions that share a local server can still have two requests there at once. How much the line cuts the late verdicts above is not measured yet.

## Reading a judge's probabilities

Two judges that say 0.9 don't mean the same thing. A model trained to give a probability may be right nine times in ten there. A chat model (`llm:`) writes its probability down, and says 0.9 or 0.95 for most things it leans to. A decision point acts on a yes from 0.8, whichever judge answered, so an over-confident judge acts too often.

When you have measured how a judge's probabilities turn out, give it the curves, and mu reads its answers through them before any decision point sees them:

```json
{
  "judges": {
    "fast": {
      "type": "llm",
      "model": "anthropic/claude-haiku-4-5",
      "profile": {
        "calibration": {
          "model": "llm:anthropic/claude-haiku-4-5",
          "curves": {
            "tool.approval": { "verdict": [[0.5, 0.2], [0.9, 0.6], [0.99, 0.85]] },
            "skills.disclosure": { "*": [[0.6, 0.2], [0.95, 0.7]] }
          }
        }
      }
    }
  }
}
```

- A curve is a list of `[said, was]` points for one question of one decision point: what the judge said, and the share of such answers that were true. For a yes/no question, `said` is the probability of yes. For a choice, it is the probability of the option the judge picked, and `was` is how often that pick was right. Between two points the reading follows the straight line; outside them it stays at the nearest point. In the example, a 0.9 on `tool.approval` is read as 0.6, which no longer approves a call by itself.
- `*` in place of a question stands for every question of that decision point with no curve of its own. Questions built per candidate (`skill_0`, `lesson_3`) can only be named this way.
- `model` is the model the curves were measured on, as the ledger's `modelId` names it. They are used on that model's answers only, so a hosted judge that moves to a new version is read as it speaks until that version is measured. Leave it out to use the curves whatever model answers.
- A curve mu can't read (fewer than two points, a number outside 0 to 1, `said` not rising, `was` falling) is left out, and `/status` and `/doctor` say which.
- The ledger keeps both numbers: `probability` is the reading the decision point acted on, and `said` is what the judge gave.

mu ships no curves: they have to be measured on questions whose right answers are known, and none are published yet. To make them from your own labelled answers, write one line per answer and run the script from a checkout of this repository:

```bash
node packages/kyrn-judge/scripts/fit-calibration.ts answers.jsonl --model llm:anthropic/claude-haiku-4-5
```

```json
{"decision": "tool.approval", "question": "verdict", "said": 0.93, "was": true}
```

It prints the `calibration` to paste into the judge's `profile`, with at least 20 answers behind each point, and says which questions had too few answers for a curve.

## Comparing judges

1. Put the decision point in `shadow` and route it to the judge you want to try, or run the whole kernel in shadow mode.
2. Work as usual for a while.
3. Read the verdicts: `mu ledger [n]` prints the verdicts from the last n sessions, `mu ledger --json` gives every record with its probabilities and timings, `mu ledger --timeline` puts each verdict between the reply and the tool result it came with, and the desktop app's Judge tab shows each verdict with its question. Where an active `turn.continue` or `turn.completion` verdict sent the agent back to work, `mu ledger` also says what it did next: `-> then: ended without a tool call` marks a nudge that achieved nothing.
4. Switch the point to `active` once its verdicts look right.

## What each decision point costs, and what comes of it

`mu ledger --tally [n]` adds up the last n sessions (20 by default) by decision point:

```
point              mode    asked  verdicts  differed  median  tokens
skills.disclosure  active     59         4       0/4    3.3s  826.0k
    no verdict 55: 50 timeout, 5 abstain
turn.continue      active     41        41      0/41   944ms  119.3k
tool.approval      active     40        37      6/37   310ms   12.0k
    then: sent to you 6 (5 allowed, 1 denied), 2 marked wrong
```

- **asked** is how often the point asked a judge, and **verdicts** how often an answer came that it could act on. The line under it says why the rest had none: `timeout`, `abstain` (an answer came, and it wasn't sure enough), `auth`.
- **differed** is how many verdicts were something else than what mu does with no judge. Only such a verdict can have changed anything, so a point at `0/41` spent 41 judge calls and changed nothing. In shadow mode it counts the verdicts that would have. Records written up to mu 0.3.12 don't say, and are left out of this column.
- **late**, on a line of its own when there is any, is how many verdicts came after mu had stopped waiting for them: the turn or the tool result went on without. **in line** is how often the request waited its turn at a [judge that answers a few at a time](#a-judge-that-answers-one-request-at-a-time), and for how long at the median; that wait is part of **median**.
- **then** is what happened next, where mu can see it: your answers to the calls a verdict sent to you, your `/ledger wrong` marks, nudges that ended without a tool call, left-out parts the model read back, hidden skills it read anyway.

It ends with the points worth a look, each with the rule that put it there: no verdict for half the asks or more (from 10 asks), 20 or more verdicts and none that differed, half the verdicts or more coming late (from 10 verdicts), or half the nudges or more ending without a tool call (from 5). The safety checks (`tool.risk`, `tool.injection`, `tool.description`) are exempt from the second rule: they are there for the rare call. `/mu mode <point> off` stops asking a point, and `shadow` keeps recording it without acting. mu changes no mode by itself.

`"recordState": true` also keeps each judge request in the ledger: the state and the questions as the judge received them, with known secrets redacted. You need it to train your own judge on your sessions ([mu-judge-nemotron](https://github.com/qybaihe/mu-judge-nemotron) turns them into training data). It's off by default because the states contain your content.
