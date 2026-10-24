---
title: Privacy
summary: What stays on your machine, what the judge sees and how to keep everything local.
---

## On your machine {#local}

- **Keys stay local.** API keys and sign-ins are kept in `~/.mu`, and each judge key is sent only to the service it belongs to. A key never goes in `mu.json`; custom judges name the environment variable that holds it.
- **No silent downloads.** mu never downloads a model or runtime by itself. The local judge, the desktop app's updates and anything else that needs downloading ask you first.
- **Snapshots skip secrets.** Checkpoints never include `.env` files, private keys or certificates, and live in a folder only you can read.
- **Your other tools are read, not changed.** Rules, skills and MCP servers from Claude Code, Cursor and Codex are only read, never changed.

## What the judge sees {#judge}

A judge only sees the fields one question needs: a message, a chunk of output, a command, a short summary of the run. Credentials are masked before anything reaches the judge or the board.

With no judge key, these fields go to the free Jev on OpenCode Zen (Jev is TypeSafe's hosted judge model, the default). OpenCode doesn't train on them, and mu says so once a day. With your own key, they go to the service you chose. To keep everything on your machine, use [mude 1.0](@docs/judges#mude) on its own on a Mac (`mu judge mude enable --local-only`), turn the judge off (`mu setup --judge off`, or "Not now" when `mu setup` asks; mu's features fall back to their own rules), or turn the whole kernel off (`MU_JUDGE=off`).

## The ledger {#ledger}

Every verdict is recorded on your machine, in the session file: the outcome, the answers and their probabilities, how long it took, and whether it came from the judge or a fallback. You can read all of it with `mu ledger` or in the app's Judge tab. The judged state itself is kept only if you set `"recordState": true`.

## The plain-language board {#board}

The board is written by a model you pick. What it reads is the agent's own words and steps, sent to that model's provider like any other model call. The board never enters the working model's context.
