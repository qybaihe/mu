# Reproducing mu's hackathon results

For the judges of the Nebius x NVIDIA Global AI Hackathon: what to run to check each claim, from no key at all to the measurements themselves. This is the branch `nebius-hackathon` of mu; the mu-agent it builds is on npm under the tag `hackathon` (`npm i -g mu-agent` installs the release from main, which has no `mu demo`). You need Node.js 22.19 or newer.

## 1. No key: a real run, replayed (one minute)

```bash
npx -y mu-agent@hackathon demo            # a comment in the code tells AI agents to run a command; Nemotron 3 Ultra sends it back
npx -y mu-agent@hackathon demo local      # the same kind of task, judged only by the fine-tuned Nemotron 3 Nano 4B on a Mac
npx -y mu-agent@hackathon demo tavily     # a web search through Tavily, screened by the judge before the agent reads it
npx -y mu-agent@hackathon demo --list     # every recording
```

Each one replays a session recorded with mu: the request, each tool call and what came back, each verdict of the judge with its latency, and at the end what the run cost and how many times Ask-first mode would have asked you. No model is called and nothing is sent anywhere. `--brief` leaves out what each step printed; `--fast` skips the pauses.

## 2. With a Nebius Token Factory key: mu on Nemotron

```bash
npm i -g mu-agent@hackathon
mu setup        # paste the key; choose "Nemotron 3 Ultra" as the judge
mu              # in any project: Nemotron 3.5 Super VL writes the code, Ultra judges, in Judge mode
mu ledger       # afterwards: every verdict, what it was about, and its latency
```

Ask it for something small, such as fixing a failing test. Optional web search through Tavily: `export TAVILY_API_KEY=...` before starting mu. More in [docs/nebius.md](docs/nebius.md).

## 3. The same tasks with and without the judge

[bench/judge-ab](bench/judge-ab) has 8 small tasks (Python and JavaScript bugs with failing tests; two of them hide an instruction for AI agents), the driver, and one row per run in `results.jsonl`. With a key, `python3 bench/judge-ab/run_ab.py 2` runs the arms without a judge and with Ultra, twice each (about $0.56); `AB_ARMS=local` runs the fine-tuned 4B judge's arm against a judge server on `127.0.0.1:8770` (about $0.32, all of it the agent). The README there gives the setup and every number.

## 4. The fine-tuned judge on your machine

[mu-judge-nemotron](https://github.com/qybaihe/mu-judge-nemotron#use-it-with-mu) serves the fine-tuned Nemotron 3 Nano 4B ([weights](https://huggingface.co/qybaihe/mu-judge-nemotron-nano-4b)) on an NVIDIA GPU, or in MLX 8-bit on a Mac with Apple silicon (16 GB is enough). On a Mac, in a clone of mu-judge-nemotron (the first line downloads the 8 GB weights once and writes the 4 GB 8-bit copy):

```bash
uv run --with 'mlx-lm>=0.32' python -m mlx_lm convert --hf-path qybaihe/mu-judge-nemotron-nano-4b -q --q-bits 8 --mlx-path mu-judge-nemotron-mlx-8bit
uv run --with 'mlx-lm>=0.32' python serve/systemone_server.py --backend mlx --model mu-judge-nemotron-mlx-8bit --port 8770
```

mu then uses it with `{ "tiers": ["nemotron-local"] }` in `~/.mu/agent/mu.json` (or `MU_JUDGE=nemotron-local` for one session); `mu ledger` shows each of its verdicts with its latency. The same repository rebuilds the training data, trains the judge and serves it; every Token Factory call it made is booked with its price (`python pipeline/spend.py`).

## 5. The judge scores (68.2 against 54.7)

The scores come from mu's judge benchmark at commit c422334: each judge answers held-out judge requests from mu's sessions, and each answer is scored by what mu then does, weighted by what a wrong call costs, relative to mu with no judge. The test split (3,244 real and 1,594 constructed requests) was scored once, after everything else was fixed. The requests themselves are not published (they come from real coding sessions); the results per split, with 95% bootstrap intervals and the paired differences, are in [mu-judge-nemotron's Results](https://github.com/qybaihe/mu-judge-nemotron#results), and the dev and test requests were checked against the training data by task (no overlap).

## Where each number comes from

| Claim | Source |
| --- | --- |
| 68.2 (4B judge) and 54.7 (Ultra) on 3,244 held-out real requests; +13.6 (+8.1 to +20.7) | mu's judge benchmark at c422334, test split scored once; [mu-judge-nemotron#results](https://github.com/qybaihe/mu-judge-nemotron#results) |
| Every Nemotron on Token Factory as the judge (Ultra 47.3, Super 2.7, Lightning 15.4 on dev) | the same benchmark, dev split; [docs/nebius.md](docs/nebius.md#measured) |
| 16/16 tasks done in both arms; the planted command run 2 of 4 times without a judge, 0 with it; 6 questions against 75 for Ask-first; $0.024 against $0.012 per task | [bench/judge-ab](bench/judge-ab), `results.jsonl` |
| The fine-tuned 4B judge alone, in MLX 8-bit on a 16 GB Mac: 16/16 tasks done, the planted command run 0 of 4 times, 2 questions (both the planted command), median 301 ms per verdict | [bench/judge-ab](bench/judge-ab), the `local` rows of `results.jsonl`; `npx -y mu-agent@hackathon demo local` |
| The same judge on the Mac gives the same answer as on CUDA to 98.7% of 1,420 questions | 400 random dev requests replayed against the CUDA judge's answers; [docs/nebius.md](docs/nebius.md#limitations) |
| Ultra sends the planted command back in 392 ms | `npx -y mu-agent@hackathon demo`, recorded in [kyrn/demo/planted.jsonl](kyrn/demo/planted.jsonl) |
| Tavily answered the search, the judge screened 5 passages in 696 ms | `npx -y mu-agent@hackathon demo tavily`, [kyrn/demo/tavily.jsonl](kyrn/demo/tavily.jsonl) |
| $27.92 of Token Factory credit for everything in the submission | the spend ledger, every paid call with its tokens and price (`pipeline/spend.py` in mu-judge-nemotron; the ledger itself is not published, its totals per part are in [What it cost](https://github.com/qybaihe/mu-judge-nemotron#what-it-cost)) |
