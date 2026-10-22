---
title: Lessons
summary: What mu learns from your corrections and from getting itself unstuck, how lessons are merged and recalled, and how unused ones retire.
---

The lessons library is what mu remembers between sessions: your corrections, the rules you set, and the traps the agent fell into and how it got out. The command line and the desktop app share it. The judge decides what is worth keeping, whether it is new, when it applies and whether it was followed; a small writing model puts it into words.

## Where lessons come from {#sources}

| Source | When | What the judge decides |
| --- | --- | --- |
| **Your corrections and rules** | You say *no, use pnpm* or *never commit to main* | Is this a correction, or a rule for later? (`memory.capture`) |
| **The agent getting unstuck** | It went in circles or hit a dead end, and the turn still ended with a passing check or the goal met | Was what finally worked a different approach? If so, keep the trap and the way around it. (`memory.outcome`, at most once a turn, only after real trouble) |
| **The model** | It keeps something with the `remember` tool | Useful again later, a one-off or known already from the prompt or the project files? Only the first is kept. (`memory.worth`) |
| **Subagents** | A line starting with `Lesson:` in a subagent's report | The same question (`memory.worth`) |
| **You, directly** | `/remember <text>` | Nothing: kept as written |

## Merging {#merging}

Before a new lesson is stored, the six most similar kept lessons are compared with it in one request (`memory.merge`): the **same** lesson isn't stored twice; a **more precise** one replaces the old; on a **contradiction**, the old one is retired, because your latest word wins. Only something you said can retire a lesson you taught; the model can't overrule you.

## Recall {#recall}

When a message arrives, at the same time as the preflight, the judge is asked of each candidate lesson whether it applies (`memory.recall`). Up to 24 candidates are judged, the most often followed first; at most five come into the turn, one line each. Subagents get the lessons that apply to their task in their brief.

## Followed or not {#applied}

At the end of a turn, the judge reads what happened and asks of each recalled lesson whether it was followed (`memory.applied`). A lesson recalled eight times and never followed retires itself, and mu says so.

## Commands {#commands}

| Command | What it does |
| --- | --- |
| `/remember <text>` | Keep a lesson as written |
| `/lessons` | The lessons for this project: id, kind, how often recalled and followed, the lesson |
| `/lessons all` | Including those that apply everywhere and the retired ones |
| `/forget <id>` | Retire one |

In the desktop app, the **Lessons** tab shows the same list; you can edit a lesson or retire it there.

The library is one file, `~/.mu/agent/mu/lessons.jsonl`. Each lesson has a kind (correction, preference, pitfall, workaround or fact), when it applies, what to do and whether it holds for this project only or everywhere.
