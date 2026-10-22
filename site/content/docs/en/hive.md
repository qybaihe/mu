---
title: Subagents and the hive
summary: Delegating to subagents with roles, isolated edits that come back as patches, and the hive, where the judge decides what passes between bees.
---

mu can hand work to other agents in two ways: **subagents** take separate tasks, and a **hive** puts several bees on one hard problem at once.

## Subagents {#sub-agents}

The model delegates with the `delegate` tool, or you ask with `/agents`. For each task the judge picks a role, a model tier and a thinking level by difficulty (`swarm.routing`). The built-in roles:

| Role | What it does |
| --- | --- |
| `worker` | Does the task, edits included (the default) |
| `scout` | Finds and reads code without changing anything |
| `planner` | Turns a goal into a concrete plan; doesn't edit |
| `reviewer` | Reviews code or a diff for bugs and security problems; read-only |
| `investigator` | Digs into one angle of a hard problem without changing anything |
| `browser` | Does things on websites with the built-in browser |

Your own roles go in `~/.mu/agent/agents/`. Up to three run at once. Subagents get the lessons that apply to their task, work under your hard constraints and inherit the conversation's permission mode. `features.swarm.models` lists the models they may be routed to, cheapest first; with none, every subagent uses the session's model.

## Isolated edits {#isolation}

A subagent that edits files works in a git worktree of its own, outside your repository, starting from the files as the main agent sees them, uncommitted changes included. When it finishes, its changes come back as a patch, with the files and line counts. The judge checks from the task, the paths and the line counts whether the patch stays within the task (`swarm.patch`) and adds one line of advice; it never blocks.

The main agent then decides: `apply_patch_from` applies all of it or nothing, without committing or staging, and without touching your index. Outside a git repository, or in the middle of a rebase or merge, subagents edit in place and say why.

## The hive {#hive}

Every multi-agent system answers the same question: should one agent tell another what it knows? Tell nothing, and they walk into the same dead end; tell everything, and each context fills with the others' chatter. In a hive, the judge is the gate.

A hive is two to six bees, each with its own angle. Bees read code, run commands and use the browser; they never change code, which stays the main model's job. `/hive <question>` starts one; the agent also starts one when a problem resists a direct attempt.

- **Publishing** (`hive.publish`). Whenever a bee has said its piece, the judge asks: is there a finding, a dead end, a decision or a blocker worth sharing? If so, it goes on an append-only shared board.
- **Delivery** (`hive.deliver`). For every new note, the judge asks of each other bee: does this matter to its angle? Only then is it delivered, marked as *a finding, not an instruction*.
- **Corrections** (`hive.relate`). A later finding can overturn an earlier one: a bee reports the tests can't run, another later clears an environment variable and they run. The judge reads how two notes relate: *replaces*, *contradicts* or *supports*. A replaced finding becomes a correction sent to every bee that heard the old one. A contradiction keeps both as a dispute; if no one settles it within a minute, a verifier bee is sent to check.

One real run: three bees, nine minutes, 117 candidate notes judged, 27 published, 16 delivered to the bee that needed them. Every verdict is in the run's ledger.

## Watching and stopping {#control}

`/swarm` shows what each one is doing; `/swarm stop` asks them for their reports now; `/swarm kill` ends them at once. A bee whose time is up is asked for its report and ended if it gives none; a watchdog handles a stuck model or tool. A hive always comes back with a result.

In the desktop app, the **Hive** tab shows each bee, its role and model and what it is saying, and a map of who sent what to whom: thicker lines for more deliveries, their own style for corrections and disputes, and a flash along the line the moment a finding arrives. The hive card in the conversation carries a small copy of the map.
