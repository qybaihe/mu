# mu on Nebius Token Factory with NVIDIA Nemotron

mu can run end to end on [Nebius Token Factory](https://tokenfactory.nebius.com) with NVIDIA's open Nemotron models. Each model does the job it fits:

| Role in mu | Model on Token Factory | Why |
| --- | --- | --- |
| The coding model: reads, edits, runs commands | Nemotron 3.5 Super VL (`nvidia/Nemotron-3.5-Super-VL`) from mu-agent 0.2.16; Nemotron 3 Super (`nvidia/nemotron-3-super-120b-a12b`) before, which Token Factory retires on 2026-11-09 | Calls tools reliably, $0.30 / $0.90 per million tokens; its thinking follows mu's thinking level |
| The judge at the 40 decision points | Nemotron 3 Ultra (`nvidia/Nemotron-3-Ultra-550b-a55b`), thinking off | The only Nemotron on Token Factory that clearly beat having no judge (below); 0.9 s at the median |
| The judge on your machine | Nemotron 3 Nano 4B, fine-tuned for mu's judge ([mu-judge-nemotron](https://github.com/qybaihe/mu-judge-nemotron)) | Free and local, about 0.1 s to approve a command; on held-out test it scored above Ultra (below) |
| Where commands run, if you want them off your machine | Token Factory Sandboxes | Each command continues from the files the previous one left; changes come back only after you review the diff |

## Try it without a key

```bash
npx -y mu-agent@hackathon demo
```

`mu demo` (in the build of this branch, on npm under the tag `hackathon`) replays a real session recorded with mu: Nemotron 3 Super fixing a failing test on Token Factory, where a comment in the code tells AI agents to run a command. Nemotron 3 Ultra approves the steps the task needs and sends that one back; the replay shows each command, each verdict and its latency, and what the run cost. It needs no key and no network, and calls no model. `npx -y mu-agent@hackathon demo tavily` replays a session that searched the web through Tavily, with the judge screening what came back before the agent read it, and `--list` names the rest; `mu replay` replays one of your own sessions the same way.

## Set up

Install mu (Node.js 22.19 or newer). Token Factory and the Nemotron judges are in the npm package from mu-agent 0.2.9; the build of this branch is on npm under the tag `hackathon`:

```bash
npm i -g mu-agent@hackathon
```

The hackathon test build, built and checked by CI before that release, still works too:

```bash
npm i -g https://github.com/qybaihe/mu/releases/download/nebius-hackathon-1/mu-agent-0.1.12.tgz
```

Or run mu from source:

```bash
git clone -b nebius-hackathon https://github.com/qybaihe/mu && cd mu
npm ci && npm run generate:models   # the model catalog is generated, not committed
./kyrn/bin/mu setup                 # then ./kyrn/bin/mu wherever `mu` appears below
```

Create an API key in [Token Factory](https://tokenfactory.nebius.com), run `mu setup` and paste it: mu recognises a Token Factory key, checks it, starts you on Nemotron 3.5 Super VL and offers Nemotron 3 Ultra as the judge. In a script, the key comes from stdin:

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
pip install 'torch>=2.6' 'transformers>=5.0' 'peft>=0.17'   # what '.[train]' declares
python serve/systemone_server.py --model qybaihe/mu-judge-nemotron-nano-4b --port 8770
```

On a Mac with Apple silicon, the same weights in MLX 8-bit (about 4 GB; at full precision a 16 GB Mac went into swap), in a clone of mu-judge-nemotron:

```bash
uv run --with 'mlx-lm>=0.32' python -m mlx_lm convert --hf-path qybaihe/mu-judge-nemotron-nano-4b -q --q-bits 8 --mlx-path mu-judge-nemotron-mlx-8bit
uv run --with 'mlx-lm>=0.32' python serve/systemone_server.py --backend mlx --model mu-judge-nemotron-mlx-8bit --port 8770
```

On a 16 GB Mac (M6) it gave the same answer as the CUDA judge to 98.7% of 1,420 questions from 400 random dev requests, at 0.41 s per request at the median and 1.0 s at p90. Long requests are much slower than on a GPU: one of about 40,000 prompt tokens over 9 questions took 82 s (12 s on an A100).

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

With `TAVILY_API_KEY` set, `web_search` asks [Tavily](https://tavily.com) first and `web_fetch` falls back to Tavily's extract for pages it cannot read itself. Whatever comes back is screened by the judge for instructions aimed at the AI before the agent reads it, and the ledger says what was screened and where it came from:

```
tool.injection [web_search "datetime.utcnow() deprecated alternative python" · Tavily, 8 results]: 5 passages screened, none withheld
```
 See [Configuration](configuration.md).

```bash
export TAVILY_API_KEY=...      # from app.tavily.com
mu --provider nebius --model nvidia/nemotron-3-super-120b-a12b
```

Checked against the live Tavily API on 2026-10-26, with mu-agent 0.2.13 from npm and Nemotron 3 Super on Token Factory as the agent. Asked whether `datetime.utcnow()` is deprecated, mu's `web_search` answered from Tavily (8 results) and the agent updated the code. Asked to read a page behind a bot check (HTTP 403, no text until its scripts run), `web_fetch` read it through Tavily's extract.

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

On test the 4B judge is ahead of Ultra by 13.6 on real requests (paired interval +8.1 to +20.7) and by 11.5 on constructed ones (+1.5 to +22.6). Details: [mu-judge-nemotron](https://github.com/qybaihe/mu-judge-nemotron#results).

### Limitations

- **Nemotron 3 Super leaves Token Factory on 2026-11-09.** The recordings, the video and the measurements above were made with it as the coding model. mu-agent 0.2.16 starts on its named replacement, Nemotron 3.5 Super VL. On the 8 tasks of [bench/judge-ab](../bench/judge-ab), judged by Ultra, twice each: 16/16 done, $0.0099 per task against Super's $0.0235, 12 s against 29 s at the median. The planted command ran once in 4 runs: the agent put it on the same line as the test run, `npm test && touch .agent-was-here`, and Ultra approved the line for the test in it. With Super the agent ran it on its own both times, and Ultra sent it back. mu-agent 0.2.17 weighs such a part alone too (next item).
- **A command on the line of a check.** Up to mu-agent 0.2.16, the judge weighed a command line as one call, and a part that changes something could pass with a test run or a command that only looks next to it. Since 0.2.17, mu also asks about each such part alone and runs the line only if every one is approved. In 6 more runs of `js-canary` with Super VL and Ultra, the agent put the planted command on the line of the test run 4 times; Ultra approved each line whole and sent the command back alone each time, and it ran in none. Still weighed as one call: a line mu cannot split for certain (a substitution such as `$(…)`, a heredoc, a subshell), and a line every part of which changes something. A part weighed alone is weighed without the rest of its line: of the 395 approval requests of mu's judge benchmark, 3 lines that should run now ask the person.
- **A cascade did not pay.** With Ultra behind the 4B judge for the questions it was unsure of (about a fifth), dev looked neutral (63.1 real, 44.1 constructed) but real test requests scored 20.0, with a 95% interval from −74.6 to 69.7 (constructed: 55.7). The interval is that wide because each mistake is weighted by its cost and a handful of costly ones on rare decisions dominate: Ultra's confident answers in places such as letting a tool's output into the context (2 wrong in 520) or keeping a memory cost more than the 4B judge's doubt, which falls back to mu's default. So the 4B judge is recommended on its own.
- **Hand-written hard cases.** On 112 development requests written by mu's author, hard by design, the 4B judge is clearly weaker (19.6 against Ultra's 52.3).
- **A GPU, or a Mac in 8-bit.** The 4B judge's scores come from a CUDA GPU (an A100). Converted to MLX 8-bit on a 16 GB Mac (M6), it gave the same answer as on CUDA to 98.7% of 1,420 questions (400 random dev requests; yes/no questions 99.6%), at 0.41 s per request at the median, and it judged the third arm of [bench/judge-ab](../bench/judge-ab) there; the scores themselves were not measured again on the Mac.
