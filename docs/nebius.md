# mu on Nebius Token Factory with NVIDIA Nemotron

mu can run end to end on [Nebius Token Factory](https://tokenfactory.nebius.com) with NVIDIA's open Nemotron models. Each model does the job it fits:

| Role in mu | Model on Token Factory | Why |
| --- | --- | --- |
| The coding model: reads, edits, runs commands | Nemotron 3 Super (`nvidia/nemotron-3-super-120b-a12b`) | Calls tools reliably, $0.30 / $0.90 per million tokens; its thinking follows mu's thinking level |
| The judge at the 40 decision points | Nemotron 3 Ultra (`nvidia/Nemotron-3-Ultra-550b-a55b`), thinking off | The only Nemotron on Token Factory that clearly beat having no judge (below); 0.9 s at the median |
| The judge on your machine | Nemotron 3 Nano 4B, fine-tuned for mu's judge ([mu-judge-nemotron](https://github.com/qybaihe/mu-judge-nemotron)) | Free and local, about 0.1 s to approve a command; on held-out test it scored above Ultra (below) |
| Where commands run, if you want them off your machine | Token Factory Sandboxes | Each command continues from the files the previous one left; changes come back only after you review the diff |

## Set up

Until a release of the npm package includes this, install the hackathon test build (Node.js 22.19 or newer), built and checked by CI:

```bash
npm i -g https://github.com/qybaihe/mu/releases/download/nebius-hackathon-1/mu-agent-0.1.12.tgz
```

Or run mu from source:

```bash
git clone https://github.com/qybaihe/mu && cd mu
npm ci && npm run generate:models   # the model catalog is generated, not committed
./kyrn/bin/mu setup                 # then ./kyrn/bin/mu wherever `mu` appears below
```

Create an API key in [Token Factory](https://tokenfactory.nebius.com), run `mu setup` and paste it: mu recognises a Token Factory key, checks it, starts you on Nemotron 3 Super and offers Nemotron 3 Ultra as the judge. In a script, the key comes from stdin:

```bash
mu setup --service nebius --key-stdin --judge nemotron
```

This keeps the key in `~/.mu/agent/auth.json`, makes Super the default model and writes the judge to `~/.mu/agent/mu.json`:

```json
{ "tiers": ["nemotron"] }
```

Then run `mu`. Without setup, the environment works too (or put the key in `~/.mu/.env`):

```bash
export NEBIUS_API_KEY=...
MU_JUDGE=nemotron mu --provider nebius --model nvidia/nemotron-3-super-120b-a12b
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

On four decision points Nemotron 3 Ultra decides clearly better with thinking on: reading a new message (`input.preflight`), approving a command (`tool.approval`), keeping a memory (`memory.capture`) and offering skills (`skills.disclosure`). `nemotron-think` is Ultra with `reasoning_effort: "high"`; route those four to it and keep the fast judge for the rest:

```json
{
  "tiers": ["nemotron"],
  "routes": {
    "input.preflight": ["nemotron-think"],
    "tool.approval": ["nemotron-think"],
    "memory.capture": ["nemotron-think"],
    "skills.disclosure": ["nemotron-think"]
  }
}
```

On held-out test requests this raised Ultra's score from 54.7 to 57.9 on real requests and from 48.4 to 55.9 on constructed ones, and both gains hold at 95% confidence (paired bootstrap: +0.9 to +6.5 and +3.1 to +12.8). The four were chosen on the development split, where thinking made two other decision points worse (`board.read`, `capability.disclosure`): thinking everywhere is not better. The price: those decisions cost about twice as much (about a fifth more for the judge as a whole) and take about 2.5 s instead of 0.9 s at the median, so a command waits a little longer for its approval.

## The judge on your machine

[mu-judge-nemotron](https://github.com/qybaihe/mu-judge-nemotron) fine-tunes Nemotron 3 Nano 4B as mu's judge and serves it over System One, the protocol mu's judges speak. Its weights are on Hugging Face as [qybaihe/mu-judge-nemotron-nano-4b](https://huggingface.co/qybaihe/mu-judge-nemotron-nano-4b). On a machine with an NVIDIA GPU, in a clone of mu-judge-nemotron:

```bash
uv pip install -e '.[train]'
python serve/systemone_server.py --model qybaihe/mu-judge-nemotron-nano-4b --port 8770
```

Then use the built-in `nemotron-local` judge:

```json
{ "tiers": ["nemotron-local"] }
```

Where it is unsure, mu does what it does without a judge. You can put Ultra behind it, `"tiers": ["nemotron-local", "nemotron"]`: then a yes/no answer between 0.2 and 0.8, or a choice below 0.6, goes on to Ultra. That helped on the hardest development requests but did worse on real requests in the held-out test (below), so the local judge on its own is the recommended setup.

## Run commands in a Token Factory sandbox

With the sandbox on, `bash`, `read`, `write` and `edit` run in a Token Factory sandbox instead of on your machine. The project is copied in when the session starts, and every command continues from the files the previous one left. Nothing changes on your machine until you run `/sandbox pull`, see the diff and agree.

This is new. Sandboxes must be enabled for your Token Factory project, and so far mu's sandbox client is tested only against a stand-in for the Sandboxes API that follows its documentation, not yet against the live service.

```bash
export NEBIUS_PROJECT_ID=...   # Token Factory → Project settings
MU_SANDBOX=nebius mu --provider nebius --model nvidia/nemotron-3-super-120b-a12b
```

`/sandbox status` shows the sandbox and the image it has reached; the options (base image, time limits) are under `features.sandbox` in [the feature reference](reference/features.md#sandbox).

## Web search with Tavily

With `TAVILY_API_KEY` set, `web_search` asks [Tavily](https://tavily.com) first and `web_fetch` falls back to Tavily's extract for pages it cannot read itself. See [Configuration](configuration.md). Like the sandbox, this is new and tested so far with mocked responses rather than live calls.

## Measured

Every Nemotron model on Token Factory was put in the judge's seat on 1,353 held-out judge requests from mu's own sessions (decision points across permissions, context, memory, turn control and multi-agent work), scored by what mu then did, relative to having no judge (0 = no better than mu's fallbacks, 100 = every decision right):

| Judge (thinking off) | Real requests | Constructed cases | Answer format errors |
| --- | --- | --- | --- |
| Nemotron 3 Ultra | **47.3** | **47.7** | 0.2% |
| Nemotron 3 Super | 2.7 | −12.7 | 4% |
| Nemotron 3.5 Lightning, read off first-token logprobs | 15.4 | −12.5 | none (one token) |
| Nemotron 3.5 Lightning, JSON | — | — | 55% of 40 tried |

On 4,838 further held-out requests, scored once, Nemotron 3 Ultra scored 54.7 on real requests (95% interval 44.6–64.0) and 48.4 on constructed ones: its answers are mostly right (92.7% of checks on constructed cases), but its mistakes cost more than those of judges trained for mu. Thinking on four decision points raised those test scores to 57.9 and 55.9 ([Thinking where it pays](#thinking-where-it-pays)).

The fine-tuned 4B judge scored above Ultra:

| Judge | Dev, real | Dev, constructed | Test, real (95% interval) | Test, constructed (95% interval) |
| --- | --- | --- | --- | --- |
| Nemotron 3 Nano 4B, fine-tuned (`nemotron-local`) | **62.3** | 45.0 | **68.2** (61.0–76.0) | **59.9** (51.5–68.3) |
| Nemotron 3 Ultra (`nemotron`) | 47.3 | 47.7 | 54.7 (44.6–64.0) | 48.4 (35.8–59.8) |
| The 4B judge, then Ultra for what it is unsure of | 63.1 | 44.1 | 20.0 (−74.6–69.7) | 55.7 (44.8–66.4) |

On test the 4B judge is ahead of Ultra by 13.6 on real requests (paired interval +8.1 to +20.7) and by 11.5 on constructed ones (+1.5 to +22.6). On 112 author-written development requests, hard by design, it is clearly weaker (19.6 against Ultra's 52.3). With Ultra behind it, a few of Ultra's confident answers in costly places (letting a tool's output into the context, keeping a memory) cost more on real test requests than the 4B judge's doubt. Details: [mu-judge-nemotron](https://github.com/qybaihe/mu-judge-nemotron#results).
