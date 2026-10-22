# mu on Nebius Token Factory with NVIDIA Nemotron

mu can run end to end on [Nebius Token Factory](https://tokenfactory.nebius.com) with NVIDIA's open Nemotron models. Each model does the job it fits:

| Role in mu | Model on Token Factory | Why |
| --- | --- | --- |
| The coding model: reads, edits, runs commands | Nemotron 3 Super (`nvidia/nemotron-3-super-120b-a12b`) | Calls tools reliably, $0.30 / $0.90 per million tokens; its thinking follows mu's thinking level |
| The judge at the 40 decision points | Nemotron 3 Ultra (`nvidia/Nemotron-3-Ultra-550b-a55b`), thinking off | The only Nemotron on Token Factory that clearly beat having no judge (below); 0.9 s at the median |
| The judge on your machine | Nemotron 3 Nano 4B, distilled from Ultra ([mu-judge-nemotron](https://github.com/qybaihe/mu-judge-nemotron)) | Free and local; sends Ultra only the questions it is unsure of |
| Where commands run, if you want them off your machine | Token Factory Sandboxes | Each command continues from the files the previous one left; changes come back only after you review the diff |

## Set up

Create an API key in Token Factory and put it in your environment (or in `~/.mu/.env`):

```bash
export NEBIUS_API_KEY=...
```

Run mu with Nemotron 3 Super as the coding model and Nemotron 3 Ultra as the judge:

```bash
MU_JUDGE=nemotron mu --provider nebius --model nvidia/nemotron-3-super-120b-a12b
```

To keep these settings, put the judge in `~/.mu/agent/mu.json` and pick the model with `/model` once:

```json
{ "tiers": ["nemotron"] }
```

In Judge mode (the default permission mode) Nemotron 3 Ultra approves what the task clearly needs and asks you about the rest. Every verdict goes to the ledger with its latency: `mu ledger`, `/status`, or the Judge tab in the desktop app. A typical run, fixing a failing test in a small Python project:

```
input.preflight: multi_step_task -> heavy  files=yes side=no clarify=no
tool.approval: "approve"        python3 test_slugify.py
turn.drift: "on_track"
tool.approval: "approve"        python3 test_slugify.py
skill.capture: "skip"
turn.continue: "end"
```

Super fixed the bug and ran the tests twice; Ultra made 8 decisions on the way. The whole run cost $0.04.

### Thinking where it pays

Nemotron 3 Ultra decides much better with thinking on for a few decision points, at about three times the tokens and 2.5 s instead of 0.9 s at the median. `nemotron-think` is Ultra with `reasoning_effort: "high"`; give it those decision points and keep the fast judge for the rest:

```json
{
  "tiers": ["nemotron"],
  "routes": {
    "memory.capture": ["nemotron-think"],
    "tool.constraint": ["nemotron-think"],
    "board.read": ["nemotron-think"],
    "skills.disclosure": ["nemotron-think"],
    "capability.disclosure": ["nemotron-think"]
  }
}
```

## The judge on your machine

[mu-judge-nemotron](https://github.com/qybaihe/mu-judge-nemotron) distills Nemotron 3 Ultra's answers into Nemotron 3 Nano 4B and serves it over System One, the protocol mu's judges speak. Start it, then use the built-in `nemotron-local` judge, with Ultra behind it for the questions it is unsure of:

```json
{ "tiers": ["nemotron-local", "nemotron"] }
```

A yes/no answer between 0.2 and 0.8, or a choice below 0.6, goes on to Ultra; everything else is settled locally.

## Run commands in a Token Factory sandbox

With the sandbox on, `bash`, `read`, `write` and `edit` run in a Token Factory sandbox instead of on your machine. The project is copied in when the session starts, and every command continues from the files the previous one left. Nothing changes on your machine until you run `/sandbox pull`, see the diff and agree.

```bash
export NEBIUS_PROJECT_ID=...   # Token Factory → Project settings
MU_SANDBOX=nebius mu --provider nebius --model nvidia/nemotron-3-super-120b-a12b
```

`/sandbox status` shows the sandbox and the image it has reached; the options (base image, time limits) are under `features.sandbox` in [the feature reference](reference/features.md#sandbox).

## Web search with Tavily

With `TAVILY_API_KEY` set, `web_search` asks [Tavily](https://tavily.com) first and `web_fetch` falls back to Tavily's extract for pages it cannot read itself. See [Configuration](configuration.md).

## Measured

Every Nemotron model on Token Factory was put in the judge's seat on 1,367 held-out judge requests from mu's own sessions (decision points across permissions, context, memory, turn control and multi-agent work), scored by what mu then did, relative to having no judge (0 = no better than mu's fallbacks, 100 = every decision right):

| Judge (thinking off) | Real requests | Constructed cases | Answer format errors |
| --- | --- | --- | --- |
| Nemotron 3 Ultra | **47.5** | **48.9** | 0.2% |
| Nemotron 3 Super | 1.1 | −11.4 | 4% |
| Nemotron 3.5 Lightning, read off first-token logprobs | 14.9 | −11.3 | none (one token) |
| Nemotron 3.5 Lightning, JSON | — | — | 55% of 40 tried |

On 4,887 further held-out requests, run once, Nemotron 3 Ultra scored 54.4 on real requests (95% interval 44.7–63.3) and 49.3 on constructed ones, with the highest accuracy of every judge measured (92.9%) but costlier mistakes than judges trained for mu. With thinking on (`reasoning_effort: "high"`), its score on the decision points where it was weakest rose from 15.3 to 23.0 on real requests and from 55.9 to 88.3 on constructed ones, at about three times the cost per request.
