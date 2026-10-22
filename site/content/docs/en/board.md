---
title: The plain-language board
summary: A board that tells you in plain words how far the work is, written by a model chosen for speaking plainly.
---

Models keep getting better at the work and harder to follow: their progress reports read like notes for another machine. mu doesn't ask the working model to report. With the board on, a second model, chosen only because it speaks plainly, tells you what is going on, and the judge decides what is worth telling.

## What the board shows {#shows}

- **Where things stand.** What the agent is doing now, how many of the acceptance items are done and what waits for you.
- **A running account.** A line for every step as it happens: which file changed, whether a check passed, which command ran. A string of file reads folds into one line, *read 5 files*.
- **News, retold.** Whenever the agent says something or finds something, `board.read` asks the judge whether it is news or routine. Only news is retold on the spot by the plain-speaking model.
- **A closing summary.** When a run ends, its news is picked once more for a summary, the last line of the account, with the steps kept above it. So you see not only *done*, but what was done.

At the top, two numbers: how full the context is and the cache hit rate, the direct result of the context and cache decisions.

The board is for you only; it never enters the model's context. The working model keeps working in its own language.

## Switching it on {#on}

The board is switched per project: `/board on` and `/board off` in a session, or the switch on the app's board tab. The first time, you pick the model that writes it; Claude Opus 4.6 is recommended, then Gemini 3.8 Flash. `/board model` changes it.

It is off for new projects unless you set `features.board.defaultOn`, because every update costs a model call.

## How often it looks {#timing}

The judge looks whenever the agent says something, after a check or a ticked acceptance item, every five tool calls and whenever the agent stops, but not more often than every 20 seconds while it works. The board follows the permission mode, a running goal and subagents, so it says *waiting for your permission* or *two subagents are working* when that is the case.

| Option | Default | Meaning |
| --- | --- | --- |
| `features.board.language` | `auto` | The language you write in, or `zh` / `en` |
| `features.board.everyTools` | `5` | Tool calls between two looks |
| `features.board.minIntervalMs` | `20000` | Shortest gap between two looks while it works |
| `features.board.model` | empty | The writing model, as `provider/model`; set here, nobody is asked |
