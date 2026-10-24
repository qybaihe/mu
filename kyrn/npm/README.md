# mu

**A coding agent with a judgment kernel.** It hands its routine decisions to a small, fast judge model, so the main model can keep its attention on the work.

> Source, docs and the desktop app: [github.com/qybaihe/mu](https://github.com/qybaihe/mu).

## Install

```bash
npm i -g mu-agent
mu
```

You need Node.js 22.19 or newer. The package is `mu-agent`; the command is `mu`. It runs on macOS, Linux, Windows and WSL.

`mu setup` connects a model from your shell. Paste an API key and mu detects the service from the key's format (OpenAI, Anthropic, Google Gemini, xAI, OpenRouter, OpenCode Zen, DeepSeek, Qwen, Kimi, GLM, SiliconFlow, StepFun), or pick Ollama or your own endpoint. It checks the key with one request, picks a starting model and sets up the judge. To use a ChatGPT, Grok or Google subscription instead, choose it there and mu starts on `/login`.

Inside mu, `/login` signs in to a provider or a subscription and `/model` switches models. `/help` lists everything. `mu doctor` checks your setup from the shell.

## What it adds to pi

mu is built on [pi](https://github.com/earendil-works/pi). It hands the small questions a coding agent keeps asking to a **judge**: is this message a new task or a correction, does this command need your permission, which part of a long test log matters, which subagent fits a job, what should the browser click next. Code acts on the answers, and the main model only sees what it needs.

- **Every decision is visible.** Each decision point is `off`, `shadow` (asked and logged, but not acted on) or `active`. `/ledger` and `mu ledger` show the verdicts.
- **Every decision has a fallback.** When the judge is unsure, slow or unreachable, a plain rule decides, or pi's default behavior runs. For approvals, the fallback is to ask you.
- **And more:** a task frame that keeps your constraints in your own words, three permission modes (`/permissions`), goal mode (`/goal`), a plain-language progress board (`/board`), checkpoints and `/rewind`, subagents that edit in their own git worktrees (`delegate`), read-only hives of investigators (`hive`), a judge-driven browser (`browse`), and it picks up the rules, skills and MCP servers you already set up in Claude Code, Cursor and Codex.

## Choose a judge

Out of the box, the judge is Jev 1.13, TypeSafe's hosted judge model, free on OpenCode Zen for a limited time and with no key needed. What it judges goes to OpenCode, which doesn't train on it, and mu reminds you of that once a day. To send nothing anywhere, run `mu setup --judge off` (or choose "Not now" when `mu setup` asks): no decision point asks a judge, and mu's features keep working on their rules. Or use the local judge, Laya.

- **Jev** (hosted): set `TYPESAFE_API_KEY` (TypeSafe), `MU_JUDGE_OPENROUTER_API_KEY` (Jev on OpenRouter), `AI_GATEWAY_API_KEY` (Vercel AI Gateway), `OPENCODE_API_KEY` (OpenCode Zen) or `CLOUDFLARE_API_KEY` with `CLOUDFLARE_ACCOUNT_ID` (Cloudflare Workers AI) in your environment, or add it to `~/.mu/.env` as `KEY=value`. `mu setup` asks for a key and writes it there. mu reads that file as data, never prints it and starts using the key automatically.
- **OpenAI's decision model**, `gpt-6-luna`, through OpenAI's Decisions API: `mu setup --judge openai`, or `/mu judge openai`. It uses `MU_JUDGE_OPENAI_KEY` (in your environment or `~/.mu/.env`), else the OpenAI API key mu already has for its `openai` provider. With a `baseUrl` (an Azure resource, a relay), only its own key is sent there.
- **Another classifier** from pi's catalog: `/mu judge classifier:<provider>/<model>`, for example Cloudflare's Clef (`clef`, `clef-flash`) or a System One model on OpenRouter, with that provider's key.
- **CLM** (self-hosted; its encoder needs a GPU): start `clm-serve` from [Contrastive-LM/CLM](https://github.com/Contrastive-LM/CLM), then run `/mu judge clm`. For a server on another machine, add `"judges": { "clm": { "type": "clm", "baseUrl": "http://<host>:8700" } }` to `~/.mu/agent/mu.json`. If the server was started with `CLM_API_KEY`, set the same value in `MU_JUDGE_CLM_API_KEY`. `mu doctor` checks the server.
- **mude 1.0** (local, a Mac with Apple silicon, macOS 14+), mu's own decision model, optimized for coding: `mu judge mude install` downloads it (1.8 GB), sets it up in `~/.mu/local-judge/mude`, starts its server on 127.0.0.1 and puts it first. What it can't answer goes to the judges you had before, which are hosted; `mu judge mude enable --local-only` keeps everything on your Mac. Its server uses about 4 GB of memory until `mu judge mude stop`.
- **Laya** (local, macOS on Apple silicon): `mu judge setup` installs it into `~/.mu/local-judge`. It downloads about 930 MB, and only when you run that command.
- **Any model you already use:** `/mu judge llm:<provider>/<model>`.

34 of the 40 decision points act on their verdicts from the start (`active`). To only record what the judge would do, run `/mu mode default shadow`, or put `"modes": { "default": "shadow" }` in `~/.mu/agent/mu.json`.

## Commands

```text
mu                       start a session in the current directory
mu "prompt"              start a session with this prompt
mu -p "prompt"           run one prompt, print the answer and exit
mu -c | -r               continue the last session | pick a session to resume
mu setup                 connect a model and choose a judge (see mu setup --help for scripting and services)
mu judge mude <cmd>      mude 1.0 on this Mac: install | enable | disable | start | stop | status | uninstall
mu judge <cmd>           manage the local judge, Laya (macOS on Apple silicon): setup | start | stop | status | run
mu ledger [n] [--json]   print the judge's verdicts from the last n sessions
mu import <file>...      import Claude Code, Codex and ZCode conversations; --list shows them (mu import --help)
mu doctor                check the installation, the judges and the connections
mu auth <cmd>            sign-in helper for the desktop app: status | login | logout
mu link | unlink         put the mu command on your PATH | remove it
mu help | version        show this help | print the version
```

Everything else goes to pi unchanged: `mu --help` also shows pi's options. mu keeps its files in `~/.mu`, separate from a regular pi install in `~/.pi`.

## Update and remove

```bash
npm i -g mu-agent@latest
npm rm -g mu-agent
```

Removing the package keeps `~/.mu` (your sessions, settings and sign-ins).

## License

MIT. pi is by Mario Zechner and contributors. Third-party code in the judgment kernel is listed in `judge/THIRD_PARTY_NOTICES.md`.
